import * as vscode from 'vscode';
import type { SessionManager } from './sessionManager';
import type { SessionEdge } from './types';
import type { CompletionEvent } from './outputDetector';
import type { HITLManager } from './hitlManager';
import { sendToSession, MessageQueue } from './messageRouter';

// --- Rate Limiting ---
const SOURCE_COOLDOWN_MS = 5_000;
const TARGET_COOLDOWN_MS = 10_000;
const GLOBAL_WINDOW_MS = 60_000;
const MAX_FORWARDS_PER_WINDOW = 10;

// --- Smart Extraction ---
const MAX_FORWARD_CHARS = 2500;
const MAX_FORWARD_LINES = 40;

// --- Condition Detection Patterns ---
const CODE_CHANGE_PATTERNS = [
	/\b(created|wrote|updated|modified|edited|changed|deleted|removed|added)\b.*\.(ts|tsx|js|jsx|py|rs|go|css|html|json|md|yaml|yml|toml)\b/i,
	/\b(file|files)\s+(created|updated|modified|written|saved)/i,
	/wrote to\s+/i,
	/\bEdit\b.*\bfile\b/i,
	/\bgit (add|commit|diff)\b/i,
];

const ERROR_PATTERNS = [
	/\b(error|Error|ERROR)\b/,
	/\b(fail|failed|failure|FAIL)\b/i,
	/\b(exception|Exception)\b/,
	/\btraceback\b/i,
	/\bpanic\b/,
	/\bTypeError\b|\bSyntaxError\b|\bReferenceError\b|\bRuntimeError\b/,
	/\bcompilation\s+failed\b/i,
	/\bbuild\s+failed\b/i,
	/\bexit\s+code\s+[1-9]/i,
];

function matchesCondition(text: string, condition: SessionEdge['condition']): boolean {
	switch (condition) {
		case 'all':
			return true;
		case 'code-changes':
			return CODE_CHANGE_PATTERNS.some(p => p.test(text));
		case 'errors':
			return ERROR_PATTERNS.some(p => p.test(text));
		case 'summary-only':
			return true;
		default:
			return true;
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function cleanTerminalOutput(text: string): string {
	let clean = stripAnsi(text);
	clean = clean.replace(/\r\n/g, '\n');
	clean = clean.replace(/\r/g, '\n');
	clean = clean.replace(/\0/g, '');
	clean = clean.replace(/\n{3,}/g, '\n\n');
	return clean.trim();
}

/**
 * Smart extraction: processes raw output to extract the most meaningful,
 * clean portion for downstream agents.
 */
function smartExtract(text: string, summaryOnly = false): string {
	const clean = cleanTerminalOutput(text);
	const lines = clean.split('\n');

	const summaryPatterns = [
		/^#{1,3}\s*(summary|result|conclusion|output|next steps|done|complete)/i,
		/^(summary|result|conclusion|in summary|to summarize)\s*[:\-]/i,
		/^(here'?s? (what|a summary)|i'?ve? (completed|finished|done|made|created))/i,
		/^(changes made|files? (modified|changed|created|updated))\s*[:\-]?/i,
	];

	if (summaryOnly) {
		for (let i = Math.max(0, lines.length - MAX_FORWARD_LINES); i < lines.length; i++) {
			if (summaryPatterns.some(p => p.test(lines[i].trim()))) {
				const summary = lines.slice(i).join('\n').trim();
				if (summary.length <= MAX_FORWARD_CHARS && summary.length > 30) {
					return `[${lines.length} lines total - showing summary]\n\n${summary}`;
				}
			}
		}
		return lines.slice(-10).join('\n').trim();
	}

	if (clean.length <= MAX_FORWARD_CHARS && lines.length <= MAX_FORWARD_LINES) {
		return clean;
	}

	for (let i = Math.max(0, lines.length - MAX_FORWARD_LINES); i < lines.length; i++) {
		if (summaryPatterns.some(p => p.test(lines[i].trim()))) {
			const summary = lines.slice(i).join('\n').trim();
			if (summary.length <= MAX_FORWARD_CHARS && summary.length > 30) {
				return `[${lines.length} lines total - showing summary]\n\n${summary}`;
			}
		}
	}

	const tail = lines.slice(-MAX_FORWARD_LINES);
	let result = tail.join('\n').trim();

	if (result.length > MAX_FORWARD_CHARS) {
		result = result.slice(-MAX_FORWARD_CHARS);
		const firstNewline = result.indexOf('\n');
		if (firstNewline > 0 && firstNewline < 100) {
			result = result.slice(firstNewline + 1);
		}
	}

	const omitted = lines.length - MAX_FORWARD_LINES;
	return omitted > 0
		? `[...${omitted} lines omitted - showing last ${MAX_FORWARD_LINES}]\n\n${result}`
		: result;
}

function simpleHash(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return hash;
}

/**
 * Split text into task items by detecting numbered lists, bullet lists,
 * or section headers. Returns null if no splittable structure found.
 */
function splitIntoTasks(text: string): string[] | null {
	const lines = text.split('\n');

	// Try numbered list: "1. ...", "2. ...", "1) ...", etc.
	const numbered = lines.filter(l => /^\s*\d+[\.\)]\s+\S/.test(l));
	if (numbered.length >= 2) {
		// Group: each numbered item + following indented/empty lines until next number
		const tasks: string[] = [];
		let current = '';
		for (const line of lines) {
			if (/^\s*\d+[\.\)]\s+\S/.test(line)) {
				if (current.trim()) tasks.push(current.trim());
				current = line.replace(/^\s*\d+[\.\)]\s+/, '');
			} else if (current) {
				current += '\n' + line;
			}
		}
		if (current.trim()) tasks.push(current.trim());
		if (tasks.length >= 2) return tasks;
	}

	// Try bullet list: "- ...", "* ...", "• ..."
	const bullets = lines.filter(l => /^\s*[-*•]\s+\S/.test(l));
	if (bullets.length >= 2) {
		const tasks: string[] = [];
		let current = '';
		for (const line of lines) {
			if (/^\s*[-*•]\s+\S/.test(line)) {
				if (current.trim()) tasks.push(current.trim());
				current = line.replace(/^\s*[-*•]\s+/, '');
			} else if (current) {
				current += '\n' + line;
			}
		}
		if (current.trim()) tasks.push(current.trim());
		if (tasks.length >= 2) return tasks;
	}

	// Try markdown headers: "## Task 1", "## Task 2"
	const headers = lines.filter(l => /^#{1,3}\s+\S/.test(l));
	if (headers.length >= 2) {
		const tasks: string[] = [];
		let current = '';
		for (const line of lines) {
			if (/^#{1,3}\s+\S/.test(line)) {
				if (current.trim()) tasks.push(current.trim());
				current = line;
			} else {
				current += '\n' + line;
			}
		}
		if (current.trim()) tasks.push(current.trim());
		if (tasks.length >= 2) return tasks;
	}

	return null;
}

