import * as vscode from 'vscode';
import * as fs from 'fs';
import type { SessionManager } from './sessionManager';

/** Sessions that just received a forwarded message -- suppress false completions */
const suppressUntil = new Map<string, number>();

export function suppressSession(sessionId: string, durationMs = 3000): void {
  suppressUntil.set(sessionId, Date.now() + durationMs);
}

export function clearSuppression(sessionId: string): void {
  suppressUntil.delete(sessionId);
}

function isCompletionSuppressed(sessionId: string): boolean {
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
 * How long (ms) to suppress ALL status changes after ANY terminal resize.
 * Resize causes VS Code to redraw every visible terminal buffer.
 */
const RESIZE_SUPPRESS_MS = 1500;

/**
 * Minimum number of data events with real content within RUNNING_WINDOW_MS
 * before we transition to "running". A single burst (redraw) won't trigger it.
 */
const RUNNING_DATA_THRESHOLD = 3;
const RUNNING_WINDOW_MS = 600;

/**
 * OutputDetector uses **silence-based detection** for Claude Code status.
 *
 * Claude Code is a full-screen TUI (Ink/React). When it's running, data
 * flows continuously (spinners, output). When it's idle at its `>` prompt,
 * data stops flowing. There is no distinct prompt character to detect.
 *
 * Status logic:
 * - Sustained data flow (3+ events in 600ms) -> "running"
 * - No data for IDLE_TIMEOUT_MS -> "waiting" (+ fire completion event)
 * - Shell prompt pattern detected -> "exited" after EXIT_CONFIRM_MS
 *
 * Redraw suppression:
 * - Terminal resize: suppress ALL sessions for 1.5s
 * - Terminal focus: suppress that session for 500ms
 * - Single data bursts: require sustained flow before "running"
 */
export class OutputDetector {
  private readonly buffers = new Map<string, string>();
  /** Timer that fires when data stops flowing (silence = idle). */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Timer that fires when a shell prompt persists (Claude exited). */
  private readonly exitTimers = new Map<string, NodeJS.Timeout>();
  /** Whether Claude has been active (non-empty data seen) for this session. */
  private readonly seenActivity = new Set<string>();
  /** Whether the initial startup shell prompt has been dismissed. */
  private readonly pastStartup = new Set<string>();
  /** Sessions whose terminal was just focused -- suppress false "running" */
  private readonly focusSuppressed = new Set<string>();
  /** Timestamps of recent data events with real content, per session. */
  private readonly dataTimestamps = new Map<string, number[]>();
  /** Pending "running" transition timers -- require sustained data before committing. */
  private readonly pendingRunning = new Map<string, NodeJS.Timeout>();
  /** Global resize suppression -- when non-zero, all status changes blocked. */
  private resizeSuppressedUntil = 0;
  /** Track recent data events across sessions to detect resize bursts. */
  private recentDataSessions = new Map<string, number>();
  private burstCheckTimer: NodeJS.Timeout | null = null;
  /** Snapshot of stripped buffer tail per session -- used to detect redraws (same content). */
  private readonly bufferSnapshots = new Map<string, string>();
  /** Cached last response file content per session -- survives file clearing. */
  private readonly lastResponse = new Map<string, string>();
  /** Last known response file mtime per session — used by poller to detect changes. */
  private readonly lastFileMtime = new Map<string, number>();
  /** Polling interval for response files (works when VS Code is backgrounded). */
  private pollTimer: NodeJS.Timeout | null = null;
  private disposable: vscode.Disposable | undefined;

  private readonly _onCompletion = new vscode.EventEmitter<CompletionEvent>();
  readonly onCompletion = this._onCompletion.event;

  private readonly _onExited = new vscode.EventEmitter<string>();
  readonly onExited = this._onExited.event;

  constructor(private readonly sessionManager: SessionManager) {}

  private isGloballySuppressed(): boolean {
    return Date.now() < this.resizeSuppressedUntil;
  }

  /** Debug output channel for orchestration troubleshooting */
  private debugChannel?: vscode.OutputChannel;

  setDebugChannel(channel: vscode.OutputChannel): void {
    this.debugChannel = channel;
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [OutputDetector] ${msg}`;
    console.log(line);
    this.debugChannel?.appendLine(line);
  }

  start(): vscode.Disposable {
    const log = (...args: any[]) => this.log(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

    // --- Resize suppression ---
    // VS Code doesn't expose onDidChangeTerminalDimensions publicly.
    // Instead, detect resize by observing simultaneous data bursts across
    // multiple idle sessions (resize redraws all visible terminals at once).
    // This is handled inside the data handler via lastGlobalDataBurst tracking.

    // --- Focus suppression ---
    const focusDisposable = vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) { return; }
      const session = this.sessionManager.findSessionByTerminal(terminal);
      if (!session) { return; }
      this.focusSuppressed.add(session.id);
      setTimeout(() => this.focusSuppressed.delete(session.id), 500);
    });

    // --- Main data handler ---
    const dataDisposable = vscode.window.onDidWriteTerminalData((e) => {
      const session = this.sessionManager.findSessionByTerminal(e.terminal);
      if (!session) { return; }

      const id = session.id;
      const rawLen = e.data.length;
      const strippedChunk = stripAnsi(e.data).trim();

      // --- Multi-session burst detection (resize indicator) ---
      // If 2+ different non-running sessions fire data within 100ms, it's a resize.
      const now = Date.now();
      if (session.status !== 'running') {
        this.recentDataSessions.set(id, now);
        if (!this.burstCheckTimer) {
          this.burstCheckTimer = setTimeout(() => {
            this.burstCheckTimer = null;
            const cutoff = Date.now() - 100;
            let burstCount = 0;
            for (const [sid, ts] of this.recentDataSessions) {
              if (ts >= cutoff) { burstCount++; }
              else { this.recentDataSessions.delete(sid); }
            }
            if (burstCount >= 2) {
              this.resizeSuppressedUntil = Date.now() + RESIZE_SUPPRESS_MS;
              for (const [pid, timer] of this.pendingRunning) {
                clearTimeout(timer);
                this.pendingRunning.delete(pid);
              }
              this.dataTimestamps.clear();
              log(`RESIZE detected (${burstCount} sessions fired) -- suppressing for ${RESIZE_SUPPRESS_MS}ms`);
            }
            this.recentDataSessions.clear();
          }, 100);
        }
      }

      // Buffer incoming data (for output previews & completion extraction)
      let buf = (this.buffers.get(id) || '') + e.data;
      if (buf.length > 10240) { buf = buf.slice(-10240); }
      this.buffers.set(id, buf);

      // Cancel any pending exit timer -- new data resets the clock
      this.clearExitTimer(id);

      // Detect Claude Code startup banner
      if (!this.pastStartup.has(id) && strippedChunk.includes('Claude') && strippedChunk.includes('Code')) {
        this.pastStartup.add(id);
        log(`STARTUP detected for session=${id}`);
      }

      // --- Determine if this data should be ignored for status purposes ---

      // Content dedup: if the session is NOT running, compare stripped buffer
      // content before and after. A resize/redraw re-renders the same text,
      // so the meaningful content (words) doesn't change.
      let isContentRedraw = false;
      if (session.status !== 'running' && strippedChunk.length > 0) {
        const prevSnapshot = this.bufferSnapshots.get(id) || '';
        const currentStripped = stripAnsi(this.buffers.get(id) || '');
        // Extract just the words (ignore whitespace/line breaks that change on resize)
        const prevWords = prevSnapshot.replace(/\s+/g, ' ').trim().slice(-500);
        const currentWords = currentStripped.replace(/\s+/g, ' ').trim().slice(-500);
        // If the words are the same or the new content is a subset, it's a redraw
        if (prevWords.length > 50 && (currentWords === prevWords || prevWords.endsWith(currentWords.slice(-200)) || currentWords.endsWith(prevWords.slice(-200)))) {
          isContentRedraw = true;
        }
        // Update snapshot
        this.bufferSnapshots.set(id, currentStripped);
      }

      const isSuppressed = this.isGloballySuppressed()
        || this.focusSuppressed.has(id)
        || isContentRedraw
        || (rawLen > 200 && strippedChunk.length / rawLen < 0.2)
        || (rawLen > 50 && strippedChunk.length === 0);

      if (isSuppressed) {
        // Don't cancel idle timer for suppressed data -- let idle detection continue
        if (strippedChunk.length > 10) {
          const reason = this.isGloballySuppressed() ? 'global-resize'
            : this.focusSuppressed.has(id) ? 'focus'
            : isContentRedraw ? 'content-redraw'
            : 'ansi-ratio';
          log(`DATA SUPPRESSED for ${session.name}: reason=${reason} rawLen=${rawLen} strippedLen=${strippedChunk.length}`);
        }
        return;
      }
      // Update snapshot when we have real new data
      if (strippedChunk.length > 0) {
        this.bufferSnapshots.set(id, stripAnsi(this.buffers.get(id) || ''));
      }

      // Cancel idle timer only for real data
      this.clearIdleTimer(id);

      // --- Immediate input prompt detection ---
      // Check buffer tail for input prompts regardless of current status.
      // This catches prompts that arrive as a single burst (not enough events
      // for the "running" threshold) like tool approval / overwrite prompts.
      if (this.pastStartup.has(id) && session.status !== 'exited' && session.status !== 'paused') {
        const bufTail = stripAnsi(this.buffers.get(id) || '').slice(-500);
        if (this.isInputPrompt(bufTail)) {
          if (session.autoApprove) {
            log(`AUTO-APPROVE (immediate): sending Enter for session=${id}`);
            session.terminal.sendText('', true);
          } else if (session.status !== 'input_needed') {
            log(`STATUS CHANGE: ${session.status} -> input_needed for session=${id} (immediate)`);
            this.sessionManager.setSessionStatus(id, 'input_needed');
            this.bufferSnapshots.set(id, stripAnsi(this.buffers.get(id) || ''));
          }
          return;
        }
      }

      // Check for shell prompt (exit detection)
      if (this.pastStartup.has(id) && this.isShellPrompt(strippedChunk)) {
        log(`SHELL_PROMPT detected for session=${id}, starting exit timer`);
        const exitTimer = setTimeout(() => {
          this.exitTimers.delete(id);
          const tail = stripAnsi(this.buffers.get(id) || '').slice(-300);
          if (this.isShellPrompt(tail)) {
            log(`EXIT confirmed for session=${id}`);
            this._onExited.fire(id);
          }
        }, EXIT_CONFIRM_MS);
        this.exitTimers.set(id, exitTimer);
        return;
      }

      // --- "Running" detection with sustained data requirement ---
      if (strippedChunk.length > 0 && session.status !== 'exited') {
        this.seenActivity.add(id);

        if (session.status !== 'running') {
          // Record this data event timestamp
          const now = Date.now();
          const timestamps = this.dataTimestamps.get(id) || [];
          timestamps.push(now);
          // Keep only events within the window
          const cutoff = now - RUNNING_WINDOW_MS;
          const recent = timestamps.filter(t => t >= cutoff);
          this.dataTimestamps.set(id, recent);

          if (recent.length >= RUNNING_DATA_THRESHOLD) {
            // Sustained data flow confirmed -- transition to running immediately
            this.cancelPendingRunning(id);
            this.dataTimestamps.delete(id);
            log(`STATUS CHANGE: ${session.status} -> running for session=${id} (sustained: ${recent.length} events in ${RUNNING_WINDOW_MS}ms)`);
            this.sessionManager.setSessionStatus(id, 'running');
          } else if (!this.pendingRunning.has(id)) {
            // Not enough events yet -- set a deferred timer.
            // If more data arrives and hits the threshold, this gets cancelled and
            // the immediate path above fires. If data stops (single burst = redraw),
            // the timer fires and we DON'T transition.
            const timer = setTimeout(() => {
              this.pendingRunning.delete(id);
              // Timer expired without hitting threshold -- treat as redraw/noise
              this.dataTimestamps.delete(id);
            }, RUNNING_WINDOW_MS);
            this.pendingRunning.set(id, timer);
          }
        }
      }

      // Set idle timer for real data
      const idleTimer = setTimeout(() => {
        this.idleTimers.delete(id);
        const currentSession = this.sessionManager.getSession(id);
        if (!currentSession) {
          log(`IDLE TIMER: session ${id} gone`);
          return;
        }
        if (currentSession.status !== 'running') {
          log(`IDLE TIMER: session ${id} (${currentSession.name}) status="${currentSession.status}" (not running) — checking for completion anyway`);
          // Even if not "running", if the agent has a response file with content, fire completion.
          // This handles cases where the agent completed so fast it never met the running threshold.
          if (currentSession.status === 'waiting' || currentSession.status === 'input_needed') {
            // Already handled or will be handled
          } else if (this.pastStartup.has(id) && this.seenActivity.has(id) && !isCompletionSuppressed(id)) {
            const response = this.readResponse(id);
            if (response && response.length > 0) {
              log(`IDLE TIMER: firing LATE completion for "${currentSession.name}" (status was "${currentSession.status}", response ${response.length} chars)`);
              this.sessionManager.setSessionStatus(id, 'waiting');
              this._onCompletion.fire({ sessionId: id, response });
            }
          }
          return;
        }

        // Check for interactive input prompt
        const tail = stripAnsi(this.buffers.get(id) || '').slice(-500);
        if (this.isInputPrompt(tail)) {
          // Auto-approve: send Enter to accept the default (usually "Yes")
          if (currentSession.autoApprove) {
            log(`AUTO-APPROVE: sending Enter for session=${id}`);
            currentSession.terminal.sendText('', true);
            return;
          }
          log(`STATUS CHANGE: running -> input_needed for session=${id}`);
          this.sessionManager.setSessionStatus(id, 'input_needed');
          this.bufferSnapshots.set(id, stripAnsi(this.buffers.get(id) || ''));
          return;
        }

        log(`STATUS CHANGE: running -> waiting for session=${id} (${currentSession.name}) (idle timeout ${IDLE_TIMEOUT_MS}ms)`);
        this.sessionManager.setSessionStatus(id, 'waiting');
        // Snapshot buffer so resize redraws can be detected as duplicate content
        this.bufferSnapshots.set(id, stripAnsi(this.buffers.get(id) || ''));

        // Fire completion event (only after Claude Code has fully started)
        if (!isCompletionSuppressed(id) && this.seenActivity.has(id) && this.pastStartup.has(id)) {
          const response = this.readResponse(id);
          log(`COMPLETION CHECK: suppressed=${isCompletionSuppressed(id)} activity=${this.seenActivity.has(id)} pastStartup=${this.pastStartup.has(id)} responseLen=${response?.length ?? 0}`);
          if (response && response.length > 0) {
            log(`FIRING COMPLETION for "${currentSession.name}": ${response.slice(0, 100).replace(/\n/g, '\\n')}...`);
            this._onCompletion.fire({ sessionId: id, response });
          } else {
            log(`NO COMPLETION: response empty for "${currentSession.name}"`);
          }
        } else {
          log(`COMPLETION SKIPPED for "${currentSession.name}": suppressed=${isCompletionSuppressed(id)} activity=${this.seenActivity.has(id)} pastStartup=${this.pastStartup.has(id)}`);
        }
      }, IDLE_TIMEOUT_MS);
      this.idleTimers.set(id, idleTimer);
    });

    this.disposable = {
      dispose: () => {
        focusDisposable.dispose();
        dataDisposable.dispose();
      }
    };
    return this.disposable;
  }

  /** Junk patterns from Claude Code TUI that shouldn't appear in node previews */
  private static readonly JUNK_LINE = /^[-─━═╌┄·•]{3,}$|^\[Team|^\[From|^PS [A-Z]:|^claude\b|^>\s*$|^\d+\.\s*(Yes|No)\b|^Esc to|^Tab to|^\s*[▝▜▘█▛]+/;

  getLastLines(sessionId: string, count = 3): string[] {
    // Prefer cached response (survives file clearing)
    const cached = this.lastResponse.get(sessionId);
    if (cached) {
      return cached.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).slice(-count);
    }

    // Fallback: terminal buffer with junk filtering
    const buf = this.buffers.get(sessionId);
    if (!buf) { return []; }
    const clean = stripAnsi(buf);
    const lines = clean.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !OutputDetector.JUNK_LINE.test(l));
    return lines.slice(-count);
  }

  getAllLastLines(count = 3): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [id] of this.buffers) {
      result[id] = this.getLastLines(id, count);
    }
    return result;
  }

  markAdopted(sessionId: string): void {
    this.pastStartup.add(sessionId);
    this.seenActivity.add(sessionId);
  }

  /**
   * Start polling response files every 3s.
   * Works even when VS Code is backgrounded and terminal data events stop.
   */
  startResponsePoller(): void {
    if (this.pollTimer) return;
    this.log('POLLER: started (3s interval)');
    this.pollTimer = setInterval(() => this.pollResponseFiles(), 3000);
  }

  private pollResponseFiles(): void {
    for (const session of this.sessionManager.getSessions()) {
      if (!session.responseFile) continue;
      if (!this.pastStartup.has(session.id)) continue;
      // Don't skip "running" — when IDE is backgrounded, terminal data events
      // stop flowing so status stays stuck at "running". The poller is the
      // backup that detects completion via the response file.
      if (session.status === 'exited' || session.status === 'paused') continue;
      if (isCompletionSuppressed(session.id)) continue;

      try {
        if (!fs.existsSync(session.responseFile)) continue;
        const stat = fs.statSync(session.responseFile);
        const mtime = stat.mtimeMs;
        const lastMtime = this.lastFileMtime.get(session.id) ?? 0;

        // Skip if file hasn't changed
        if (mtime <= lastMtime) continue;

        const raw = fs.readFileSync(session.responseFile, 'utf-8').trim();
        if (raw.length === 0) continue;

        const ageMs = Date.now() - mtime;
        if (ageMs > 60_000) { this.lastFileMtime.set(session.id, mtime); continue; }
        // Wait for agent to finish writing — skip if file was just modified (< 2s ago)
        // Don't update lastFileMtime yet so the next poll retries this file
        if (ageMs < 2000) continue;

        // Parse JSON response (MCP server writes structured JSON)
        let content: string;
        try {
          const parsed = JSON.parse(raw);
          content = parsed.content || raw;
        } catch {
          // Backwards compat: treat as plain text
          content = raw;
        }

        if (!content.trim()) continue;

        // File is ready — record mtime so we don't process it again
        this.lastFileMtime.set(session.id, mtime);

        this.log(`POLLER: ${session.name} — new response (${content.length} chars, ${ageMs}ms old, status=${session.status})`);

        // Cache for graph preview, then clear file
        this.lastResponse.set(session.id, content);
        try { fs.unlinkSync(session.responseFile); } catch {}

        // Set status to waiting if needed
        if (session.status !== 'waiting') {
          this.sessionManager.setSessionStatus(session.id, 'waiting');
        }

        this.log(`POLLER: FIRING COMPLETION for "${session.name}": ${content.slice(0, 100).replace(/\n/g, '\\n')}...`);
        this._onCompletion.fire({ sessionId: session.id, response: content });
      } catch {}
    }
  }

  clearBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.bufferSnapshots.delete(sessionId);
    this.lastResponse.delete(sessionId);
    this.lastFileMtime.delete(sessionId);
    this.clearIdleTimer(sessionId);
    this.clearExitTimer(sessionId);
    this.cancelPendingRunning(sessionId);
    this.dataTimestamps.delete(sessionId);
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

  private cancelPendingRunning(id: string): void {
    const timer = this.pendingRunning.get(id);
    if (timer) { clearTimeout(timer); this.pendingRunning.delete(id); }
  }

  private isShellPrompt(text: string): boolean {
    const tail = text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(-3).join('\n');
    return SHELL_PROMPT_PATTERNS.some(re => re.test(tail));
  }

  private isInputPrompt(text: string): boolean {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(-10).join('\n');
    return INPUT_PROMPT_PATTERNS.some(re => re.test(lines));
  }

  /**
   * Read the agent's response from its JSON response file (written by MCP server).
   * Falls back to terminal buffer tail only if no response file exists.
   */
  private readResponse(sessionId: string): string {
    const session = this.sessionManager.getSession(sessionId);

    // Try response file first (JSON format from MCP server's send_response tool)
    if (session?.responseFile) {
      try {
        const exists = fs.existsSync(session.responseFile);
        this.log(`readResponse(${session.name}): file=${session.responseFile} exists=${exists}`);
        if (exists) {
          const raw = fs.readFileSync(session.responseFile, 'utf-8').trim();
          const stat = fs.statSync(session.responseFile);
          const ageMs = Date.now() - stat.mtimeMs;
          this.log(`readResponse(${session.name}): rawLen=${raw.length} chars, age=${ageMs}ms`);
          if (raw.length > 0) {
            if (ageMs < 60_000) {
              // Parse JSON to extract content
              let content: string;
              try {
                const parsed = JSON.parse(raw);
                content = parsed.content || raw;
              } catch {
                content = raw; // backwards compat: plain text
              }
              // Cache for graph preview, then delete file
              this.lastResponse.set(sessionId, content);
              this.lastFileMtime.set(sessionId, stat.mtimeMs); // prevent poller re-read
              try { fs.unlinkSync(session.responseFile); } catch {}
              this.log(`readResponse(${session.name}): USING FILE — ${content.length} chars`);
              return content;
            } else {
              this.log(`readResponse(${session.name}): file too old (${ageMs}ms > 60000ms)`);
            }
          } else {
            this.log(`readResponse(${session.name}): file empty`);
          }
        }
      } catch (err: any) {
        this.log(`readResponse(${session.name}): file error: ${err.message}`);
      }
    } else {
      this.log(`readResponse(${sessionId.slice(-6)}): no responseFile set`);
    }

    // Fallback: terminal buffer tail (only for agents without MCP)
    const clean = stripAnsi(this.buffers.get(sessionId) || '');
    const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const fallback = lines.slice(-20).join('\n');
    this.log(`readResponse(${session?.name ?? sessionId.slice(-6)}): FALLBACK terminal buffer — ${fallback.length} chars`);
    return fallback;
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) { clearTimeout(timer); }
    for (const timer of this.exitTimers.values()) { clearTimeout(timer); }
    for (const timer of this.pendingRunning.values()) { clearTimeout(timer); }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.burstCheckTimer) { clearTimeout(this.burstCheckTimer); }
    this.idleTimers.clear();
    this.exitTimers.clear();
    this.pendingRunning.clear();
    this.lastFileMtime.clear();
    this.dataTimestamps.clear();
    this.recentDataSessions.clear();
    this.buffers.clear();
    this.bufferSnapshots.clear();
    this.lastResponse.clear();
    this.seenActivity.clear();
    this.pastStartup.clear();
    this.focusSuppressed.clear();
    this._onCompletion.dispose();
    this._onExited.dispose();
    this.disposable?.dispose();
  }
}
