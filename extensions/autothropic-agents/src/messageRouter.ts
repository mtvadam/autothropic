import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionManager } from './sessionManager';
import { suppressSession } from './outputDetector';

const SUPPRESS_MS = 5000;
const MSG_DIR = path.join(os.tmpdir(), 'autothropic-msg');

// Wipe and recreate message directory on startup — clears stale messages from previous sessions
try { fs.rmSync(MSG_DIR, { recursive: true, force: true }); } catch {}
try { fs.mkdirSync(MSG_DIR, { recursive: true }); } catch {}

/**
 * Sends a structured message to a session's Claude Code prompt.
 *
 * Writes a JSON message file and sends a short nudge via terminal stdin
 * telling the agent to use the `read_message` MCP tool. This approach is:
 * - Reliable when IDE is backgrounded (PTY stdin is always open)
 * - Not rejected as prompt injection (agent expects MCP-based messages)
 * - Clean structured JSON instead of raw terminal buffer content
 */
export function sendToSession(
  sessionManager: SessionManager,
  targetId: string,
  message: string,
  meta?: { fromName?: string; fromRole?: string },
): void {
  const session = sessionManager.getSession(targetId);
  if (!session) { return; }

  suppressSession(targetId, SUPPRESS_MS);

  // Write structured JSON message file
  try {
    const msgFile = path.join(MSG_DIR, `msg-${targetId.slice(-8)}-${Date.now()}.json`);
    const payload = {
      from: meta?.fromName || 'System',
      fromRole: meta?.fromRole || 'Agent',
      timestamp: new Date().toISOString(),
      content: message,
    };
    fs.writeFileSync(msgFile, JSON.stringify(payload, null, 2), 'utf-8');

    // Short atomic nudge — tells agent to use MCP tool to read the message
    const filePath = msgFile.replace(/\\/g, '/');
    session.terminal.sendText(
      `New message from ${payload.from}. Use the read_message tool with file: "${filePath}"`,
      true,
    );

    // Clean up after 120s
    setTimeout(() => {
      try { fs.unlinkSync(msgFile); } catch {}
    }, 120_000);
  } catch {
    // Fallback: send short message directly
    const short = message.length > 400 ? message.slice(0, 400) + '...' : message;
    session.terminal.sendText(short.replace(/\n/g, ' '), true);
  }
}

/**
 * Appends text to a session's terminal input without pressing Enter.
 * The user can then type additional context before submitting.
 */
export function appendToSessionInput(sessionManager: SessionManager, targetId: string, text: string): void {
  const session = sessionManager.getSession(targetId);
  if (!session) { return; }

  // Show and focus the terminal first so the user sees the text being inserted
  session.terminal.show(false); // false = take focus
  // Small delay to let the terminal gain focus before sending text
  setTimeout(() => {
    session.terminal.sendText(text, false);
  }, 150);
}

export interface QueuedMessage {
  targetId: string;
  message: string;
  sourceName: string;
  fromSessionId: string;
  toSessionId: string;
  extracted: string;
  timestamp: number;
}

/**
 * MessageQueue manages pending messages for busy agents.
 * Messages expire after 60s unless the target is paused.
 */
export class MessageQueue {
  private queue: QueuedMessage[] = [];

  enqueue(msg: QueuedMessage): void {
    this.queue.push(msg);
  }

  /**
   * Drain deliverable messages. Returns messages that were delivered.
   * Messages targeting paused sessions stay in the queue.
   * Expired messages (>60s, non-paused target) are discarded.
   */
  drain(sessionManager: SessionManager): QueuedMessage[] {
    if (this.queue.length === 0) { return []; }

    const now = Date.now();
    const stillQueued: QueuedMessage[] = [];
    const delivered: QueuedMessage[] = [];

    const pausedIds = new Set(
      sessionManager.getSessions()
        .filter(s => s.status === 'paused')
        .map(s => s.id)
    );
    const idleIds = new Set(
      sessionManager.getSessions()
        .filter(s => s.status === 'waiting')
        .map(s => s.id)
    );

    for (const qm of this.queue) {
      // Keep messages for paused sessions
      if (pausedIds.has(qm.targetId)) {
        stillQueued.push(qm);
        continue;
      }

      // Expire old messages for non-paused targets
      if (now - qm.timestamp > 60_000) {
        continue;
      }

      if (idleIds.has(qm.targetId)) {
        // Target is idle — deliver
        sendToSession(sessionManager, qm.targetId, qm.message);
        sessionManager.setSessionStatus(qm.targetId, 'running');
        sessionManager.addMessage({
          id: `${Date.now()}-${qm.fromSessionId}-${qm.toSessionId}`,
          fromSessionId: qm.fromSessionId,
          toSessionId: qm.toSessionId,
          content: qm.extracted,
          timestamp: Date.now(),
        });
        delivered.push(qm);
        idleIds.delete(qm.targetId);
      } else {
        stillQueued.push(qm);
      }
    }

    this.queue = stillQueued;
    return delivered;
  }

  get length(): number {
    return this.queue.length;
  }
}
