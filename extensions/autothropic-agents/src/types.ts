import * as vscode from 'vscode';

export type SessionStatus = 'running' | 'waiting' | 'input_needed' | 'error' | 'complete' | 'paused' | 'exited';

export interface AgentSession {
	id: string;
	name: string;
	terminal: vscode.Terminal;
	status: SessionStatus;
	color: string;
	graphPosition: { x: number; y: number };
	systemPrompt?: string;
	humanInLoop?: boolean;
	createdAt: number;
	/** Number of auto-restarts since last manual interaction */
	restartCount: number;
	/** Timestamp of last auto-restart */
	lastRestartAt: number;
	/** File path where this agent writes its response for orchestration */
	responseFile?: string;
	/** Auto-approve tool prompts (send Enter on input_needed) */
	autoApprove?: boolean;
	/** How output is distributed to downstream agents */
	fanoutMode?: 'broadcast' | 'split';
	/** Claude Code session UUID — used for --resume on restart/reopen */
	claudeSessionId?: string;
}

export type EdgeCondition = 'all' | 'code-changes' | 'errors' | 'summary-only';

export interface SessionEdge {
	id: string;
	from: string;
	to: string;
	condition: EdgeCondition;
	maxIterations: number;
	iterationCount: number;
	lastResetAt: number;
}

export interface TopologyPreset {
	id: string;
	label: string;
	description: string;
	nodes: { name: string; role: string; relativePos: { x: number; y: number } }[];
	edges: { fromIndex: number; toIndex: number; condition?: EdgeCondition; maxIterations?: number }[];
}

export interface SessionMessage {
	id: string;
	fromSessionId: string;
	toSessionId: string;
	content: string;
	timestamp: number;
}

export interface ActivityLogEntry {
	id: string;
	sessionId: string;
	sessionName: string;
	sessionColor: string;
	timestamp: number;
	summary: string;
}

export interface PendingApproval {
	id: string;
	fromSessionId: string;
	toSessionId: string;
	fromSessionName: string;
	toSessionName: string;
	fromSessionColor: string;
	summary: string;
	fullMessage: string;
	timestamp: number;
}

/** Serializable session data (no terminal reference) for persistence and IPC */
export interface SerializableSession {
	id: string;
	name: string;
	status: SessionStatus;
	color: string;
	graphPosition: { x: number; y: number };
	systemPrompt?: string;
	humanInLoop?: boolean;
	autoApprove?: boolean;
	fanoutMode?: 'broadcast' | 'split';
	createdAt: number;
	/** Terminals sharing the same splitGroup string are restored into a split pane */
	splitGroup?: string;
	/** Claude Code session UUID — used for --resume on restart/reopen */
	claudeSessionId?: string;
}
