import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ClipThumbnail {
  index: number;
  timestamp: number;
  preview: string;
  strip: string;
}

interface AgentInfo {
  id: string;
  name: string;
  color: string;
  status: string;
}

interface GrabResult {
  filePaths: string[];
  dataUrls?: string[];
}

/**
 * Full-featured clip editor with filmstrip, per-frame annotation, selection tray, agent send.
 * Supports multiple simultaneous instances.
 */
export class ClipEditor {
  private static _counter = 0;
  private panels = new Set<vscode.WebviewPanel>();

  private readonly _onSend = new vscode.EventEmitter<{ filePaths: string[]; agentId: string }>();
  readonly onSend = this._onSend.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  async show(seconds = 3): Promise<void> {
    // Fetch thumbnails, suggested indices, and agents
    let thumbnails: ClipThumbnail[] = [];
    let suggested: number[] = [];
    let agents: AgentInfo[] = [];

    try {
      thumbnails = await vscode.commands.executeCommand<ClipThumbnail[]>(
        '_autothropic.capture.getClipThumbnails', seconds
      ) ?? [];
    } catch { /* capture service not available */ }

    try {
      suggested = await vscode.commands.executeCommand<number[]>(
        '_autothropic.capture.getSuggestedIndices', seconds, 8
      ) ?? [];
    } catch { /* no suggestions */ }

    try {
      agents = await vscode.commands.executeCommand<AgentInfo[]>(
        '_autothropic.agents.getSessions'
      ) ?? [];
    } catch { /* agents extension not available */ }

    ClipEditor._counter++;
    const title = `Clip Editor ${ClipEditor._counter}`;

    const panel = vscode.window.createWebviewPanel(
      'autothropic.clipEditor',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'clip-icon.svg');
    this.panels.add(panel);

    panel.onDidDispose(() => {
      this.panels.delete(panel);
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'changeDuration':
          await this.loadThumbnails(panel, msg.seconds);
          break;
        case 'send':
          await this.handleSend(msg.indices, msg.annotations, msg.agentId);
          break;
        case 'export':
          await this.handleExport(msg.indices, msg.annotations);
          break;
      }
    });

