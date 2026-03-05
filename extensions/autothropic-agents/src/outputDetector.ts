import * as vscode from 'vscode';
import type { SessionManager } from './sessionManager';

/** Sessions that just received a forwarded message — suppress false completions */
const suppressUntil = new Map<string, number>();

export function suppressSession(sessionId: string, durationMs = 3000): void {
  suppressUntil.set(sessionId, Date.now() + durationMs);
}

export function clearSuppression(sessionId: string): void {
  suppressUntil.delete(sessionId);
}

function isSuppressed(sessionId: string): boolean {
  const until = suppressUntil.get(sessionId);
  if (!until) { return false; }
  if (Date.now() > until) {
    suppressUntil.delete(sessionId);
    return false;
  }
  return true;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')      // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')           // OSC sequences (BEL terminated)
    .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')     // OSC with ST terminator
    .replace(/\x1b[()][0-9A-B]/g, '')             // Charset designations
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')  // Private mode sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Control chars (keep \t \n \r)
}

export interface CompletionEvent {
  sessionId: string;
  response: string;
}

/**
 * Shell prompt patterns indicating Claude Code has exited and the
 * underlying shell has regained control of the terminal.
 */
const SHELL_PROMPT_PATTERNS = [
  /PS [A-Z]:\\[^\r\n>]*>\s*$/m,  // PowerShell on Windows
  /PS \/[^\r\n>]*>\s*$/m,         // PowerShell on Unix
  /^[A-Z]:\\[^\r\n>]*>\s*$/m,     // cmd.exe
];

/**
 * Patterns indicating Claude Code is waiting for user input (permission prompts,
 * tool approval, edit confirmations, etc.).
 * These are checked against the ANSI-stripped tail of the terminal buffer.
 */
const INPUT_PROMPT_PATTERNS = [
  // Numbered option lists: "> 1. Yes", "  2. No", "  3. ..."
  /^\s*>?\s*\d+\.\s+(Yes|No|Allow|Deny|Skip|Retry|Cancel)/m,
  // "Do you want to ..." questions
  /Do you want to\b/i,
  // "Esc to cancel" / "Tab to amend" footer
  /Esc to cancel/,
  // Permission prompts
  /\bAllow\s+(once|always)\b/i,
  // "(y\/n)" or "[Y/n]" style prompts
  /\([yYnN]\/[yYnN]\)/,
  /\[[yYnN]\/[yYnN]\]/,
  // "Press Enter to continue" or similar
  /Press Enter/i,
];

/** How long (ms) of silence before we consider Claude idle. */
const IDLE_TIMEOUT_MS = 800;

/** How long (ms) of silence after a shell prompt before we confirm exit. */
const EXIT_CONFIRM_MS = 2000;

/**
 * OutputDetector uses **silence-based detection** for Claude Code status.
 *
 * Claude Code is a full-screen TUI (Ink/React). When it's running, data
 * flows continuously (spinners, output). When it's idle at its `>` prompt,
 * data stops flowing. There is no distinct prompt character to detect.
 *
 * Status logic:
 * - Data arrives with meaningful content → "running"
 * - No data for IDLE_TIMEOUT_MS → "waiting" (+ fire completion event)
 * - Shell prompt pattern detected → "exited" after EXIT_CONFIRM_MS
 */
export class OutputDetector {
  private readonly buffers = new Map<string, string>();
  /** Timer that fires when data stops flowing (silence = idle). */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Timer that fires when a shell prompt persists (Claude exited). */
  private readonly exitTimers = new Map<string, NodeJS.Timeout>();
  /** Whether Claude has been active (non-empty data seen) for this session. */
  private readonly seenActivity = new Set<string>();
  /** Whether the initial startup shell prompt has been dismissed.
   *  Used to avoid false "exited" on the PowerShell prompt before Claude starts. */
  private readonly pastStartup = new Set<string>();
  /** Sessions whose terminal was just focused — suppress false "running" from buffer redraws */
  private readonly focusSuppressed = new Set<string>();
  private disposable: vscode.Disposable | undefined;

  private readonly _onCompletion = new vscode.EventEmitter<CompletionEvent>();
  readonly onCompletion = this._onCompletion.event;

