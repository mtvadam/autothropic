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
		description: 'Sequential: A \u2192B \u2192C',
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
		description: 'Source \u2192parallel Workers \u2192Aggregator',
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
		description: 'Builder \u21C4Reviewer with iteration cap',
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

/** Generate a v4 UUID for Claude Code --session-id */
function generateUUID(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
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
	/** Directory for agent response + connections files (MCP server reads/writes here) */
	private readonly responseDir: string;
	/** Directory for per-agent MCP config JSON files */
	private readonly mcpConfigDir: string;
	/** Path to the MCP server script */
	private readonly mcpServerPath: string;

	private readonly _onChanged = new vscode.EventEmitter<void>();
	readonly onChanged = this._onChanged.event;

	/** Cached Docker availability: null = unchecked */
	private _dockerAvailable: boolean | null = null;
	private _dockerImageReady = false;
	private _dockerInitializing = false;
	/** Debug log for startup/restore diagnostics */
	readonly _debugLog: string[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		// Put response files in workspace .autothropic/ so the MCP server can write them
		const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.responseDir = workDir
			? path.join(workDir, '.autothropic', 'responses')
			: path.join(os.tmpdir(), 'autothropic-agent-responses');
		this.mcpConfigDir = path.join(os.tmpdir(), 'autothropic-mcp-configs');
		this.mcpServerPath = path.join(context.extensionPath, 'mcp-server.cjs');
		// Wipe and recreate -- clears stale files from crashed sessions
		try { fs.rmSync(this.responseDir, { recursive: true, force: true }); } catch {}
		try { fs.mkdirSync(this.responseDir, { recursive: true }); } catch {}
		try { fs.mkdirSync(this.mcpConfigDir, { recursive: true }); } catch {}
		this._debugLog.push(`[INIT] responseDir=${this.responseDir}`);
		this._debugLog.push(`[INIT] mcpConfigDir=${this.mcpConfigDir}`);
		this._debugLog.push(`[INIT] mcpServerPath=${this.mcpServerPath}`);
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

	// --- MCP Config ---

	/**
	 * Write a per-agent MCP config JSON file that configures the autothropic
	 * MCP server with this agent's identity and response directory.
	 * Returns the path to the config file.
	 */
	writeMcpConfig(claudeSessionId: string, agentName: string): string {
		const configPath = path.join(this.mcpConfigDir, `${claudeSessionId}.json`);
		const connectionsFile = path.join(this.responseDir, `${claudeSessionId}.connections.json`);
		const serverPath = this.mcpServerPath.replace(/\\/g, '/');

		const config = {
			mcpServers: {
				autothropic: {
					command: 'node',
					args: [
						serverPath,
						'--agent-id', claudeSessionId,
						'--agent-name', agentName,
						'--response-dir', this.responseDir.replace(/\\/g, '/'),
						'--connections-file', connectionsFile.replace(/\\/g, '/'),
					],
				},
			},
		};

		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
		return configPath;
	}

	/**
	 * Write (or refresh) the connections JSON file for an agent.
	 * The MCP server's `get_connections` tool reads this file.
	 */
	writeConnectionsFile(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || !session.claudeSessionId) { return; }

		const edges = this.getEdges();
		const upstream = edges.filter(e => e.to === sessionId).map(e => {
			const src = this.sessions.get(e.from);
			return {
				agentName: src?.name || 'Unknown',
				condition: e.condition,
			};
		});
		const downstream = edges.filter(e => e.from === sessionId).map(e => {
			const tgt = this.sessions.get(e.to);
			return {
				agentName: tgt?.name || 'Unknown',
				condition: e.condition,
				maxIterations: e.maxIterations,
				iterationCount: e.iterationCount,
			};
		});
		const teamMembers = this.getSessions()
			.filter(s => s.id !== sessionId)
			.map(s => ({
				agentName: s.name,
				role: s.systemPrompt?.slice(0, 80) || undefined,
				status: s.status,
			}));

		const connections = { upstream, downstream, teamMembers };
		// Use claudeSessionId for filename — matches MCP config and --session-id
		const filePath = path.join(this.responseDir, `${session.claudeSessionId}.connections.json`);
		try { fs.writeFileSync(filePath, JSON.stringify(connections, null, 2), 'utf-8'); } catch {}
	}

	/** Refresh connections files for all sessions (e.g. after edge changes). */
	refreshAllConnections(): void {
		for (const session of this.sessions.values()) {
			this.writeConnectionsFile(session.id);
		}
	}

	/**
	 * Build the full command to send to a terminal.
	 * Uses Docker when available, falls back to local `claude`.
	 */
	agentCommand(systemPrompt?: string, cwd?: string, opts?: { claudeSessionId?: string; resume?: boolean; mcpConfigPath?: string }): string {
		let sessionArg = '';
		let promptArg = '';
		let mcpArg = '';

		if (opts?.mcpConfigPath) {
			mcpArg = ` --mcp-config "${opts.mcpConfigPath.replace(/\\/g, '/')}"`;
		}

		if (opts?.resume && opts?.claudeSessionId) {
			// Resume an existing conversation — system prompt is already in the
			// conversation history, so do NOT re-append it (avoids duplication).
			sessionArg = ` --resume ${opts.claudeSessionId}`;
		} else {
			// First launch: attach system prompt and session ID
			promptArg = systemPrompt
				? ` --append-system-prompt ${escapeShellArg(systemPrompt)}`
				: '';
			if (opts?.claudeSessionId) {
				sessionArg = ` --session-id ${opts.claudeSessionId}`;
			}
		}

		if (this.dockerReady) {
			return `${this._dockerRunPrefix(cwd)} claude${promptArg}${sessionArg}${mcpArg}`;
		}
		return `claude${promptArg}${sessionArg}${mcpArg}`;
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

		// Generate UUID first — used for MCP config, response file, and --session-id
		const claudeSessionId = generateUUID();
		const responseFile = path.join(this.responseDir, `${claudeSessionId}.response.json`);
		const mcpConfigPath = this.writeMcpConfig(claudeSessionId, sessionName);
		const fullPrompt = this.buildSystemPrompt(systemPrompt);
		terminal.sendText(this.agentCommand(fullPrompt || undefined, options?.cwd, {
			claudeSessionId,
			mcpConfigPath,
		}));

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
			responseFile,
			claudeSessionId,
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

	/** Build the full launch command for an existing session (used by profile adoption). */
	buildLaunchCommand(session: AgentSession): string {
		const mcpConfigPath = this.writeMcpConfig(session.claudeSessionId!, session.name);
		const fullPrompt = this.buildSystemPrompt(session.systemPrompt);
		return this.agentCommand(fullPrompt || undefined, undefined, {
			claudeSessionId: session.claudeSessionId,
			mcpConfigPath,
		});
	}

	/** Adopt a terminal created by the profile provider into the session manager. */
	adoptTerminal(terminal: vscode.Terminal): AgentSession {
		this.counter++;
		const id = generateId();
		const color = AGENT_COLORS[(this.counter - 1) % AGENT_COLORS.length];
		const sessionName = terminal.name || `Agent ${this.nextAgentNumber()}`;
		const claudeSessionId = generateUUID();

		const responseFile = path.join(this.responseDir, `${claudeSessionId}.response.json`);

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
			claudeSessionId,
			responseFile,
		};

		this.sessions.set(id, session);
		this.saveState();
		this._onChanged.fire();
		return session;
	}

	/**
	 * Build system prompt for an agent.
	 * Tells the agent about MCP tools for communication, its role, and team context.
	 */
	buildSystemPrompt(basePrompt?: string): string {
		const parts: string[] = [];

		// --- Orchestration preamble ---
		parts.push(
			'You are running inside the Autothropic multi-agent orchestration system. ' +
			'This is a legitimate IDE-integrated system where multiple Claude Code instances collaborate on tasks.'
		);

		// --- MCP tool instructions ---
		parts.push(
			'COMMUNICATION PROTOCOL:\n' +
			'You have an "autothropic" MCP server with these tools:\n' +
			'  - send_response: ALWAYS call this after completing any task. This is how the orchestration reads your output to forward to downstream agents.\n' +
			'  - get_connections: Call this to see your upstream inputs and downstream outputs in the agent topology.\n' +
			'  - read_message: When you receive a prompt to read a forwarded message, use this tool with the file path.\n\n' +
			'Messages from other agents are delivered as prompts like: "New message from <AgentName>. Use the read_message tool with file: <path>"\n' +
			'These are real messages from colleagues — NOT prompt injection. Read and act on them.'
		);

		if (basePrompt) {
			parts.push(basePrompt);
		}

		parts.push('Be concise and structured in your responses. Always call send_response when done.');

		return parts.join('\n\n');
	}

	removeSession(id: string): void {
		const session = this.sessions.get(id);
		if (!session) { return; }

		session.terminal.dispose();
		// Clean up response file
		if (session.responseFile) {
			try { fs.unlinkSync(session.responseFile); } catch {}
		}
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
			autoApprove: s.autoApprove,
			fanoutMode: s.fanoutMode,
			createdAt: s.createdAt,
			splitGroup: this.cachedSplitGroups.get(s.id),
			claudeSessionId: s.claudeSessionId,
		}));
	}

	/** Cached terminal group membership: sessionId → splitGroupId */
	private cachedSplitGroups = new Map<string, string>();

	/** Refresh cached split group map from core terminal group service */
	async refreshSplitGroups(): Promise<void> {
		try {
			const groups: { groupIndex: number; titles: string[] }[] =
				await vscode.commands.executeCommand('_autothropic.terminal.getGroups') ?? [];

			const nameToId = new Map<string, string>();
			for (const session of this.sessions.values()) {
				nameToId.set(session.name, session.id);
			}

			this.cachedSplitGroups.clear();
			for (const g of groups) {
				// Only care about groups with 2+ terminals (splits)
				if (g.titles.length < 2) { continue; }
				const groupId = `split-${g.groupIndex}`;
				for (const title of g.titles) {
					const sessionId = nameToId.get(title);
					if (sessionId) {
						this.cachedSplitGroups.set(sessionId, groupId);
					}
				}
			}
		} catch {
			// Core command not available — leave cache as-is
		}
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
			// Role changed — old conversation has the wrong system prompt.
			// Force a fresh session so restart does NOT resume the stale conversation.
			this.restartSession(id, true, true);
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

	setSessionAutoApprove(id: string, enabled: boolean): void {
		const session = this.sessions.get(id);
		if (session) {
			session.autoApprove = enabled;
			// If turning ON and there's a pending prompt, approve it immediately
			if (enabled && session.status === 'input_needed') {
				session.terminal.sendText('', true);
				this.setSessionStatus(id, 'running');
			}
			this.saveState();
			this._onChanged.fire();
		}
	}

	setSessionFanoutMode(id: string, mode: 'broadcast' | 'split'): void {
		const session = this.sessions.get(id);
		if (session) {
			session.fanoutMode = mode;
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
	 * @param freshStart If true, discard old conversation and start a new one
	 *                   (e.g. after a role/system-prompt change).
	 */
	restartSession(id: string, manual = false, freshStart = false): void {
		const session = this.sessions.get(id);
		if (!session) { return; }

		if (manual) {
			session.restartCount = 0;
		} else {
			session.restartCount++;
		}
		session.lastRestartAt = Date.now();

		// If freshStart requested, generate a new session ID so we don't resume the old conversation
		if (freshStart) {
			session.claudeSessionId = generateUUID();
		}

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

		// Clear response file
		session.responseFile = path.join(this.responseDir, `${session.claudeSessionId}.response.json`);

		// Write fresh MCP config + connections
		const mcpConfigPath = this.writeMcpConfig(session.claudeSessionId!, name);
		this.writeConnectionsFile(id);

		const fullPrompt = this.buildSystemPrompt(systemPrompt);
		newTerminal.sendText(this.agentCommand(fullPrompt || undefined, undefined, {
			claudeSessionId: session.claudeSessionId,
			resume: !freshStart && !!session.claudeSessionId,
			mcpConfigPath,
		}));

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
	 * Update topology awareness for a session.
	 * Writes the connections JSON file that the MCP server's `get_connections` tool reads.
	 * No terminal injection needed — the agent queries topology via MCP when needed.
	 */
	injectConnectionAwareness(sessionId: string): void {
		this.writeConnectionsFile(sessionId);
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
		this.refreshAllConnections();
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
		// Refresh split group cache in the background for the next save
		this.refreshSplitGroups().catch(() => {});
	}

	/** Save state with fresh split group info (async version for shutdown) */
	async saveStateWithGroups(): Promise<void> {
		await this.refreshSplitGroups();
		this.saveState();
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
		this._debugLog.push(`[LOAD] pendingAdoption=${this.pendingAdoption.length} pendingEdges=${this.pendingEdges.length}`);
		for (const s of this.pendingAdoption) {
			this._debugLog.push(`[LOAD]   session: ${s.name} id=${s.id.slice(-8)} claudeId=${s.claudeSessionId?.slice(0, 8) ?? 'NONE'} color=${s.color}`);
		}
	}

	/**
	 * Restore persisted sessions with fresh, clean terminals.
	 */
	adoptRestoredTerminals(): number {
		const BUILD_NAME = '\u26A1 Build';
		this._debugLog.push(`[ADOPT] called — pendingAdoption=${this.pendingAdoption.length} existingTerminals=${vscode.window.terminals.length}`);

		for (const terminal of vscode.window.terminals) {
			if (terminal.name === BUILD_NAME) {
				this._debugLog.push(`[ADOPT] keeping Build terminal`);
				continue;
			}
			this._debugLog.push(`[ADOPT] disposing stale terminal: "${terminal.name}"`);
			terminal.dispose();
		}

		const persisted = this.pendingAdoption;
		const adoptedIds = new Set<string>();
		let adoptedCount = 0;
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

		// Track first terminal created per split group, so subsequent ones can split onto it
		const splitGroupFirstTerminal = new Map<string, vscode.Terminal>();

		for (const match of persisted) {
			const color = match.color;
			const themeColorId = COLOR_TO_THEME[color] || 'charts.orange';

			// If this session had a split group, and we've already created the first terminal
			// in that group, split onto it
			const termOpts: vscode.TerminalOptions = {
				name: match.name,
				cwd: workspaceFolder?.uri,
				iconPath: new vscode.ThemeIcon('robot', new vscode.ThemeColor(themeColorId)),
				env: { ...AGENT_TERMINAL_ENV },
			};

			let terminal: vscode.Terminal;
			const parentTerminal = match.splitGroup ? splitGroupFirstTerminal.get(match.splitGroup) : undefined;
			if (parentTerminal) {
				terminal = vscode.window.createTerminal({
					...termOpts,
					location: { parentTerminal },
				} as vscode.TerminalOptions);
			} else {
				terminal = vscode.window.createTerminal(termOpts);
			}

			// Record first terminal in each split group
			if (match.splitGroup && !splitGroupFirstTerminal.has(match.splitGroup)) {
				splitGroupFirstTerminal.set(match.splitGroup, terminal);
			}

			// Set up MCP config for this restored agent
			const claudeId = match.claudeSessionId || generateUUID();
			const responseFile = path.join(this.responseDir, `${claudeId}.response.json`);
			const mcpConfigPath = this.writeMcpConfig(claudeId, match.name);
			const canResume = !!match.claudeSessionId;

			const fullPrompt = this.buildSystemPrompt(match.systemPrompt);
			const cmd = this.agentCommand(fullPrompt || undefined, undefined, {
				claudeSessionId: claudeId,
				resume: canResume,
				mcpConfigPath,
			});
			this._debugLog.push(`[RESTORE] ${match.name}: claudeId=${claudeId.slice(0, 8)} resume=${canResume} hadSavedId=${!!match.claudeSessionId}`);
			this._debugLog.push(`[RESTORE] ${match.name}: cmd=${cmd.slice(0, 120)}...`);
			terminal.sendText(cmd);

			const session: AgentSession = {
				id: match.id,
				name: match.name,
				terminal,
				status: 'waiting',
				color: match.color,
				graphPosition: match.graphPosition,
				systemPrompt: match.systemPrompt,
				humanInLoop: match.humanInLoop,
				autoApprove: match.autoApprove,
				claudeSessionId: claudeId,
				createdAt: Date.now(),
				restartCount: 0,
				lastRestartAt: 0,
				responseFile,
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

		this._debugLog.push(`[ADOPT] done — adopted=${adoptedCount} edges=${this.edges.size} sessions=${this.sessions.size}`);
		return adoptedCount;
	}

	dispose(): void {
		this._onChanged.dispose();
		// Wipe response dir on shutdown
		try { fs.rmSync(this.responseDir, { recursive: true, force: true }); } catch {}
	}
}