/**
 * OrchestrationEngine monitors session completions and auto-forwards
 * output to downstream sessions via edges.
 *
 * Features:
 * - Conditional forwarding (all, code-changes, errors, summary-only)
 * - Iteration caps on edges
 * - Message queue for busy targets
 * - Rate limiting (global, per-source, per-target)
 * - HITL routing for human approval
 * - Activity logging
 */
export class OrchestrationEngine {
	private consumed = new Set<string>();
	private logged = new Set<string>();
	private cooldowns = new Map<string, number>();
	private globalForwards: number[] = [];
	private messageQueue = new MessageQueue();
	private disposables: vscode.Disposable[] = [];
	readonly debugChannel: vscode.OutputChannel;
	/** Startup grace period — ignore completions until agents have stabilized after restore. */
	private startupUntil = Date.now() + 10_000;

	constructor(
		private readonly sessionManager: SessionManager,
		private readonly hitlManager: HITLManager,
	) {
		this.debugChannel = vscode.window.createOutputChannel('Autothropic Orchestration');
	}

	private log(msg: string): void {
		const ts = new Date().toISOString().slice(11, 23);
		this.debugChannel.appendLine(`[${ts}] ${msg}`);
	}

	start(): void {
		this.disposables.push(
			this.sessionManager.onChanged(() => {
				this.drainQueue();
			})
		);
	}

