import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type {
	AgentSession, SessionEdge, SessionStatus, EdgeCondition,
	ActivityLogEntry, SessionMessage, SerializableSession, TopologyPreset,
} from './types';

/**
 * Escape a string for use as a PowerShell argument.
 * Collapses newlines to spaces and wraps in single quotes
 * (doubling internal single quotes per PowerShell rules).
 */
function escapeShellArg(arg: string): string {
	const oneLine = arg.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	return `'${oneLine.replace(/'/g, "''")}'`;
}

/**
 * Environment overrides for agent terminals.
 * Prevents Claude Code CLI from detecting VS Code and triggering window operations.
 * `null` means "delete from inherited environment".
 */
const AGENT_TERMINAL_ENV: Record<string, string | null> = {
	CLAUDECODE: null,
	TERM_PROGRAM: 'xterm-256color',      // Override VS Code's 'vscode' value
	TERM_PROGRAM_VERSION: null,           // Remove VS Code version
	VSCODE_IPC_HOOK_CLI: null,            // Remove CLI IPC pipe
	VSCODE_GIT_IPC_HANDLE: null,          // Remove git IPC
	VSCODE_GIT_ASKPASS_NODE: null,
	VSCODE_GIT_ASKPASS_EXTRA_ARGS: null,
	VSCODE_GIT_ASKPASS_MAIN: null,
	GIT_ASKPASS: null,
	ELECTRON_RUN_AS_NODE: null,
};

const AGENT_COLORS = [
	'#d97757', '#539bf5', '#57ab5a', '#9d4edd',
	'#D4A574', '#f28482', '#4cc9f0', '#d4876a',
];

/** Map agent hex colors to VS Code ThemeColor IDs for terminal tab icons. */
const COLOR_TO_THEME: Record<string, string> = {
	'#d97757': 'charts.orange',
	'#539bf5': 'charts.blue',
	'#57ab5a': 'charts.green',
	'#9d4edd': 'charts.purple',
	'#D4A574': 'charts.yellow',
	'#f28482': 'charts.red',
	'#4cc9f0': 'charts.blue',
	'#d4876a': 'charts.orange',
};