    panel.webview.html = this.getHtml(thumbnails, suggested, agents, seconds);
  }

  private async loadThumbnails(panel: vscode.WebviewPanel, seconds: number): Promise<void> {
    let thumbnails: ClipThumbnail[] = [];
    let suggested: number[] = [];

    try {
      thumbnails = await vscode.commands.executeCommand<ClipThumbnail[]>(
        '_autothropic.capture.getClipThumbnails', seconds
      ) ?? [];
    } catch { /* */ }

    try {
      suggested = await vscode.commands.executeCommand<number[]>(
        '_autothropic.capture.getSuggestedIndices', seconds, 8
      ) ?? [];
    } catch { /* */ }

    panel.webview.postMessage({
      type: 'updateThumbnails',
      thumbnails,
      suggested,
    });
  }

  private async handleSend(indices: number[], annotations: Record<number, any[]>, agentId: string): Promise<void> {
    if (indices.length === 0) {
      vscode.window.showWarningMessage('No frames selected');
      return;
    }

    try {
      const result = await vscode.commands.executeCommand<GrabResult>(
        '_autothropic.capture.grabSelected', indices
      );
      const filePaths = await this.resolveGrabResult(result, annotations, indices);
      if (filePaths.length > 0) {
        this._onSend.fire({ filePaths, agentId });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Send failed: ${err}`);
    }
  }

  private async handleExport(indices: number[], annotations: Record<number, any[]>): Promise<void> {
    if (indices.length === 0) {
      vscode.window.showWarningMessage('No frames selected');
      return;
    }

    try {
      const result = await vscode.commands.executeCommand<GrabResult>(
        '_autothropic.capture.grabSelected', indices
      );
      const filePaths = await this.resolveGrabResult(result, annotations, indices);
      if (filePaths.length > 0) {
        for (const fp of filePaths) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp));
        }
        vscode.window.showInformationMessage(`Exported ${filePaths.length} frame(s)`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Export failed: ${err}`);
    }
  }

  /** Convert grab result to file paths, saving data URLs to temp files if needed. */
  private async resolveGrabResult(result: GrabResult | undefined | null, _annotations: Record<number, any[]>, _indices: number[]): Promise<string[]> {
    if (!result) { return []; }

    // If we already have file paths, use them
    if (result.filePaths && result.filePaths.length > 0) {
      return result.filePaths;
    }

    // Otherwise save data URLs as temp PNG files
    if (result.dataUrls && result.dataUrls.length > 0) {
      const tmpDir = path.join(os.tmpdir(), 'autothropic-clips');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }

      const ts = Date.now();
      const filePaths: string[] = [];
      for (let i = 0; i < result.dataUrls.length; i++) {
        const dataUrl = result.dataUrls[i];
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) { continue; }
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const buffer = Buffer.from(match[2], 'base64');
        const filePath = path.join(tmpDir, `clip-${ts}-${i + 1}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        filePaths.push(filePath);
      }
      return filePaths;
    }

    return [];
  }

  private getHtml(thumbnails: ClipThumbnail[], suggested: number[], agents: AgentInfo[], seconds: number): string {
    const now = Date.now();

    const agentOptionsHtml = agents.map(a =>
      `<option value="${a.id}" data-color="${a.color}">${a.name}</option>`
    ).join('');

    const defaultAgent = agents.find(a => a.status === 'waiting') ?? agents[0];

    return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background, #111110);
      color: var(--vscode-foreground, #a8a69e);
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }

    /* --- Top Bar --- */
    .top-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #2a2a26);
      flex-shrink: 0;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #d97757; }
    .top-bar .title { font-size: 13px; font-weight: 600; color: var(--vscode-editor-foreground, #e8e5de); }
    .duration-control {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }
    .duration-control label { font-size: 11px; color: var(--vscode-descriptionForeground, #7a7870); }
    .duration-control input[type="range"] {
      width: 120px;
      accent-color: #d97757;
    }
    .duration-label {
      font-size: 12px;
      font-weight: 600;
      color: #d97757;
      min-width: 24px;
    }
    .frame-count { font-size: 11px; color: var(--vscode-descriptionForeground, #7a7870); }

    /* --- Annotation toolbar --- */
    .anno-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #2a2a26);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .anno-toolbar .toolbar-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .anno-toolbar .toolbar-sep {
      width: 1px;
      height: 18px;
      background: var(--vscode-panel-border, #2a2a26);
      margin: 0 6px;
    }
    .tool-button {
      padding: 3px 7px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground, #a8a69e);
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .tool-button:hover { background: var(--vscode-list-hoverBackground, #232320); color: var(--vscode-editor-foreground, #e8e5de); }
    .tool-button.active { background: #d97757; color: #f5f2eb; border-color: #d97757; }
    .tool-button svg { width: 12px; height: 12px; }
    .color-swatch {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
    }
    .color-swatch:hover { border-color: #555; }
    .color-swatch.active { border-color: #e8e5de; }
    .anno-toolbar .color-input {
      width: 20px;
      height: 20px;
      border: 2px solid var(--vscode-panel-border, #2a2a26);
      border-radius: 4px;
      background: none;
      cursor: pointer;
      padding: 0;
    }
    .width-preset {
      padding: 1px 5px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground, #a8a69e);
      font-size: 9px;
      cursor: pointer;
      font-family: inherit;
    }
    .width-preset:hover { background: var(--vscode-list-hoverBackground, #232320); }
    .width-preset.active { background: #d97757; color: #f5f2eb; }

    /* --- Main View --- */
    .main-view {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      min-height: 0;
      padding: 16px;
    }
    .main-frame {
      position: relative;
      cursor: crosshair;
      border-radius: 8px;
      overflow: hidden;
      border: 3px solid transparent;
      transition: border-color 0.15s;
      max-height: 100%;
      display: inline-block;
    }
    .main-frame.selected { border-color: #d97757; }
    .main-frame canvas {
      display: block;
      position: absolute;
      top: 0;
      left: 0;
    }
    .main-frame canvas#bg-canvas { position: relative; }
    .selection-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #d97757;
      color: #f5f2eb;
      font-size: 12px;
      font-weight: 700;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 5;
    }
    .main-frame.selected .selection-badge { display: flex; }
    .info-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      padding: 4px 8px;
      background: rgba(0,0,0,0.6);
      font-size: 10px;
      color: var(--vscode-foreground, #a8a69e);
      z-index: 5;
    }
    .text-input-overlay {
      position: absolute;
      display: none;
      z-index: 10;
    }
    .text-input-overlay textarea {
      background: rgba(0,0,0,0.7);
      border: 1px solid #d97757;
      color: #fff;
      font-size: 16px;
      padding: 4px 8px;
      border-radius: 4px;
      outline: none;
      min-width: 120px;
      min-height: 28px;
      resize: both;
      font-family: system-ui, -apple-system, sans-serif;
      font-weight: bold;
      line-height: 1.3;
    }
    .eraser-cursor {
      position: absolute;
      pointer-events: none;
      border: 2px solid rgba(255,255,255,0.8);
      border-radius: 50%;
      z-index: 5;
      display: none;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.3);
    }
    .main-frame.eraser-active { cursor: none !important; }

    .nav-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: var(--vscode-sideBar-background, rgba(17,17,16,0.9));
      border: 1px solid var(--vscode-panel-border, #2a2a26);
      color: var(--vscode-foreground, #a8a69e);
      width: 44px;
      height: 44px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s, transform 0.15s;
      z-index: 6;
    }
    .nav-arrow svg { width: 22px; height: 22px; }
    .nav-arrow:hover {
      background: var(--vscode-list-hoverBackground, #232320);
      color: var(--vscode-editor-foreground, #e8e5de);
      transform: translateY(-50%) scale(1.1);
    }
    .nav-arrow:active { transform: translateY(-50%) scale(0.95); }
    .nav-arrow.left { left: 12px; }
    .nav-arrow.right { right: 12px; }

    /* --- Filmstrip --- */
    .filmstrip-wrap {
      flex-shrink: 0;
      position: relative;
      border-top: 1px solid var(--vscode-panel-border, #2a2a26);
    }
    .filmstrip-wrap::before,
    .filmstrip-wrap::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 32px;
      z-index: 2;
      pointer-events: none;
      opacity: 0;
      transition: opacity 200ms;
    }
    .filmstrip-wrap::before {
      left: 0;
      background: linear-gradient(to right, var(--vscode-editor-background, #111110), transparent);
    }
    .filmstrip-wrap::after {
      right: 0;
      background: linear-gradient(to left, var(--vscode-editor-background, #111110), transparent);
    }
    .filmstrip-wrap.fade-left::before { opacity: 1; }
    .filmstrip-wrap.fade-right::after { opacity: 1; }
    .filmstrip {
      padding: 6px 16px;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      text-align: center;
      scrollbar-width: none;
    }
    .filmstrip::-webkit-scrollbar { display: none; }
    .filmstrip.overflowing { text-align: left; }
    .strip-thumb {
      display: inline-block;
      width: 56px;
      height: 38px;
      margin-right: 3px;
      border-radius: 3px;
      border: 2px solid transparent;
      overflow: hidden;
      cursor: pointer;
      opacity: 0.35;
      transition: opacity 200ms, border-color 200ms;
      vertical-align: middle;
      position: relative;
    }
    .strip-thumb:hover { opacity: 0.7; }
    .strip-thumb.cursor { border-color: #e8e5de; opacity: 1; }
    .strip-thumb.selected { border-color: #d97757; opacity: 1; }
    .strip-thumb.cursor.selected { border-color: #d97757; box-shadow: 0 0 0 1px #e8e5de; }
    .strip-thumb.annotated::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ff9500;
    }
    .strip-thumb img { width: 100%; height: 100%; object-fit: cover; }

    /* --- Selection Tray --- */
    .tray-wrap {
      flex-shrink: 0;
      position: relative;
      border-top: 1px solid var(--vscode-panel-border, #2a2a26);
      display: none;
    }
    .tray-wrap.visible { display: block; }
    .selection-tray {
      padding: 6px 16px;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      text-align: center;
      scrollbar-width: none;
    }
    .selection-tray::-webkit-scrollbar { display: none; }
    .selection-tray.overflowing { text-align: left; }
    .tray-thumb {
      display: inline-block;
      width: 48px;
      height: 32px;
      margin-right: 4px;
      border-radius: 3px;
      border: 2px solid #d97757;
      overflow: hidden;
      cursor: pointer;
      position: relative;
      vertical-align: middle;
    }
    .tray-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .tray-thumb .tray-badge {
      position: absolute;
      bottom: 1px;
      right: 1px;
      font-size: 8px;
      background: rgba(0,0,0,0.7);
      color: #d97757;
      padding: 0 3px;
      border-radius: 2px;
      font-weight: 700;
    }
    .tray-thumb .tray-remove {
      position: absolute;
      top: -1px;
      right: -1px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #e5534b;
      color: #f5f2eb;
      font-size: 9px;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .tray-thumb:hover .tray-remove { display: flex; }

    /* --- Action Bar --- */
    .action-bar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-top: 1px solid var(--vscode-panel-border, #2a2a26);
    }
    .action-btn {
      padding: 5px 12px;
      border-radius: 5px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      border: 1px solid var(--vscode-panel-border, #2a2a26);
      background: var(--vscode-sideBar-background, #1c1c1a);
      color: var(--vscode-foreground, #a8a69e);
    }
    .action-btn:hover { background: var(--vscode-list-hoverBackground, #232320); color: var(--vscode-editor-foreground, #e8e5de); }
    .hint { font-size: 10px; color: var(--vscode-disabledForeground, #5a5850); margin-left: 8px; }
    .spacer { flex: 1; }
    .agent-select {
      background: var(--vscode-sideBar-background, #1c1c1a);
      border: 1px solid var(--vscode-panel-border, #2a2a26);
      color: var(--vscode-foreground, #a8a69e);
      padding: 5px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-family: inherit;
    }
    .send-btn {
      padding: 5px 16px;
      border-radius: 5px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      border: none;
      background: #d97757;
      color: #f5f2eb;
      font-weight: 600;
    }
    .send-btn:hover { background: #c46a4d; }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-disabledForeground, #5a5850);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="status-dot"></div>
    <span class="title">Clip Editor</span>
    <div class="duration-control">
      <label>Duration</label>
      <input type="range" id="duration-slider" min="1" max="5" step="0.5" value="${seconds}" />
      <span class="duration-label" id="duration-label">${seconds}s</span>
    </div>
    <span class="frame-count" id="frame-count"></span>
  </div>

  <!-- Annotation toolbar -->
  <div class="anno-toolbar" id="anno-toolbar">
    <div class="toolbar-group" id="tools">
      <button class="tool-button" data-tool="select" title="Select (V)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-7 2-3 7z"/></svg>
      </button>
      <button class="tool-button" data-tool="pen" title="Pen (P)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
      </button>
      <button class="tool-button" data-tool="line" title="Line (L)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>
      </button>
      <button class="tool-button" data-tool="rect" title="Rect (R)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
      </button>
      <button class="tool-button" data-tool="arrow" title="Arrow (A)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>
      </button>
      <button class="tool-button" data-tool="text" title="Text (T)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
      </button>
      <button class="tool-button" data-tool="eraser" title="Eraser (E)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.2 2l7.8 7.8-6.2 6.2"/><path d="M6.5 13.5L14 6"/></svg>
      </button>
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group" id="colors">
      <div class="color-swatch active" data-color="#ff3b30" style="background:#ff3b30"></div>
      <div class="color-swatch" data-color="#ff9500" style="background:#ff9500"></div>
      <div class="color-swatch" data-color="#ffcc00" style="background:#ffcc00"></div>
      <div class="color-swatch" data-color="#34c759" style="background:#34c759"></div>
      <div class="color-swatch" data-color="#007aff" style="background:#007aff"></div>
      <div class="color-swatch" data-color="#ffffff" style="background:#ffffff"></div>
      <div class="color-swatch" data-color="#000000" style="background:#000000;border:1px solid #444"></div>
      <input type="color" class="color-input" id="custom-color" value="#ff3b30" title="Custom" />
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <button class="width-preset" data-width="2">2</button>
      <button class="width-preset active" data-width="4">4</button>
      <button class="width-preset" data-width="8">8</button>
      <button class="width-preset" data-width="16">16</button>
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <button class="tool-button" id="btn-undo" title="Undo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      </button>
      <button class="tool-button" id="btn-redo" title="Redo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
      </button>
    </div>
  </div>

  <div class="main-view" id="main-view">
    <button class="nav-arrow left" id="nav-left"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <div class="main-frame" id="main-frame">
      <canvas id="bg-canvas"></canvas>
      <canvas id="draw-canvas"></canvas>
      <canvas id="preview-canvas"></canvas>
      <span class="selection-badge" id="main-badge"></span>
      <div class="info-bar">
        <span id="time-label"></span>
        <span id="pos-label"></span>
      </div>
      <div class="text-input-overlay" id="text-input-overlay">
        <textarea id="text-input" placeholder="Type..." rows="1"></textarea>
      </div>
      <div class="eraser-cursor" id="eraser-cursor"></div>
    </div>
    <button class="nav-arrow right" id="nav-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
  </div>

  <div class="filmstrip-wrap" id="filmstrip-wrap">
    <div class="filmstrip" id="filmstrip"></div>
  </div>
  <div class="tray-wrap" id="tray-wrap">
    <div class="selection-tray" id="selection-tray"></div>
  </div>

  <div class="action-bar">
    <button class="action-btn" id="btn-autoselect">Auto-select</button>
    <button class="action-btn" id="btn-clear">Clear</button>
    <span class="hint">Arrows navigate / Space toggles / Click to annotate</span>
    <span class="spacer"></span>
    ${agents.length > 0 ? `<select class="agent-select" id="agent-select">${agentOptionsHtml}</select>` : ''}
    <button class="send-btn" id="btn-send" disabled>Send 0 frames</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let thumbnails = ${JSON.stringify(thumbnails)};
    let selected = new Set(${JSON.stringify(suggested)});
    let cursor = 0;
    const now = ${now};
    const agents = ${JSON.stringify(agents)};
    const defaultAgentId = ${JSON.stringify(defaultAgent?.id ?? '')};

    // Per-frame annotation state: frameAnnotations[frameIndex] = { ops: [], redoStack: [] }
    const frameAnnotations = {};

    // Current drawing state
    let currentTool = 'select';
    let currentColor = '#ff3b30';
    let currentWidth = 4;
    let isDrawing = false;
    let startX = 0, startY = 0;
    let currentPoints = [];
    let frameImg = null;
    let displayScale = 1;

    const bgCanvas = document.getElementById('bg-canvas');
    const drawCanvas = document.getElementById('draw-canvas');
    const previewCanvas = document.getElementById('preview-canvas');
    const bgCtx = bgCanvas.getContext('2d');
    const drawCtx = drawCanvas.getContext('2d');
    const previewCtx = previewCanvas.getContext('2d');
    const mainFrame = document.getElementById('main-frame');
    const mainView = document.getElementById('main-view');
    const eraserCursor = document.getElementById('eraser-cursor');

    function getAnno() {
      if (!frameAnnotations[cursor]) frameAnnotations[cursor] = { ops: [], redoStack: [] };
      return frameAnnotations[cursor];
    }

    function loadFrameImage() {
      if (thumbnails.length === 0) return;
      const t = thumbnails[cursor];
      frameImg = new Image();
      frameImg.onload = function() { fitCanvases(); redrawAll(); };
      frameImg.src = t.preview;
    }

    function fitCanvases() {
      if (!frameImg) return;
      const viewRect = mainView.getBoundingClientRect();
      const maxW = viewRect.width - 120;
      const maxH = viewRect.height - 40;
      displayScale = Math.min(maxW / frameImg.width, maxH / frameImg.height, 1);
      const w = Math.round(frameImg.width * displayScale);
      const h = Math.round(frameImg.height * displayScale);
      bgCanvas.width = w; bgCanvas.height = h;
      drawCanvas.width = w; drawCanvas.height = h;
      previewCanvas.width = w; previewCanvas.height = h;
      mainFrame.style.width = w + 'px';
      mainFrame.style.height = h + 'px';
    }

    function drawOp(ctx, op) {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      switch (op.type) {
        case 'pen': {
          if (op.points.length < 2) break;
          ctx.beginPath();
          ctx.moveTo(op.points[0].x, op.points[0].y);
          for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y);
          ctx.stroke();
          break;
        }
        case 'line': { ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke(); break; }
        case 'rect': { ctx.strokeRect(op.x, op.y, op.w, op.h); break; }
        case 'arrow': {
          const dx = op.x2 - op.x1, dy = op.y2 - op.y1;
          const angle = Math.atan2(dy, dx);
          const headLen = Math.max(10, op.width * 3);
          ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(op.x2, op.y2);
          ctx.lineTo(op.x2 - headLen * Math.cos(angle - Math.PI / 6), op.y2 - headLen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(op.x2, op.y2);
          ctx.lineTo(op.x2 - headLen * Math.cos(angle + Math.PI / 6), op.y2 - headLen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
          break;
        }
        case 'text': {
          const fontSize = op.fontSize || Math.max(14, op.width * 4);
          ctx.font = 'bold ' + fontSize + 'px system-ui, -apple-system, sans-serif';
          const lines = (op.text || '').split('\\n');
          for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], op.x, op.y + i * (fontSize * 1.3));
          break;
        }
        case 'eraser': {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.lineWidth = op.width * 4;
          if (op.points.length < 2) break;
          ctx.beginPath();
          ctx.moveTo(op.points[0].x, op.points[0].y);
          for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y);
          ctx.stroke();
          break;
        }
      }
      ctx.restore();
    }

    function redrawAll() {
      if (!frameImg) return;
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.drawImage(frameImg, 0, 0, bgCanvas.width, bgCanvas.height);
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      const anno = getAnno();
      for (const op of anno.ops) drawOp(drawCtx, op);
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }

    function redrawWithEraserPreview() {
      if (!frameImg) return;
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.drawImage(frameImg, 0, 0, bgCanvas.width, bgCanvas.height);
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      const anno = getAnno();
      for (const op of anno.ops) drawOp(drawCtx, op);
      if (currentPoints.length >= 2) {
        drawOp(drawCtx, { type: 'eraser', points: currentPoints, color: currentColor, width: currentWidth });
      }
    }

    function getCanvasPos(e) {
      const rect = previewCanvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function updateEraserCursor(e) {
      if (currentTool !== 'eraser') { eraserCursor.style.display = 'none'; mainFrame.classList.remove('eraser-active'); return; }
      mainFrame.classList.add('eraser-active');
      const rect = mainFrame.getBoundingClientRect();
      const size = currentWidth * 4;
      eraserCursor.style.display = 'block';
      eraserCursor.style.width = size + 'px';
      eraserCursor.style.height = size + 'px';
      eraserCursor.style.left = (e.clientX - rect.left - size / 2) + 'px';
      eraserCursor.style.top = (e.clientY - rect.top - size / 2) + 'px';
    }

    // Mouse events on preview canvas
    previewCanvas.addEventListener('mousedown', function(e) {
      if (currentTool === 'select') {
        // In select mode, click toggles selection
        toggleSelection(cursor);
        return;
      }
      if (currentTool === 'text') { const pos = getCanvasPos(e); showTextInput(pos.x, pos.y); return; }
      isDrawing = true;
      const pos = getCanvasPos(e);
      startX = pos.x; startY = pos.y;
      currentPoints = [{ x: pos.x, y: pos.y }];
    });

    previewCanvas.addEventListener('mousemove', function(e) {
      updateEraserCursor(e);
      if (!isDrawing) return;
      const pos = getCanvasPos(e);
      if (currentTool === 'eraser') { currentPoints.push(pos); redrawWithEraserPreview(); return; }
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      if (currentTool === 'pen') { currentPoints.push(pos); drawOp(previewCtx, { type: 'pen', points: currentPoints, color: currentColor, width: currentWidth }); }
      else if (currentTool === 'line') { drawOp(previewCtx, { type: 'line', x1: startX, y1: startY, x2: pos.x, y2: pos.y, color: currentColor, width: currentWidth }); }
      else if (currentTool === 'rect') { drawOp(previewCtx, { type: 'rect', x: Math.min(startX, pos.x), y: Math.min(startY, pos.y), w: Math.abs(pos.x - startX), h: Math.abs(pos.y - startY), color: currentColor, width: currentWidth }); }
      else if (currentTool === 'arrow') { drawOp(previewCtx, { type: 'arrow', x1: startX, y1: startY, x2: pos.x, y2: pos.y, color: currentColor, width: currentWidth }); }
    });

    previewCanvas.addEventListener('mouseup', function(e) {
      if (!isDrawing) return;
      isDrawing = false;
      const pos = getCanvasPos(e);
      const anno = getAnno();
      let op = null;
      if (currentTool === 'pen') { currentPoints.push(pos); op = { type: 'pen', points: currentPoints.slice(), color: currentColor, width: currentWidth }; }
      else if (currentTool === 'eraser') { currentPoints.push(pos); op = { type: 'eraser', points: currentPoints.slice(), color: currentColor, width: currentWidth }; }
      else if (currentTool === 'line') { op = { type: 'line', x1: startX, y1: startY, x2: pos.x, y2: pos.y, color: currentColor, width: currentWidth }; }
      else if (currentTool === 'rect') { op = { type: 'rect', x: Math.min(startX, pos.x), y: Math.min(startY, pos.y), w: Math.abs(pos.x - startX), h: Math.abs(pos.y - startY), color: currentColor, width: currentWidth }; }
      else if (currentTool === 'arrow') { op = { type: 'arrow', x1: startX, y1: startY, x2: pos.x, y2: pos.y, color: currentColor, width: currentWidth }; }
      if (op) { anno.ops.push(op); anno.redoStack = []; redrawAll(); renderFilmstrip(); }
      currentPoints = [];
    });

    previewCanvas.addEventListener('mouseleave', function() {
      eraserCursor.style.display = 'none';
      if (isDrawing) {
        isDrawing = false;
        if ((currentTool === 'pen' || currentTool === 'eraser') && currentPoints.length > 1) {
          const anno = getAnno();
          anno.ops.push({ type: currentTool, points: currentPoints.slice(), color: currentColor, width: currentWidth });
          anno.redoStack = [];
          renderFilmstrip();
        }
        currentPoints = [];
        redrawAll();
      }
    });

    // Text input
    function showTextInput(x, y) {
      const overlay = document.getElementById('text-input-overlay');
      const input = document.getElementById('text-input');
      const fontSize = Math.max(14, currentWidth * 4);
      overlay.style.display = 'block';
      overlay.style.left = x + 'px';
      overlay.style.top = y + 'px';
      input.style.color = currentColor;
      input.style.fontSize = fontSize + 'px';
      input.value = '';
      setTimeout(function() { input.focus(); }, 50);
    }

    function commitText() {
      const overlay = document.getElementById('text-input-overlay');
      const input = document.getElementById('text-input');
      if (overlay.style.display === 'none') return;
      const text = input.value.trim();
      if (text) {
        const fontSize = Math.max(14, currentWidth * 4);
        const anno = getAnno();
        anno.ops.push({ type: 'text', text: text, x: parseInt(overlay.style.left), y: parseInt(overlay.style.top) + fontSize, color: currentColor, width: currentWidth, fontSize: fontSize });
        anno.redoStack = [];
        redrawAll();
        renderFilmstrip();
      }
      overlay.style.display = 'none';
    }

    document.getElementById('text-input').addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
      if (e.key === 'Escape') { document.getElementById('text-input-overlay').style.display = 'none'; }
    });
    document.getElementById('text-input').addEventListener('blur', function() { setTimeout(commitText, 150); });

    // Tool, color, width selection
    document.getElementById('tools').addEventListener('click', function(e) {
      const btn = e.target.closest('.tool-button');
      if (!btn || !btn.dataset.tool) return;
      selectTool(btn.dataset.tool);
    });

    function selectTool(tool) {
      currentTool = tool;
      document.querySelectorAll('#tools .tool-button').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
      mainFrame.style.cursor = tool === 'select' ? 'pointer' : tool === 'eraser' ? 'none' : 'crosshair';
      if (tool !== 'eraser') { eraserCursor.style.display = 'none'; mainFrame.classList.remove('eraser-active'); }
    }

    document.getElementById('colors').addEventListener('click', function(e) {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch) return;
      currentColor = swatch.dataset.color;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      document.getElementById('custom-color').value = currentColor;
    });

    document.getElementById('custom-color').addEventListener('input', function(e) {
      currentColor = e.target.value;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    });

    document.querySelectorAll('.width-preset').forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentWidth = parseInt(btn.dataset.width);
        document.querySelectorAll('.width-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Undo/Redo per frame
    document.getElementById('btn-undo').addEventListener('click', function() {
      const anno = getAnno();
      if (anno.ops.length === 0) return;
      anno.redoStack.push(anno.ops.pop());
      redrawAll();
      renderFilmstrip();
    });
    document.getElementById('btn-redo').addEventListener('click', function() {
      const anno = getAnno();
      if (anno.redoStack.length === 0) return;
      anno.ops.push(anno.redoStack.pop());
      redrawAll();
      renderFilmstrip();
    });

    function init() {
      renderFilmstrip();
      renderSelectionTray();
      loadFrameImage();
      updateMainUI();
      updateSendButton();
      updateFrameCount();
      if (document.getElementById('agent-select') && defaultAgentId) {
        document.getElementById('agent-select').value = defaultAgentId;
      }
      selectTool('select');
    }

    function updateScrollFades(scrollEl, wrapEl) {
      if (!scrollEl || !wrapEl) return;
      const isOverflowing = scrollEl.scrollWidth > scrollEl.clientWidth + 2;
      scrollEl.classList.toggle('overflowing', isOverflowing);
      if (!isOverflowing) { wrapEl.classList.remove('fade-left', 'fade-right'); return; }
      wrapEl.classList.toggle('fade-left', scrollEl.scrollLeft > 4);
      wrapEl.classList.toggle('fade-right', scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 4);
    }

    function renderFilmstrip() {
      const fs = document.getElementById('filmstrip');
      const wrap = document.getElementById('filmstrip-wrap');
      if (thumbnails.length === 0) {
        fs.innerHTML = '<span style="color:#5a5850;font-size:11px">No frames captured</span>';
        return;
      }
      let html = '';
      for (let i = 0; i < thumbnails.length; i++) {
        const cls = [];
        if (i === cursor) cls.push('cursor');
        if (selected.has(i)) cls.push('selected');
        if (frameAnnotations[i] && frameAnnotations[i].ops.length > 0) cls.push('annotated');
        html += '<div class="strip-thumb ' + cls.join(' ') + '" data-idx="' + i + '"><img src="' + thumbnails[i].strip + '" /></div>';
      }
      fs.innerHTML = html;
      scrollFilmstripToCursor();
      requestAnimationFrame(() => updateScrollFades(fs, wrap));
    }

    function renderSelectionTray() {
      const tray = document.getElementById('selection-tray');
      const wrap = document.getElementById('tray-wrap');
      const sorted = Array.from(selected).sort((a, b) => a - b);
      if (sorted.length === 0) { wrap.classList.remove('visible'); return; }
      wrap.classList.add('visible');
      let html = '';
      sorted.forEach((idx, order) => {
        const t = thumbnails[idx];
        if (!t) return;
        html += '<div class="tray-thumb" data-idx="' + idx + '">' +
          '<img src="' + t.strip + '" />' +
          '<span class="tray-badge">' + (order + 1) + '</span>' +
          '<span class="tray-remove" data-remove="' + idx + '">x</span>' +
          '</div>';
      });
      tray.innerHTML = html;
      requestAnimationFrame(() => updateScrollFades(tray, wrap));
    }

    function updateMainUI() {
      if (thumbnails.length === 0) return;
      const t = thumbnails[cursor];
      const frame = document.getElementById('main-frame');
      const badge = document.getElementById('main-badge');
      if (selected.has(cursor)) {
        frame.classList.add('selected');
        const sorted = Array.from(selected).sort((a, b) => a - b);
        badge.textContent = sorted.indexOf(cursor) + 1;
      } else {
        frame.classList.remove('selected');
      }
      const elapsed = ((t.timestamp - now) / 1000).toFixed(1);
      document.getElementById('time-label').textContent = elapsed + 's';
      document.getElementById('pos-label').textContent = (cursor + 1) + '/' + thumbnails.length;
    }

    function updateSendButton() {
      const btn = document.getElementById('btn-send');
      const count = selected.size;
      const agentSel = document.getElementById('agent-select');
      const agentName = agentSel ? agentSel.options[agentSel.selectedIndex]?.text ?? '' : '';
      btn.textContent = count > 0
        ? 'Send ' + count + ' frame' + (count > 1 ? 's' : '') + (agentName ? ' to ' + agentName : '')
        : 'Send 0 frames';
      btn.disabled = count === 0;
    }

    function updateFrameCount() {
      document.getElementById('frame-count').textContent = selected.size + '/' + thumbnails.length;
    }

    function toggleSelection(idx) {
      if (selected.has(idx)) { selected.delete(idx); }
      else { if (selected.size >= 30) return; selected.add(idx); }
      renderFilmstrip();
      renderSelectionTray();
      updateMainUI();
      updateSendButton();
      updateFrameCount();
    }

    function setCursor(idx) {
      if (idx < 0 || idx >= thumbnails.length) return;
      cursor = idx;
      renderFilmstrip();
      loadFrameImage();
      updateMainUI();
    }

    function scrollFilmstripToCursor() {
      const fs = document.getElementById('filmstrip');
      const el = fs.querySelector('.strip-thumb.cursor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // Scroll fade listeners
    document.getElementById('filmstrip').addEventListener('scroll', () => {
      updateScrollFades(document.getElementById('filmstrip'), document.getElementById('filmstrip-wrap'));
    });
    document.getElementById('selection-tray').addEventListener('scroll', () => {
      updateScrollFades(document.getElementById('selection-tray'), document.getElementById('tray-wrap'));
    });

    // Navigation
    document.getElementById('nav-left').addEventListener('click', () => setCursor(cursor - 1));
    document.getElementById('nav-right').addEventListener('click', () => setCursor(cursor + 1));

    document.getElementById('filmstrip').addEventListener('click', (e) => {
      const thumb = e.target.closest('.strip-thumb');
      if (thumb) setCursor(parseInt(thumb.dataset.idx));
    });
    document.getElementById('filmstrip').addEventListener('dblclick', (e) => {
      const thumb = e.target.closest('.strip-thumb');
      if (thumb) toggleSelection(parseInt(thumb.dataset.idx));
    });

    document.getElementById('selection-tray').addEventListener('click', (e) => {
      const remove = e.target.closest('.tray-remove');
      if (remove) { toggleSelection(parseInt(remove.dataset.remove)); return; }
      const thumb = e.target.closest('.tray-thumb');
      if (thumb) setCursor(parseInt(thumb.dataset.idx));
    });

    document.getElementById('btn-autoselect').addEventListener('click', () => {
      vscode.postMessage({ type: 'changeDuration', seconds: parseFloat(document.getElementById('duration-slider').value) });
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      selected.clear();
      renderFilmstrip();
      renderSelectionTray();
      updateMainUI();
      updateSendButton();
      updateFrameCount();
    });
    document.getElementById('btn-send').addEventListener('click', () => {
      const agentSel = document.getElementById('agent-select');
      const agentId = agentSel ? agentSel.value : '';
      // Collect annotations for selected frames
      const annos = {};
      for (const idx of selected) {
        if (frameAnnotations[idx] && frameAnnotations[idx].ops.length > 0) {
          annos[idx] = frameAnnotations[idx].ops;
        }
      }
      vscode.postMessage({
        type: 'send',
        indices: Array.from(selected).sort((a, b) => a - b),
        annotations: annos,
        agentId,
      });
    });

    const agentSel = document.getElementById('agent-select');
    if (agentSel) agentSel.addEventListener('change', updateSendButton);

    document.getElementById('duration-slider').addEventListener('input', (e) => {
      document.getElementById('duration-label').textContent = e.target.value + 's';
    });
    document.getElementById('duration-slider').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'changeDuration', seconds: parseFloat(e.target.value) });
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        const anno = getAnno();
        if (anno.ops.length > 0) { anno.redoStack.push(anno.ops.pop()); redrawAll(); renderFilmstrip(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        const anno = getAnno();
        if (anno.redoStack.length > 0) { anno.ops.push(anno.redoStack.pop()); redrawAll(); renderFilmstrip(); }
        return;
      }

      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); setCursor(cursor - 1); break;
        case 'ArrowRight': e.preventDefault(); setCursor(cursor + 1); break;
        case ' ':
        case 'Enter': e.preventDefault(); toggleSelection(cursor); break;
        case 'Escape': break;
      }
      switch (e.key.toLowerCase()) {
        case 'v': selectTool('select'); break;
        case 'p': selectTool('pen'); break;
        case 'l': selectTool('line'); break;
        case 'r': selectTool('rect'); break;
        case 'a': selectTool('arrow'); break;
        case 't': selectTool('text'); break;
        case 'e': selectTool('eraser'); break;
      }
    });

    // Handle updates from extension
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'updateThumbnails') {
        thumbnails = msg.thumbnails;
        selected = new Set(msg.suggested);
        cursor = 0;
        init();
      }
    });

    window.addEventListener('resize', () => {
      if (frameImg && frameImg.complete) { fitCanvases(); redrawAll(); }
    });

    init();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this._onSend.dispose();
    for (const p of this.panels) { p.dispose(); }
    this.panels.clear();
  }
}
