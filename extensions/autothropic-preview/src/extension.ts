import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ClipEditor } from './clipPicker';
import { ImageEditor } from './imageEditor';

let previewUrl: string | null = null;
let previewUrlManual = false;
let urlDebounceTimer: ReturnType<typeof setTimeout> | undefined;

// Build terminal management
let _buildTerminal: vscode.Terminal | undefined;
let _buildTerminalReady = false;

export function activate(context: vscode.ExtensionContext) {
  const clipEditor = new ClipEditor(context.extensionUri);
  const imageEditor = new ImageEditor(context.extensionUri);

  // Wire clip editor send → agent
  clipEditor.onSend(async ({ filePaths, agentId }) => {
    await sendFilesToAgent(filePaths, agentId);
  });

  // Wire image editor send → agent
  imageEditor.onSend(async ({ filePaths, agentId }) => {
    await sendFilesToAgent(filePaths, agentId);
  });

  // Open preview command — delegates to core EditorPane
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.open', async () => {
      await vscode.commands.executeCommand('_autothropic.preview.open');
    })
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.refresh', () => {
      vscode.commands.executeCommand('_autothropic.preview.reload');
    })
  );

  // Screenshot command — uses core webview capturePage
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.screenshot', async () => {
      await takeScreenshot(imageEditor);
    })
  );

  // Screenshot with pre-captured data URL (from core PreviewEditor full-res capture)
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.screenshot.withData', async (dataUrl: string) => {
      await takeScreenshotFromData(dataUrl, imageEditor);
    })
  );

  // Open clip editor command
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.openClipEditor', async () => {
      await clipEditor.show(3);
    })
  );

  // Terminal URL auto-detection — only from Build terminal, not agent terminals
  context.subscriptions.push(
    vscode.window.onDidWriteTerminalData((e) => {
      if (previewUrlManual) { return; }
      // Only pick up URLs from the Build terminal to avoid agents hijacking the preview
      if (!_buildTerminal || e.terminal !== _buildTerminal) { return; }
      const clean = e.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      const match = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/);
      if (match && match[0] !== previewUrl) {
        const url = match[0];
        if (urlDebounceTimer) { clearTimeout(urlDebounceTimer); }
        urlDebounceTimer = setTimeout(() => {
          previewUrl = url;
          // Send to core preview EditorPane (real Chromium webview)
          vscode.commands.executeCommand('_autothropic.preview.setUrl', url);
        }, 200);
      }
    })
  );

  // Auto-open core preview EditorPane (not the old webview panel)
  vscode.commands.executeCommand('_autothropic.preview.open').then(
    () => {},
    (err) => console.error('[autothropic-preview] Failed to open core preview:', err),
  );

  // Restart build command — kills existing build terminal and re-runs
  context.subscriptions.push(
    vscode.commands.registerCommand('autothropic.preview.restartBuild', async () => {
      _buildTerminalReady = false;
      if (_buildTerminal) {
        _buildTerminal.dispose();
        _buildTerminal = undefined;
      }
      // Kill any lingering build terminals
      for (const t of vscode.window.terminals) {
        if (t.name === BUILD_TERMINAL_NAME) { t.dispose(); }
      }
      // Small delay for cleanup, then restart
      await new Promise(r => setTimeout(r, 300));
      await ensureSingleBuildTerminal();
    })
  );

  // Build terminal auto-start
  setTimeout(() => ensureSingleBuildTerminal(), 1500);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ensureSingleBuildTerminal();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((t) => {
      if (t.name === BUILD_TERMINAL_NAME && t !== _buildTerminal) {
        t.dispose();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === _buildTerminal) {
        _buildTerminal = undefined;
        _buildTerminalReady = false;
      }
    })
  );

  // Cleanup
  context.subscriptions.push({
    dispose() {
      if (urlDebounceTimer) { clearTimeout(urlDebounceTimer); }
      clipEditor.dispose();
      imageEditor.dispose();
    },
  });
}

// --- Screenshot → Send to Agent ---