  private readonly _onExited = new vscode.EventEmitter<string>();
  readonly onExited = this._onExited.event;

  constructor(private readonly sessionManager: SessionManager) {}

  start(): vscode.Disposable {
    const log = (...args: any[]) => console.log('[OutputDetector]', ...args);

    // When a terminal gains focus, VS Code redraws the buffer which fires
    // onDidWriteTerminalData. Suppress status changes briefly to avoid
    // false "running" status from buffer redraws.
    const focusDisposable = vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) { return; }
      const session = this.sessionManager.findSessionByTerminal(terminal);
      if (!session) { return; }
      log(`FOCUS terminal for session=${session.id} name=${session.name} status=${session.status}`);
      this.focusSuppressed.add(session.id);
      setTimeout(() => {
        this.focusSuppressed.delete(session.id);
        log(`FOCUS suppression expired for session=${session.id}`);
      }, 500);
    });

    this.disposable = vscode.window.onDidWriteTerminalData((e) => {
      const session = this.sessionManager.findSessionByTerminal(e.terminal);
      if (!session) { return; }

      const id = session.id;
      const rawLen = e.data.length;
      const strippedChunk = stripAnsi(e.data).trim();

      // Skip status changes for terminal buffer redraws on focus
      const isFocusRedraw = this.focusSuppressed.has(id);

      // Log every data event with context
      const preview = strippedChunk.slice(0, 80).replace(/\n/g, '\\n');
      log(`DATA session=${id} name=${session.name} status=${session.status} rawLen=${rawLen} strippedLen=${strippedChunk.length} focusSuppressed=${isFocusRedraw} preview="${preview}"`);

      // Buffer incoming data (for output previews & completion extraction)
      let buf = (this.buffers.get(id) || '') + e.data;
      if (buf.length > 10240) { buf = buf.slice(-10240); }
      this.buffers.set(id, buf);

      // Cancel any pending idle/exit timers — new data resets the clock
      this.clearIdleTimer(id);
      this.clearExitTimer(id);

      // Detect Claude Code startup: once we see its TUI banner, mark past startup.
      // The banner always contains "Claude" and "Code" with block-art characters.
      if (!this.pastStartup.has(id) && strippedChunk.includes('Claude') && strippedChunk.includes('Code')) {
        this.pastStartup.add(id);
        log(`STARTUP detected for session=${id}`);
      }

      // Check for shell prompt (exit detection).
      // Only trigger after startup (so we don't fire on the initial PS prompt
      // that appears before `claude` command runs).
      if (this.pastStartup.has(id) && this.isShellPrompt(strippedChunk)) {
        log(`SHELL_PROMPT detected for session=${id}, starting exit timer`);
        const exitTimer = setTimeout(() => {
          this.exitTimers.delete(id);
          // Verify the buffer tail still looks like a shell prompt
          const tail = stripAnsi(this.buffers.get(id) || '').slice(-300);
          if (this.isShellPrompt(tail)) {
            log(`EXIT confirmed for session=${id}`);
            this._onExited.fire(id);
          }
        }, EXIT_CONFIRM_MS);
        this.exitTimers.set(id, exitTimer);
        return; // Don't set running for shell prompts
      }

      // Mark as running if there's meaningful content (not just ANSI control codes).
      // Guard against false "running" from:
      //  1. Focus-triggered buffer redraws
      //  2. TUI redraws (Ink framework): large raw data with mostly ANSI codes
      //     (ratio of stripped to raw < 20% suggests ANSI redraw, not real output)
      const isLikelyRedraw = isFocusRedraw
        || (rawLen > 200 && strippedChunk.length / rawLen < 0.2)
        || (rawLen > 50 && strippedChunk.length === 0);

      if (strippedChunk.length > 0 && session.status !== 'exited' && !isLikelyRedraw) {
        this.seenActivity.add(id);
        if (session.status !== 'running') {
          log(`STATUS CHANGE: ${session.status} -> running for session=${id} (trigger: terminal data, strippedLen=${strippedChunk.length}, rawLen=${rawLen}, ratio=${(strippedChunk.length / rawLen).toFixed(2)})`);
          this.sessionManager.setSessionStatus(id, 'running');
        }
      } else if (strippedChunk.length > 0 && !isLikelyRedraw) {
        // Already running, just log
      } else if (strippedChunk.length > 0) {
        log(`SUPPRESSED status change for session=${id} (focusRedraw=${isFocusRedraw} rawLen=${rawLen} strippedLen=${strippedChunk.length} ratio=${(strippedChunk.length / rawLen).toFixed(2)})`);
      }

      // Don't start idle timer for redraw data — it would reset the clock on
      // a legitimately idle session
      if (isLikelyRedraw) {
        log(`SKIP idle timer for session=${id} (likely redraw)`);
        return;
      }

      // Set an idle timer: if no more data arrives for IDLE_TIMEOUT_MS,
      // Claude is idle at its prompt.
      const idleTimer = setTimeout(() => {
        this.idleTimers.delete(id);
        const currentSession = this.sessionManager.getSession(id);
        if (!currentSession || currentSession.status !== 'running') { return; }

        // Check if the buffer tail looks like an interactive prompt
        const tail = stripAnsi(this.buffers.get(id) || '').slice(-500);
        if (this.isInputPrompt(tail)) {
          log(`STATUS CHANGE: running -> input_needed for session=${id}`);
          this.sessionManager.setSessionStatus(id, 'input_needed');
          return; // Don't fire completion — agent is blocked on user input
        }

        log(`STATUS CHANGE: running -> waiting for session=${id} (idle timeout ${IDLE_TIMEOUT_MS}ms)`);
        this.sessionManager.setSessionStatus(id, 'waiting');

        // Fire completion event for orchestration (if we have meaningful output)
        if (!isSuppressed(id) && this.seenActivity.has(id)) {
          const clean = stripAnsi(this.buffers.get(id) || '');
          // Take last chunk of meaningful text as the "response"
          const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
          const response = lines.slice(-20).join('\n');
          if (response.length > 20) {
            this._onCompletion.fire({ sessionId: id, response });
          }
        }
      }, IDLE_TIMEOUT_MS);
      this.idleTimers.set(id, idleTimer);
    });

    // Combine both disposables
    const dataDisposable = this.disposable!;
    this.disposable = { dispose: () => { focusDisposable.dispose(); dataDisposable.dispose(); } };
    return this.disposable;
  }

  getLastLines(sessionId: string, count = 3): string[] {
    const buf = this.buffers.get(sessionId);
    if (!buf) { return []; }
    const clean = stripAnsi(buf);
    const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    return lines.slice(-count);
  }

  getAllLastLines(count = 3): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [id] of this.buffers) {
      result[id] = this.getLastLines(id, count);
    }
    return result;
  }

  /**
   * Mark a re-adopted session as past startup so exit detection works.
   */
  markAdopted(sessionId: string): void {
    this.pastStartup.add(sessionId);
    this.seenActivity.add(sessionId);
  }

  clearBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.clearIdleTimer(sessionId);
    this.clearExitTimer(sessionId);
    this.seenActivity.delete(sessionId);
    this.pastStartup.delete(sessionId);
  }

  private clearIdleTimer(id: string): void {
    const timer = this.idleTimers.get(id);
    if (timer) { clearTimeout(timer); this.idleTimers.delete(id); }
  }

  private clearExitTimer(id: string): void {
    const timer = this.exitTimers.get(id);
    if (timer) { clearTimeout(timer); this.exitTimers.delete(id); }
  }

  /** Check if text matches a common shell prompt pattern. */
  private isShellPrompt(text: string): boolean {
    const tail = text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(-3).join('\n');
    return SHELL_PROMPT_PATTERNS.some(re => re.test(tail));
  }

  /** Check if text matches Claude Code interactive input prompts. */
  private isInputPrompt(text: string): boolean {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(-10).join('\n');
    return INPUT_PROMPT_PATTERNS.some(re => re.test(lines));
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) { clearTimeout(timer); }
    for (const timer of this.exitTimers.values()) { clearTimeout(timer); }
    this.idleTimers.clear();
    this.exitTimers.clear();
    this.buffers.clear();
    this.seenActivity.clear();
    this.pastStartup.clear();
    this.focusSuppressed.clear();
    this._onCompletion.dispose();
    this._onExited.dispose();
    this.disposable?.dispose();
  }
}