	handleCompletion(event: CompletionEvent): void {
		const { sessionId, response } = event;
		const now = Date.now();

		// Startup grace period: ignore completions while agents are restoring/stabilizing
		if (now < this.startupUntil) {
			this.log(`SKIP (startup grace): completion from ${sessionId.slice(-6)} ignored — ${Math.ceil((this.startupUntil - now) / 1000)}s remaining`);
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session) { this.log(`SKIP: session ${sessionId} not found`); return; }
		if (session.status === 'paused') { this.log(`SKIP: ${session.name} is paused`); return; }

		const sourceName = session.name;
		const sourceColor = session.color;
		const rawResponse = response.replace(/\u276f/g, '>');

		this.log(`COMPLETION from "${sourceName}" (${sessionId.slice(-6)})`);
		this.log(`  response (${response.length} chars): ${response.slice(0, 200).replace(/\n/g, '\\n')}${response.length > 200 ? '...' : ''}`);
		this.log(`  responseFile: ${session.responseFile ?? 'none'}`);

		const contentKey = `${sessionId}:${response.length}:${simpleHash(response)}`;

		// --- Activity Log ---
		if (!this.logged.has(contentKey)) {
			this.logged.add(contentKey);
			const summaryForLog = smartExtract(rawResponse);
			this.sessionManager.addActivityEntry({
				sessionId,
				sessionName: sourceName,
				sessionColor: sourceColor,
				timestamp: now,
				summary: summaryForLog,
			});
			if (this.logged.size > 200) {
				this.logged = new Set(Array.from(this.logged).slice(-100));
			}
		}

		// --- Forwarding ---
		if (this.consumed.has(contentKey)) { this.log(`  SKIP: already consumed (dedup)`); return; }

		const downstream = this.sessionManager.getDownstreamEdges(sessionId);
		if (downstream.length === 0) { this.log(`  SKIP: no downstream edges`); return; }

		this.log(`  ${downstream.length} downstream edge(s)`);

		this.globalForwards = this.globalForwards.filter(t => now - t < GLOBAL_WINDOW_MS);
		if (this.globalForwards.length >= MAX_FORWARDS_PER_WINDOW) {
			this.log(`  SKIP: global rate limit (${this.globalForwards.length}/${MAX_FORWARDS_PER_WINDOW})`);
			vscode.window.showWarningMessage('Orchestration rate limited.');
			return;
		}

		const lastForward = this.cooldowns.get(sessionId) || 0;
		if (now - lastForward < SOURCE_COOLDOWN_MS) {
			this.log(`  SKIP: source cooldown (${now - lastForward}ms < ${SOURCE_COOLDOWN_MS}ms)`);
			return;
		}

		this.consumed.add(contentKey);
		this.cooldowns.set(sessionId, now);
		if (this.consumed.size > 200) {
			this.consumed = new Set(Array.from(this.consumed).slice(-100));
		}

		const forwardedTo: string[] = [];
		const queuedTo: string[] = [];
		const pendingHITL: string[] = [];

		// --- Split mode: divide tasks among downstream agents ---
		const isSplitMode = session.fanoutMode === 'split' && downstream.length >= 2;
		let splitTasks: string[] | null = null;
		if (isSplitMode) {
			splitTasks = splitIntoTasks(rawResponse);
			if (splitTasks) {
				this.log(`  SPLIT MODE: found ${splitTasks.length} tasks for ${downstream.length} agents`);
			} else {
				this.log(`  SPLIT MODE: no splittable structure found, falling back to broadcast`);
			}
		}
		let splitIndex = 0;

		for (const edge of downstream) {
			const targetSession = this.sessionManager.getSession(edge.to);
			const targetName = targetSession?.name ?? edge.to.slice(-6);

			if (targetSession?.status === 'paused') { this.log(`  EDGE ${sourceName}->${targetName}: SKIP paused`); continue; }
			if (!matchesCondition(rawResponse, edge.condition)) { this.log(`  EDGE ${sourceName}->${targetName}: SKIP condition "${edge.condition}" not matched`); continue; }
			if (edge.maxIterations > 0 && edge.iterationCount >= edge.maxIterations) { this.log(`  EDGE ${sourceName}->${targetName}: SKIP iteration cap (${edge.iterationCount}/${edge.maxIterations})`); continue; }

			const targetLastReceived = this.cooldowns.get(`target:${edge.to}`) || 0;
			if (now - targetLastReceived < TARGET_COOLDOWN_MS) {
				this.log(`  EDGE ${sourceName}->${targetName}: SKIP target cooldown (${now - targetLastReceived}ms < ${TARGET_COOLDOWN_MS}ms)`);
				continue;
			}

			let extracted: string;
			if (splitTasks && splitTasks.length > 0) {
				// Assign tasks round-robin: collect all tasks for this agent
				const agentTasks: string[] = [];
				for (let i = splitIndex; i < splitTasks.length; i += downstream.length) {
					agentTasks.push(splitTasks[i]);
				}
				splitIndex++;
				extracted = agentTasks.length === 1
					? agentTasks[0]
					: agentTasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
				this.log(`  SPLIT: ${targetName} gets ${agentTasks.length} task(s)`);
			} else {
				extracted = smartExtract(rawResponse, edge.condition === 'summary-only');
			}
			const message = `[From ${sourceName}]: ${extracted}`;

			this.log(`  EDGE ${sourceName}->${targetName}: target status="${targetSession?.status}" hitl=${targetSession?.humanInLoop}`);
			this.log(`  extracted (${extracted.length} chars): ${extracted.slice(0, 150).replace(/\n/g, '\\n')}${extracted.length > 150 ? '...' : ''}`);

			if (edge.maxIterations > 0) {
				this.sessionManager.incrementEdgeIteration(edge.id);
			}

			this.cooldowns.set(`target:${edge.to}`, now);

			// HITL check
			if (targetSession?.humanInLoop) {
				this.hitlManager.enqueue({
					id: `hitl-${Date.now()}-${edge.from}-${edge.to}`,
					fromSessionId: edge.from,
					toSessionId: edge.to,
					fromSessionName: sourceName,
					toSessionName: targetName,
					fromSessionColor: sourceColor,
					summary: extracted,
					fullMessage: message,
					timestamp: Date.now(),
				});
				this.log(`  -> HITL queued for ${targetName}`);
				pendingHITL.push(targetName);
				continue;
			}

			// Queue if busy, send if idle
			if (targetSession?.status === 'running') {
				this.messageQueue.enqueue({
					targetId: edge.to,
					message,
					sourceName,
					fromSessionId: edge.from,
					toSessionId: edge.to,
					extracted,
					timestamp: now,
				});
				this.log(`  -> QUEUED for ${targetName} (busy)`);
				queuedTo.push(targetName);
				continue;
			}

			this.log(`  -> SENDING to ${targetName}: "${message.slice(0, 100)}..."`);
			sendToSession(this.sessionManager, edge.to, message, {
				fromName: sourceName,
				fromRole: session.systemPrompt?.slice(0, 60),
			});
			this.globalForwards.push(now);

			this.sessionManager.addMessage({
				id: `${Date.now()}-${edge.from}-${edge.to}`,
				fromSessionId: edge.from,
				toSessionId: edge.to,
				content: extracted,
				timestamp: Date.now(),
			});

			this.sessionManager.setSessionStatus(edge.to, 'running');
			forwardedTo.push(targetName);

			vscode.commands.executeCommand('_autothropic.graph.edgePulse', edge.from, edge.to).then(undefined, () => {});
		}

		if (forwardedTo.length > 0) {
			vscode.window.showInformationMessage(`${sourceName} \u2192 ${forwardedTo.join(', ')}`);
		}
		if (queuedTo.length > 0) {
			vscode.window.showInformationMessage(`${sourceName} \u2192 ${queuedTo.join(', ')} (queued)`);
		}
		if (pendingHITL.length > 0) {
			vscode.window.showWarningMessage(`${sourceName} \u2192 ${pendingHITL.join(', ')} (awaiting approval)`);
		}
	}