async function takeScreenshotFromData(dataUrl: string, imageEditor: ImageEditor): Promise<void> {
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const bytes = Buffer.from(base64, 'base64');
    const tmpDir = path.join(os.tmpdir(), 'autothropic-screenshots');
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir)); } catch { /* exists */ }
    const filePath = path.join(tmpDir, `preview-${Date.now()}.png`);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), bytes);
    await imageEditor.show(filePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Screenshot failed: ${err}`);
  }
}

async function takeScreenshot(imageEditor: ImageEditor): Promise<void> {
  try {
    let dataUrl: string | undefined;

    // Try main-process guest capture first (full resolution, unaffected by CSS scale)
    if (previewUrl) {
      try {
        const fullRes = await vscode.commands.executeCommand<{ dataUrl: string } | null>(
          '_autothropic.capture.guestFullRes', previewUrl
        );
        if (fullRes?.dataUrl) { dataUrl = fullRes.dataUrl; }
      } catch { /* not available, fall through */ }
    }

    // Fallback: renderer-side capture
    if (!dataUrl) {
      const result = await vscode.commands.executeCommand<{ dataUrl: string } | null>(
        '_autothropic.capture.screenshot'
      );
      if (result?.dataUrl) { dataUrl = result.dataUrl; }
    }

    if (dataUrl) {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const bytes = Buffer.from(base64, 'base64');
      const tmpDir = path.join(os.tmpdir(), 'autothropic-screenshots');
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir)); } catch { /* exists */ }
      const filePath = path.join(tmpDir, `preview-${Date.now()}.png`);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), bytes);

      // Open in image editor for review/annotation
      await imageEditor.show(filePath);
    } else {
      vscode.window.showWarningMessage('Screenshot failed — preview not ready');
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Screenshot failed: ${err}`);
  }
}

// --- Send Files to Agent ---

async function sendFilesToAgent(filePaths: string[], agentId?: string): Promise<void> {
  if (filePaths.length === 0) { return; }

  // Build the file paths text — user will add context before submitting
  const message = filePaths.map(p => `"${p}"`).join(' ') + ' ';

  if (agentId) {
    try {
      await vscode.commands.executeCommand('_autothropic.agents.appendToInput', agentId, message);
      vscode.window.showInformationMessage(`Screenshot appended to agent input — add context and press Enter`);
      return;
    } catch { /* agent not available, fall through */ }
  }

  // Try to find first available agent
  try {
    const sessions = await vscode.commands.executeCommand<any[]>('_autothropic.agents.getSessions');
    if (sessions && sessions.length > 0) {
      const target = sessions.find((s: any) => s.status === 'waiting') ?? sessions[0];
      await vscode.commands.executeCommand('_autothropic.agents.appendToInput', target.id, message);
      vscode.window.showInformationMessage(`Screenshot appended to ${target.name} — add context and press Enter`);
      return;
    }
  } catch { /* agents extension not available */ }

  // Fallback: open in editor
  for (const fp of filePaths) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp));
  }
  vscode.window.showInformationMessage(`Saved ${filePaths.length} frame(s)`);
}

// --- Build Terminal ---

const BUILD_TERMINAL_NAME = '\u26A1 Build';

async function ensureSingleBuildTerminal(): Promise<void> {
  if (_buildTerminalReady) { return; }
  _buildTerminalReady = true;

  const stale = vscode.window.terminals.filter(t => t.name === BUILD_TERMINAL_NAME);
  for (const t of stale) { t.dispose(); }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    _buildTerminalReady = false;
    return;
  }

  const pkgUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'package.json');
  try {
    const pkgData = await vscode.workspace.fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(pkgData).toString('utf-8'));
    const scripts = pkg.scripts ?? {};

    let devScript: string | undefined;
    for (const name of ['dev', 'start', 'serve']) {
      if (scripts[name]) {
        devScript = name;
        break;
      }
    }

    if (!devScript) { return; }

    const pm = await detectPackageManager(workspaceFolders[0].uri);
    const terminal = vscode.window.createTerminal({
      name: BUILD_TERMINAL_NAME,
      cwd: workspaceFolders[0].uri,
      iconPath: new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.yellow')),
    });

    _buildTerminal = terminal;
    terminal.sendText(`${pm} run ${devScript}`);
  } catch {
    _buildTerminalReady = false;
  }
}

async function detectPackageManager(workspaceUri: vscode.Uri): Promise<string> {
  const lockFiles: Array<[string, string]> = [
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, pm] of lockFiles) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, file));
      return pm;
    } catch {
      // not found, continue
    }
  }
  return 'npm';
}

export function deactivate() {}