export const TOPOLOGY_PRESETS: TopologyPreset[] = [
	{
		id: 'pipeline',
		label: 'Pipeline',
		description: 'Sequential: A -> B -> C',
		nodes: [
			{ name: 'Analyst', role: 'You are an analyst. Examine the codebase, identify issues, and produce a clear report of findings for the next agent.', relativePos: { x: 0, y: 0 } },
			{ name: 'Builder', role: 'You are a builder/implementer. Take the analysis from the previous agent and implement the required changes. Write clean, working code.', relativePos: { x: 250, y: 0 } },
			{ name: 'Reviewer', role: 'You are a code reviewer. Review the implementation from the previous agent. Check for bugs, security issues, and code quality. Provide a final verdict.', relativePos: { x: 500, y: 0 } },
		],
		edges: [
			{ fromIndex: 0, toIndex: 1 },
			{ fromIndex: 1, toIndex: 2 },
		],
	},
	{
		id: 'star',
		label: 'Star (Leader + Workers)',
		description: 'Leader delegates to N workers',
		nodes: [
			{ name: 'Leader', role: 'You are the team leader. Coordinate work across agents. Break down tasks, delegate to workers, and synthesize their outputs into a cohesive result.', relativePos: { x: 250, y: 0 } },
			{ name: 'Worker 1', role: 'You are a task executor. Receive instructions from the leader, complete the assigned work thoroughly, and report your results.', relativePos: { x: 0, y: 200 } },
			{ name: 'Worker 2', role: 'You are a task executor. Receive instructions from the leader, complete the assigned work thoroughly, and report your results.', relativePos: { x: 250, y: 200 } },
			{ name: 'Worker 3', role: 'You are a task executor. Receive instructions from the leader, complete the assigned work thoroughly, and report your results.', relativePos: { x: 500, y: 200 } },
		],
		edges: [
			{ fromIndex: 0, toIndex: 1 },
			{ fromIndex: 0, toIndex: 2 },
			{ fromIndex: 0, toIndex: 3 },
			{ fromIndex: 1, toIndex: 0 },
			{ fromIndex: 2, toIndex: 0 },
			{ fromIndex: 3, toIndex: 0 },
		],
	},
	{
		id: 'fan-out-fan-in',
		label: 'Fan-out / Fan-in',
		description: 'Source -> parallel Workers -> Aggregator',
		nodes: [
			{ name: 'Source', role: 'You break down tasks into parallel sub-tasks. Clearly describe each sub-task so workers can execute independently.', relativePos: { x: 0, y: 100 } },
			{ name: 'Worker A', role: 'You are a specialist worker. Execute your assigned sub-task independently and report your results clearly.', relativePos: { x: 250, y: 0 } },
			{ name: 'Worker B', role: 'You are a specialist worker. Execute your assigned sub-task independently and report your results clearly.', relativePos: { x: 250, y: 200 } },
			{ name: 'Aggregator', role: 'You are an aggregator. Collect results from all workers, synthesize them into a unified output, resolve any conflicts, and produce the final result.', relativePos: { x: 500, y: 100 } },
		],
		edges: [
			{ fromIndex: 0, toIndex: 1 },
			{ fromIndex: 0, toIndex: 2 },
			{ fromIndex: 1, toIndex: 3 },
			{ fromIndex: 2, toIndex: 3 },
		],
	},
	{
		id: 'review-loop',
		label: 'Review Loop',
		description: 'Builder <-> Reviewer with iteration cap',
		nodes: [
			{ name: 'Builder', role: 'You are a builder/implementer. Write code to complete the task. If you receive review feedback, address every issue and resubmit.', relativePos: { x: 0, y: 0 } },
			{ name: 'Reviewer', role: 'You are a strict code reviewer. Review the code for bugs, security issues, and quality. If issues found, list them clearly. If the code passes review, say "APPROVED" clearly.', relativePos: { x: 300, y: 0 } },
		],
		edges: [
			{ fromIndex: 0, toIndex: 1 },
			{ fromIndex: 1, toIndex: 0, maxIterations: 3 },
		],
	},
];

// ---------------------------------------------------------------------------
// Docker agent isolation
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = 'autothropic-agent';

const DOCKERFILE_CONTENT = `FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git openssh-client curl wget ca-certificates \\
    build-essential python3 \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
`;

/** Env vars to forward into the Docker container for Claude auth. */
const DOCKER_PASSTHROUGH_ENV = [
	'ANTHROPIC_API_KEY',
	'CLAUDE_CODE_USE_BEDROCK',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_DEFAULT_REGION',
	'AWS_REGION',
	'AWS_PROFILE',
];

