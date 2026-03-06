#!/usr/bin/env node
/**
 * Autothropic MCP Server — lightweight, zero-dependency MCP server
 * that gives each Claude Code agent structured tools for communication.
 *
 * Launched per-agent via --mcp-config. Communicates over stdio (JSON-RPC).
 *
 * Tools provided:
 *   send_response   — Write structured response for orchestration pickup
 *   get_connections  — Query upstream/downstream topology
 *   read_message     — Read a forwarded message file (clean JSON)
 *
 * Args:
 *   --agent-id <id>           Session ID for this agent
 *   --agent-name <name>       Human-readable name
 *   --response-dir <path>     Shared directory for response files
 *   --connections-file <path> JSON file with this agent's connections
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const AGENT_ID = getArg('--agent-id') || 'unknown';
const AGENT_NAME = getArg('--agent-name') || 'Agent';
const RESPONSE_DIR = getArg('--response-dir') || '';
const CONNECTIONS_FILE = getArg('--connections-file') || '';

// Ensure response dir exists
if (RESPONSE_DIR) {
  try { fs.mkdirSync(RESPONSE_DIR, { recursive: true }); } catch {}
}

// --- MCP Tool Definitions ---
const TOOLS = [
  {
    name: 'send_response',
    description:
      'Send your response/output to the orchestration system. Call this after completing any task. ' +
      'The orchestration system reads this to forward your output to connected downstream agents. ' +
      'Always call this tool instead of writing to files manually.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Your response content. Plain text or markdown. Be concise and structured.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'get_connections',
    description:
      'Get your current connections in the agent topology. ' +
      'Returns which agents send you input and which agents receive your output.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_message',
    description:
      'Read a forwarded message from another agent. ' +
      'When you receive a prompt telling you to read a message file, use this tool to read it cleanly.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the message file.',
        },
      },
      required: ['file'],
    },
  },
];

// --- Tool Handlers ---

function handleSendResponse(params) {
  const content = params.content || '';
  if (!content.trim()) {
    return { content: [{ type: 'text', text: 'Error: content cannot be empty.' }], isError: true };
  }
  if (!RESPONSE_DIR) {
    return { content: [{ type: 'text', text: 'Error: no response directory configured.' }], isError: true };
  }

  const responseFile = path.join(RESPONSE_DIR, `${AGENT_ID}.response.json`);
  const payload = {
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    timestamp: new Date().toISOString(),
    content: content,
  };

  try {
    fs.writeFileSync(responseFile, JSON.stringify(payload, null, 2), 'utf-8');
    return {
      content: [{ type: 'text', text: `Response written successfully (${content.length} chars).` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error writing response: ${err.message}` }],
      isError: true,
    };
  }
}

function handleGetConnections() {
  if (!CONNECTIONS_FILE) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ upstream: [], downstream: [], teamMembers: [] }) }],
    };
  }

  try {
    if (fs.existsSync(CONNECTIONS_FILE)) {
      const data = fs.readFileSync(CONNECTIONS_FILE, 'utf-8');
      return { content: [{ type: 'text', text: data }] };
    }
  } catch {}

  return {
    content: [{ type: 'text', text: JSON.stringify({ upstream: [], downstream: [], teamMembers: [] }) }],
  };
}

function handleReadMessage(params) {
  const filePath = params.file || '';
  if (!filePath) {
    return { content: [{ type: 'text', text: 'Error: file path is required.' }], isError: true };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return { content: [{ type: 'text', text: 'Error: message file is empty.' }], isError: true };
    }

    // Try parsing as JSON first
    try {
      const msg = JSON.parse(raw);
      const formatted =
        `From: ${msg.from || 'Unknown'}\n` +
        `Role: ${msg.fromRole || 'Agent'}\n` +
        `Time: ${msg.timestamp || 'Unknown'}\n` +
        `---\n` +
        `${msg.content || raw}`;
      return { content: [{ type: 'text', text: formatted }] };
    } catch {
      // Not JSON — return raw content (backwards compat)
      return { content: [{ type: 'text', text: raw }] };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading message: ${err.message}` }],
      isError: true,
    };
  }
}

// --- JSON-RPC / MCP Protocol ---

let requestId = 0;
const pendingBuffer = [];
let initialized = false;

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  process.stdout.write(msg + '\n');
}

function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'autothropic-orchestration',
          version: '1.0.0',
        },
      });
      initialized = true;
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      let result;

      switch (toolName) {
        case 'send_response':
          result = handleSendResponse(toolArgs);
          break;
        case 'get_connections':
          result = handleGetConnections(toolArgs);
          break;
        case 'read_message':
          result = handleReadMessage(toolArgs);
          break;
        default:
          result = {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }
      sendResponse(id, result);
      break;
    }

    case 'ping':
      sendResponse(id, {});
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// --- Stdio transport ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const req = JSON.parse(trimmed);
    handleRequest(req);
  } catch (err) {
    // Malformed JSON — ignore
  }
});

rl.on('close', () => {
  process.exit(0);
});

// Keep process alive
process.stdin.resume();