	private drainQueue(): void {
		const delivered = this.messageQueue.drain(this.sessionManager);
		if (delivered.length > 0) {
			const names = delivered.map(d => d.sourceName).join(', ');
			vscode.window.showInformationMessage(`Queue delivered: ${names}`);
		}
	}

	/** Show the debug output channel */
	showDebug(): void {
		this.debugChannel.show(true);
	}

	/** Dump current orchestration state to the debug channel */
	dumpState(): void {
		this.log('=== STARTUP / RESTORE LOG ===');
		for (const line of this.sessionManager._debugLog) {
			this.log(line);
		}
		this.log('');

		this.log('=== ORCHESTRATION STATE ===');
		const graceRemaining = this.startupUntil - Date.now();
		this.log(`startupGrace: ${graceRemaining > 0 ? `${Math.ceil(graceRemaining / 1000)}s remaining` : 'expired'}`);
		this.log(`consumed: ${this.consumed.size} entries`);
		this.log(`cooldowns: ${this.cooldowns.size} entries`);
		for (const [key, ts] of this.cooldowns) {
			this.log(`  ${key}: ${Date.now() - ts}ms ago`);
		}
		this.log(`globalForwards in window: ${this.globalForwards.length}/${MAX_FORWARDS_PER_WINDOW}`);
		this.log(`messageQueue: ${this.messageQueue.length} pending`);

		const sessions = this.sessionManager.getSessions();
		this.log(`\nsessions: ${sessions.length}`);
		for (const s of sessions) {
			this.log(`  ${s.name} (id=${s.id.slice(-8)} claude=${s.claudeSessionId?.slice(0, 8) ?? 'NONE'}):`);
			this.log(`    status=${s.status} color=${s.color} autoApprove=${!!s.autoApprove} hitl=${!!s.humanInLoop}`);
			this.log(`    responseFile=${s.responseFile ?? 'none'}`);
		}

		const edges = this.sessionManager.getEdges();
		this.log(`\nedges: ${edges.length}`);
		for (const e of edges) {
			const from = this.sessionManager.getSession(e.from)?.name ?? e.from.slice(-6);
			const to = this.sessionManager.getSession(e.to)?.name ?? e.to.slice(-6);
			this.log(`  ${from} -> ${to}: condition=${e.condition} iterations=${e.iterationCount}/${e.maxIterations}`);
		}
		this.log('=== END DUMP ===');
		this.debugChannel.show(true);
	}

	dispose(): void {
		for (const d of this.disposables) { d.dispose(); }
		this.debugChannel.dispose();
	}
}