function generateId(): string {
	return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionManager {
	private sessions = new Map<string, AgentSession>();
	private edges = new Map<string, SessionEdge>();
	private activityLog: ActivityLogEntry[] = [];
	private messages: SessionMessage[] = [];
	private counter = 0;
	/** Terminals being disposed during restart - suppress handleTerminalClose cleanup. */
	private restartingTerminals = new Set<vscode.Terminal>();
	/** Persisted session metadata loaded on startup, used for terminal re-adoption. */
	private pendingAdoption: SerializableSession[] = [];
	private pendingEdges: SessionEdge[] = [];

	private readonly _onChanged = new vscode.EventEmitter<void>();
	readonly onChanged = this._onChanged.event;

	/** Cached Docker availability: null = unchecked */
	private _dockerAvailable: boolean | null = null;
	private _dockerImageReady = false;
	private _dockerInitializing = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.loadState();
	}

	// --- Docker ---

	/**
	 * Kick off Docker detection + image build in the background.
	 * Called once from extension activation.
	 */
	async initDocker(): Promise<void> {
		if (this._dockerInitializing) { return; }
		this._dockerInitializing = true;
		try {
			if (!this._checkDocker()) { return; }
			await this._ensureDockerImage();
		} finally {
			this._dockerInitializing = false;
		}
	}

	get dockerReady(): boolean {
		return this._dockerAvailable === true && this._dockerImageReady;
	}

	private _checkDocker(): boolean {
		if (this._dockerAvailable !== null) { return this._dockerAvailable; }
		try {
			execSync('docker info', { timeout: 10_000, stdio: 'pipe' });
			this._dockerAvailable = true;
		} catch {
			this._dockerAvailable = false;
		}
		return this._dockerAvailable;
	}

	private async _ensureDockerImage(): Promise<boolean> {
		if (this._dockerImageReady) { return true; }
		// Already built?
		try {
			execSync(`docker image inspect ${DOCKER_IMAGE}`, { timeout: 10_000, stdio: 'pipe' });
			this._dockerImageReady = true;
			return true;
		} catch { /* need to build */ }

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Building agent Docker image (first time only)...',
			cancellable: false,
		}, async () => {
			const tmpDir = path.join(os.tmpdir(), 'autothropic-docker');
			fs.mkdirSync(tmpDir, { recursive: true });
			const dockerfilePath = path.join(tmpDir, 'Dockerfile');
			fs.writeFileSync(dockerfilePath, DOCKERFILE_CONTENT);
			try {
				execSync(`docker build -t ${DOCKER_IMAGE} "${tmpDir}"`, {
					timeout: 600_000, // 10 minutes
					stdio: 'pipe',
				});
				this._dockerImageReady = true;
				return true;
			} catch (err) {
				vscode.window.showWarningMessage(
					`Docker image build failed — agents will run locally. ${err}`
				);
				this._dockerAvailable = false;
				return false;
			} finally {
				try { fs.unlinkSync(dockerfilePath); } catch { /* ok */ }
				try { fs.rmdirSync(tmpDir); } catch { /* ok */ }
			}
		});
	}

	/**
	 * Build the `docker run …` prefix for agent terminals.
	 * Mounts workspace, Claude config, git config, and SSH keys.
	 */
	private _dockerRunPrefix(cwd?: string): string {
		const workspace = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		const home = os.homedir();

		const parts = ['docker', 'run', '-it', '--rm'];

		if (workspace) {
			parts.push('-v', `"${workspace}:/workspace"`, '-w', '/workspace');
		}

		// Claude CLI config
		const claudeDir = path.join(home, '.claude');
		if (fs.existsSync(claudeDir)) {
			parts.push('-v', `"${claudeDir}:/root/.claude"`);
		}

		// Git config (read-only)
		const gitconfig = path.join(home, '.gitconfig');
		if (fs.existsSync(gitconfig)) {
			parts.push('-v', `"${gitconfig}:/root/.gitconfig:ro"`);
		}

		// SSH keys (read-only)
		const sshDir = path.join(home, '.ssh');
		if (fs.existsSync(sshDir)) {
			parts.push('-v', `"${sshDir}:/root/.ssh:ro"`);
		}

		// Forward API keys / auth env vars
		for (const key of DOCKER_PASSTHROUGH_ENV) {
			if (process.env[key]) {
				parts.push('-e', key);
			}
		}

		parts.push(DOCKER_IMAGE);
		return parts.join(' ');
	}

	/**
	 * Build the full command to send to a terminal.
	 * Uses Docker when available, falls back to local `claude`.
	 */
	agentCommand(systemPrompt?: string, cwd?: string): string {
		const promptArg = systemPrompt
			? ` --append-system-prompt ${escapeShellArg(systemPrompt)}`
			: '';

		if (this.dockerReady) {
			return `${this._dockerRunPrefix(cwd)} claude${promptArg}`;
		}
		return `claude${promptArg}`;
	}

	// --- Session CRUD ---

	createSession(name?: string, systemPrompt?: string, options?: { showTerminal?: boolean; cwd?: string }): AgentSession {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		this.counter++;
		const id = generateId();
		const color = AGENT_COLORS[(this.counter - 1) % AGENT_COLORS.length];
		const sessionName = name ?? `Agent ${this.nextAgentNumber()}`;

		const themeColorId = COLOR_TO_THEME[color] || 'charts.orange';
		const terminalCwd = options?.cwd
			? vscode.Uri.file(options.cwd)
			: workspaceFolder?.uri;
		const terminal = vscode.window.createTerminal({
			name: sessionName,
			cwd: terminalCwd,
			iconPath: new vscode.ThemeIcon('robot', new vscode.ThemeColor(themeColorId)),
			env: { ...AGENT_TERMINAL_ENV },
		});

		// Build the claude command with topology-aware system prompt
		const fullPrompt = this.buildSystemPrompt(systemPrompt);
		terminal.sendText(this.agentCommand(fullPrompt || undefined, options?.cwd));

		const session: AgentSession = {
			id,
			name: sessionName,
			terminal,
			status: 'waiting',
			color,
			graphPosition: { x: 200 + (this.counter - 1) * 220, y: 200 },
			systemPrompt: systemPrompt || undefined,
			createdAt: Date.now(),
			restartCount: 0,
			lastRestartAt: 0,
		};

		this.sessions.set(id, session);
		this.saveState();
		this._onChanged.fire();

		if (options?.showTerminal !== false) {
			terminal.show(false);
		}
		return session;
	}

	/** Find the lowest unused "Agent N" number. */
	nextAgentNumber(): number {
		const used = new Set<number>();
		for (const session of this.sessions.values()) {
			const m = session.name.match(/^Agent (\d+)$/);
			if (m) { used.add(parseInt(m[1], 10)); }
		}
		let n = 1;
		while (used.has(n)) { n++; }
		return n;
	}

	/** Find a session by its terminal instance. */
	getSessionByTerminal(terminal: vscode.Terminal): AgentSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.terminal === terminal) { return session; }
		}
		return undefined;
	}

	/** Adopt a terminal created by the profile provider into the session manager. */
	adoptTerminal(terminal: vscode.Terminal): AgentSession {
		this.counter++;
		const id = generateId();
		const color = AGENT_COLORS[(this.counter - 1) % AGENT_COLORS.length];
		const sessionName = terminal.name || `Agent ${this.nextAgentNumber()}`;

		const session: AgentSession = {
			id,
			name: sessionName,
			terminal,
			status: 'waiting',
			color,
			graphPosition: { x: 200 + (this.counter - 1) * 220, y: 200 },
			createdAt: Date.now(),
			restartCount: 0,
			lastRestartAt: 0,
		};

		this.sessions.set(id, session);
		this.saveState();
		this._onChanged.fire();
		return session;
	}

	/**
	 * Build a rich system prompt that includes topology awareness.
	 * Each agent gets context about the full team and its connections.
	 */
	private buildSystemPrompt(basePrompt?: string): string {
		const parts: string[] = [];

		if (basePrompt) {
			parts.push(basePrompt);
		}

		// Add team context if there are other agents
		const sessions = this.getSessions();
		if (sessions.length > 0) {
			const teamInfo = sessions.map(s => {
				const role = s.systemPrompt ? ` (${s.systemPrompt.slice(0, 60)})` : '';
				return `  - ${s.name}${role}`;
			}).join('\n');
			parts.push(`\nYou are part of an agent team. Other agents:\n${teamInfo}`);
			parts.push('Your output may be automatically forwarded to connected agents. Be concise and structured in your responses.');
		}

		return parts.join('\n\n');
	}

	removeSession(id: string): void {
		const session = this.sessions.get(id);
		if (!session) { return; }

		session.terminal.dispose();
		this.sessions.delete(id);

		for (const [edgeId, edge] of this.edges) {
			if (edge.from === id || edge.to === id) {
				this.edges.delete(edgeId);
			}
		}

		this.saveState();
		this._onChanged.fire();
	}

	getSession(id: string): AgentSession | undefined {
		return this.sessions.get(id);
	}

	getSessions(): AgentSession[] {
		return Array.from(this.sessions.values());
	}

	getSerializableSessions(): SerializableSession[] {
		return this.getSessions().map(s => ({
			id: s.id,
			name: s.name,
			status: s.status,
			color: s.color,
			graphPosition: s.graphPosition,
			systemPrompt: s.systemPrompt,
			humanInLoop: s.humanInLoop,
			createdAt: s.createdAt,
		}));
	}

	findSessionByTerminal(terminal: vscode.Terminal): AgentSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.terminal === terminal) {
				return session;
			}
		}
		return undefined;
	}

	renameSession(id: string, name: string): void {
		const session = this.sessions.get(id);
		if (session) {
			session.name = name;
			session.terminal.processId.then(pid => {
				if (pid) {
					vscode.commands.executeCommand('_workbench.action.terminal.renameByPid', { pid, name });
				}
			});
			this.saveState();
			this._onChanged.fire();
		}
	}

	setSessionColor(id: string, color: string): void {
		const session = this.sessions.get(id);
		if (session) {
			session.color = color;
			this.saveState();
			this._onChanged.fire();
		}
	}

	setSessionRole(id: string, systemPrompt: string): void {
		const session = this.sessions.get(id);
		if (session) {
			session.systemPrompt = systemPrompt || undefined;
			this.saveState();
			this._onChanged.fire();
		}
	}

	setSessionHITL(id: string, enabled: boolean): void {
		const session = this.sessions.get(id);
		if (session) {
			session.humanInLoop = enabled;
			this.saveState();
			this._onChanged.fire();
		}
	}

	setSessionStatus(id: string, status: SessionStatus): void {
		const session = this.sessions.get(id);
		if (session && session.status !== status) {
			session.status = status;
			this._onChanged.fire();
		}
	}

	/** Max auto-restarts before giving up (resets on manual restart or user interaction). */
	private static readonly MAX_AUTO_RESTARTS = 3;
	/** Minimum seconds between auto-restarts (exponential backoff: 10s, 20s, 40s). */
	private static readonly BASE_RESTART_COOLDOWN_MS = 10_000;

	/**
	 * Check if an auto-restart is allowed for this session.
	 * Returns false if cooldown hasn't elapsed or max retries exceeded.
	 */
	canAutoRestart(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) { return false; }

		if (session.restartCount >= SessionManager.MAX_AUTO_RESTARTS) {
			return false;
		}

		if (session.lastRestartAt > 0) {
			const backoff = SessionManager.BASE_RESTART_COOLDOWN_MS * Math.pow(2, session.restartCount);
			const elapsed = Date.now() - session.lastRestartAt;
			if (elapsed < backoff) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Restart Claude Code by disposing the old terminal and creating a fresh one.
	 * @param manual If true, resets the restart counter (user-initiated restart).
	 */
	restartSession(id: string, manual = false): void {
		const session = this.sessions.get(id);
		if (!session) { return; }

		if (manual) {
			session.restartCount = 0;
		} else {
			session.restartCount++;
		}
		session.lastRestartAt = Date.now();

		const name = session.name;
		const color = session.color;
		const systemPrompt = session.systemPrompt;
		const themeColorId = COLOR_TO_THEME[color] || 'charts.orange';

		const oldTerminal = session.terminal;
		this.restartingTerminals.add(oldTerminal);
		oldTerminal.dispose();

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const newTerminal = vscode.window.createTerminal({
			name,
			cwd: workspaceFolder?.uri,
			iconPath: new vscode.ThemeIcon('robot', new vscode.ThemeColor(themeColorId)),
			env: { ...AGENT_TERMINAL_ENV },
		});

		newTerminal.sendText(this.agentCommand(systemPrompt || undefined));

		session.terminal = newTerminal;
		session.status = 'waiting';
		newTerminal.show(false);
		this.saveState();
		this._onChanged.fire();
	}

	updateGraphPosition(id: string, pos: { x: number; y: number }): void {
		const session = this.sessions.get(id);
		if (session) {
			session.graphPosition = pos;
			this.saveState();
		}
	}

	// --- Edge CRUD ---

	/**
	 * Inject topology awareness into a session's terminal.
	 * Tells the agent about its upstream and downstream connections
	 * including their roles and the edge conditions.
	 */
	injectConnectionAwareness(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.status === 'exited') { return; }
		const edges = this.getEdges();

		const upstream = edges.filter(e => e.to === sessionId).map(e => {
			const src = this.sessions.get(e.from);
			const name = src?.name || 'Unknown';
			const cond = e.condition !== 'all' ? ` [${e.condition}]` : '';
			return `${name}${cond}`;
		});

		const downstream = edges.filter(e => e.from === sessionId).map(e => {
			const tgt = this.sessions.get(e.to);
			const name = tgt?.name || 'Unknown';
			const cond = e.condition !== 'all' ? ` [${e.condition}]` : '';
			const iter = e.maxIterations > 0 ? ` (max ${e.maxIterations}x)` : '';
			return `${name}${cond}${iter}`;
		});

		if (upstream.length === 0 && downstream.length === 0) { return; }

		const parts: string[] = ['[Team Topology Update]'];
		if (upstream.length > 0) { parts.push(`Input from: ${upstream.join(', ')}`); }
		if (downstream.length > 0) { parts.push(`Output goes to: ${downstream.join(', ')}`); }
		parts.push('Structure your responses clearly so downstream agents can parse them.');
		session.terminal.sendText(parts.join(' '));
	}

	addEdge(from: string, to: string, condition: EdgeCondition = 'all', maxIterations = 0, _skipAwareness = false): SessionEdge | undefined {
		if (from === to) { return undefined; }
		for (const edge of this.edges.values()) {
			if (edge.from === from && edge.to === to) { return edge; }
		}
		const id = `${from}->${to}`;
		const edge: SessionEdge = {
			id,
			from,
			to,
			condition,
			maxIterations,
			iterationCount: 0,
			lastResetAt: Date.now(),
		};
		this.edges.set(id, edge);
		this.saveState();
		this._onChanged.fire();
		if (!_skipAwareness) {
			this.injectConnectionAwareness(from);
			this.injectConnectionAwareness(to);
		}
		return edge;
	}

	removeEdge(edgeId: string): void {
		this.edges.delete(edgeId);
		this.saveState();
		this._onChanged.fire();
	}

	updateEdge(edgeId: string, patch: Partial<Pick<SessionEdge, 'condition' | 'maxIterations'>>): void {
		const edge = this.edges.get(edgeId);
		if (edge) {
			if (patch.condition !== undefined) { edge.condition = patch.condition; }
			if (patch.maxIterations !== undefined) { edge.maxIterations = patch.maxIterations; }
			this.saveState();
			this._onChanged.fire();
		}
	}

	incrementEdgeIteration(edgeId: string): number {
		const edge = this.edges.get(edgeId);
		if (edge) {
			edge.iterationCount++;
			this.saveState();
			return edge.iterationCount;
		}
		return 0;
	}

	resetEdgeIterations(edgeId: string): void {
		const edge = this.edges.get(edgeId);
		if (edge) {
			edge.iterationCount = 0;
			edge.lastResetAt = Date.now();
			this.saveState();
			this._onChanged.fire();
		}
	}

	getEdges(): SessionEdge[] {
		return Array.from(this.edges.values());
	}

	getDownstreamEdges(sessionId: string): SessionEdge[] {
		return this.getEdges().filter(e => e.from === sessionId);
	}

	// --- Topology ---

	applyTopology(preset: TopologyPreset): string[] {
		const baseX = 200;
		const baseY = 200;
		const newIds: string[] = [];

		for (const node of preset.nodes) {
			const session = this.createSession(node.name, node.role, { showTerminal: false });
			session.graphPosition = { x: baseX + node.relativePos.x, y: baseY + node.relativePos.y };
			newIds.push(session.id);
		}

		for (const e of preset.edges) {
			this.addEdge(newIds[e.fromIndex], newIds[e.toIndex], e.condition ?? 'all', e.maxIterations ?? 0, true);
		}

		for (const id of newIds) {
			this.injectConnectionAwareness(id);
		}

		this.saveState();
		this._onChanged.fire();
		return newIds;
	}

	// --- Activity Log ---

	addActivityEntry(entry: Omit<ActivityLogEntry, 'id'>): void {
		const newEntry: ActivityLogEntry = {
			...entry,
			id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		};
		this.activityLog.push(newEntry);
		if (this.activityLog.length > 200) {
			this.activityLog = this.activityLog.slice(-200);
		}
		this.context.globalState.update('activityLog', this.activityLog);
	}

	getActivityLog(): ActivityLogEntry[] {
		return this.activityLog;
	}

	clearActivityLog(): void {
		this.activityLog = [];
		this.context.globalState.update('activityLog', []);
	}

	// --- Messages ---

	addMessage(msg: SessionMessage): void {
		this.messages.push(msg);
		if (this.messages.length > 200) {
			this.messages = this.messages.slice(-200);
		}
	}

	// --- Terminal cleanup ---

	handleTerminalClose(terminal: vscode.Terminal): void {
		if (this.restartingTerminals.delete(terminal)) {
			return;
		}

		const session = this.findSessionByTerminal(terminal);
		if (session) {
			this.sessions.delete(session.id);
			for (const [edgeId, edge] of this.edges) {
				if (edge.from === session.id || edge.to === session.id) {
					this.edges.delete(edgeId);
				}
			}
			this.saveState();
			this._onChanged.fire();
		}
	}

	// --- Persistence ---

	private saveState(): void {
		const serialized = {
			sessions: this.getSerializableSessions(),
			edges: this.getEdges(),
		};
		this.context.globalState.update('agentSessions', serialized);
	}

	private loadState(): void {
		this.activityLog = this.context.globalState.get<ActivityLogEntry[]>('activityLog') ?? [];

		const saved = this.context.globalState.get<{
			sessions?: SerializableSession[];
			edges?: SessionEdge[];
		}>('agentSessions');
		if (saved) {
			this.pendingAdoption = saved.sessions ?? [];
			this.pendingEdges = saved.edges ?? [];
		}
	}

	/**
	 * Restore persisted sessions with fresh, clean terminals.
	 */
	adoptRestoredTerminals(): number {
		const BUILD_NAME = '\u26A1 Build';

		for (const terminal of vscode.window.terminals) {
			if (terminal.name === BUILD_NAME) { continue; }
			terminal.dispose();
		}

		const persisted = this.pendingAdoption;
		const adoptedIds = new Set<string>();
		let adoptedCount = 0;
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

		for (const match of persisted) {
			const color = match.color;
			const themeColorId = COLOR_TO_THEME[color] || 'charts.orange';

			const terminal = vscode.window.createTerminal({
				name: match.name,
				cwd: workspaceFolder?.uri,
				iconPath: new vscode.ThemeIcon('robot', new vscode.ThemeColor(themeColorId)),
				env: { ...AGENT_TERMINAL_ENV },
			});

			terminal.sendText(this.agentCommand(match.systemPrompt || undefined));

			const session: AgentSession = {
				id: match.id,
				name: match.name,
				terminal,
				status: 'waiting',
				color: match.color,
				graphPosition: match.graphPosition,
				systemPrompt: match.systemPrompt,
				humanInLoop: match.humanInLoop,
				createdAt: match.createdAt,
				restartCount: 0,
				lastRestartAt: 0,
			};
			this.sessions.set(session.id, session);
			adoptedIds.add(session.id);
			adoptedCount++;

			const m = session.name.match(/^Agent (\d+)$/);
			if (m) {
				this.counter = Math.max(this.counter, parseInt(m[1], 10));
			}
		}

		for (const edge of this.pendingEdges) {
			if (adoptedIds.has(edge.from) && adoptedIds.has(edge.to)) {
				this.edges.set(edge.id, { ...edge, iterationCount: 0, lastResetAt: Date.now() });
			}
		}

		this.pendingAdoption = [];
		this.pendingEdges = [];

		if (adoptedCount > 0) {
			this.saveState();
			this._onChanged.fire();
		}

		return adoptedCount;
	}

	dispose(): void {
		this._onChanged.dispose();
	}
}
