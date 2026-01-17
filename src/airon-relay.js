#!/usr/bin/env node
/**
 * airon-relay.js - AIRON Relay Server
 * 
 * Copyright (c) 2025 Karol Kowalczyk
 * Licensed under the MIT License
 * See: https://opensource.org/licenses/MIT
 * 
 * MCP relay server for connecting Claude.ai to remote AIRON nodes
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Simple rate limiting implementation - prevent brute force attacks
const rateLimitMap = new Map(); // IP -> { count, resetTime }
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 100; // Max requests per window

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  record.count++;
  return true;
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000); // Clean up every minute

// Connection limits - prevent resource exhaustion
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_TOTAL_SSE_CLIENTS = 1000;
const MAX_PENDING_REQUESTS = 10000;

// User management - maintain list of authorized nodes
const DATA_DIR = process.env.AIRON_DATA_DIR || '.';
const NODES_FILE = `${DATA_DIR}/airon-nodes.json`;
const INITIAL_ADMIN = process.env.AIRON_ADMIN_NODE; // Set initial admin via env var

function loadAuthorizedNodes() {
  if (!existsSync(NODES_FILE)) {
    // If INITIAL_ADMIN is set, create file with that admin
    if (INITIAL_ADMIN) {
      const nodesData = {
        nodes: [INITIAL_ADMIN],
        admins: [INITIAL_ADMIN]
      };
      saveAuthorizedNodes(nodesData);
      console.log(`✓ Initialized with admin node from AIRON_ADMIN_NODE`);
      return nodesData;
    }
    // Otherwise, no file exists yet - will be created when first node connects
    return null;
  }
  
  try {
    return JSON.parse(readFileSync(NODES_FILE, 'utf-8'));
  } catch (err) {
    console.error('Failed to load nodes file:', err.message);
    return { nodes: [], admins: [] };
  }
}

function saveAuthorizedNodes(nodesData) {
  try {
    writeFileSync(NODES_FILE, JSON.stringify(nodesData, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save nodes file:', err.message);
    return false;
  }
}

// Timing-safe token comparison to prevent timing attacks
function timingSafeTokenCheck(token, authorizedList) {
  // Check if token exists in list using timing-safe comparison
  for (const authorizedToken of authorizedList) {
    if (authorizedToken.length !== token.length) {
      continue; // Skip length mismatch (constant time)
    }
    
    try {
      const tokenBuf = Buffer.from(token, 'utf8');
      const authBuf = Buffer.from(authorizedToken, 'utf8');
      
      if (crypto.timingSafeEqual(tokenBuf, authBuf)) {
        return true;
      }
    } catch {
      // Length mismatch or encoding error, continue
      continue;
    }
  }
  return false;
}

let authorizedNodes = loadAuthorizedNodes();

// In-memory state
const nodes = new Map();           // token -> WebSocket
const sseClients = new Map();      // sessionId -> { res, token }
const pendingRequests = new Map(); // requestId -> { resolve, reject }
const connectionsPerIP = new Map(); // IP -> count

// MCP Endpoint with username and secret in path
app.get('/mcp/:username/:secret', (req, res) => {
  const { username, secret } = req.params;
  const token = `${username}:${secret}`;
  
  // Check rate limit
  const clientIp = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(clientIp)) {
    console.log(`✗ Rate limit exceeded for IP: ${clientIp}`);
    return res.status(429).send('Too many authentication attempts, please try again later.');
  }
  
  // Check connection limits
  if (sseClients.size >= MAX_TOTAL_SSE_CLIENTS) {
    console.log(`✗ Connection rejected: max SSE clients reached (${MAX_TOTAL_SSE_CLIENTS})`);
    return res.status(503).send('Server at capacity. Please try again later.');
  }
  
  // Require airon-nodes.json to exist (no auto-initialization)
  if (authorizedNodes === null) {
    console.log(`✗ Node rejected: no airon-nodes.json file (set AIRON_ADMIN_NODE)`);
    return res.status(403).send('Access denied. Server not initialized. Contact administrator.');
  }
  
  // Check if this node token is authorized using timing-safe comparison
  const allAuthorizedTokens = [...authorizedNodes.nodes, ...authorizedNodes.admins];
  if (!timingSafeTokenCheck(token, allAuthorizedTokens)) {
    console.log(`✗ Node rejected [${username}]: not authorized`);
    return res.status(403).send('Access denied. Contact administrator for access.');
  }
  
  // Note: We don't check if node is connected here - allow MCP connection
  // to establish even if node is offline. Tool calls will return appropriate
  // "node offline" messages instead of breaking the entire connection.
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  sseClients.set(sessionId, { res, token, username });

  const messageEndpoint = `https://dev.airon.games/mcp/${username}/${secret}?sessionId=${sessionId}`;
  res.write('event: endpoint\n');
  res.write('data: ' + messageEndpoint + '\n\n');

  req.on('close', () => {
    sseClients.delete(sessionId);
  });
});

// MCP Message Handler
app.post('/mcp/:username/:secret', async (req, res) => {
  const { username, secret } = req.params;
  const token = `${username}:${secret}`;
  const sessionId = req.query.sessionId;
  const session = sseClients.get(sessionId);
  
  if (!session) {
    return res.status(400).json({ error: 'invalid session' });
  }

  const { method, params, id } = req.body;
  let result;

  if (method === 'initialize') {
    result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'airon-relay', version: '1.0.0' }
    };
  } else if (method === 'tools/list') {
    // Check if this is an admin node
    const isAdmin = authorizedNodes && authorizedNodes.admins.includes(session.token);
    result = { tools: getTools(isAdmin) };
  } else if (method === 'tools/call') {
    const { name: toolName } = params;
    
    // Handle admin tools locally on relay
    if (toolName === 'admin') {
      const isAdmin = authorizedNodes && authorizedNodes.admins.includes(session.token);
      if (!isAdmin) {
        result = { content: [{ type: 'text', text: '❌ Admin access required' }] };
      } else {
        result = await handleAdminTool(params.arguments, session.token);
      }
    } else {
      // Forward to node
      const node = nodes.get(session.token);
      
      if (!node || node.readyState !== 1) {
        result = { content: [{ type: 'text', text: formatOfflineMessage() }] };
      } else {
        try {
          result = await forwardToNode(node, { method, params, id });
        } catch (err) {
          result = { content: [{ type: 'text', text: '⚠️ Error: ' + err.message }] };
        }
      }
    }
  } else {
    result = {};
  }

  const response = { jsonrpc: '2.0', id, result };
  session.res.write('event: message\n');
  session.res.write('data: ' + JSON.stringify(response) + '\n\n');
  res.json({ ok: true });
});

function getTools(isAdmin = false) {
  const tools = [
    { 
      name: 'claude-code', 
      description: 'Start a Claude Code development session to execute tasks with AI assistance. Always runs in interactive mode with user approval workflow.\n\n**Interactive Mode:**\n- Requires user approval for each action (file edits, command execution)\n- Allows multi-turn conversation with course correction\n- Claude Code pauses and returns when it needs permission\n- Use claude-continue to provide approval, guidance, or corrections\n- Session persists across multiple claude-continue calls\n- Example flow: Start task → Claude asks permission → User approves → Claude continues → Asks again → User provides guidance\n\n**Available capabilities:**\n- Unity Editor control (play/stop, compilation, custom tools)\n- Unity Game runtime control (scene switching, custom tools)\n- File operations (read, write, edit, create, delete)\n- Terminal execution: DENIED for security\n\n**When to use:**\n- Complex features, refactoring, anything requiring judgment\n- Multi-step tasks that benefit from oversight\n\nFor simple single operations, consider using direct tools (view, str_replace, unity-editor) for instant response without spawning Claude Code.', 
      inputSchema: { 
        type: 'object', 
        properties: { 
          description: { 
            type: 'string', 
            description: 'Natural language description of the task (e.g. "create a player movement script with WASD controls", "refactor the inventory system to use events", "fix the compilation errors in PlayerController.cs")'
          }
        }, 
        required: ['description'] 
      } 
    },
    { 
      name: 'claude-continue', 
      description: 'Continue an interactive Claude Code session by providing input or resuming after a timeout.\n\n**Use cases:**\n- Provide additional context or corrections to Claude Code\n- Resume a session that paused waiting for input\n- Multi-turn conversation with Claude Code\n\n**Session Management:**\n- If sessionId provided: Continue that specific session\n- If sessionId omitted: Continue the most recent session\n- Check status tool to see active_sessions list\n\n**Example:**\n1. claude-code: "analyze the codebase"\n2. Response: "Which directory should I focus on?"\n3. claude-continue: input="Focus on the Scripts folder"\n4. Response: Claude continues with that guidance', 
      inputSchema: { 
        type: 'object', 
        properties: { 
          sessionId: { 
            type: 'string', 
            description: 'Session ID to continue. If omitted, continues the most recent session.'
          }, 
          input: { 
            type: 'string', 
            description: 'User input to provide to Claude Code.'
          } 
        } 
      } 
    },
    { 
      name: 'claude-force', 
      description: 'Force execution of a Claude Code session with --dangerously-skip-permissions.\n\n**⚠️ IMPORTANT: This command RE-RUNS the task with full permissions**\nWhen you call claude-force, the original task is executed again with `--dangerously-skip-permissions`, which means:\n- File operations will be performed\n- Commands will be executed\n- No additional approval is required\n\n**Workflow:**\n1. claude-code runs in safe mode (analyzes and explains what it wants to do)\n2. User reviews the explanation\n3. claude-force approves and executes with full permissions\n\n**Session Management:**\n- If sessionId provided: Force execute that specific session\n- If sessionId omitted: Force execute the most recent session\n- Check status tool to see active_sessions list\n\n**Example:**\n1. claude-code: "create a file test.txt"\n2. Response: "I need permission to create the file..."\n3. claude-force\n4. Response: "✓ Created test.txt" (file actually created with --dangerously-skip-permissions)', 
      inputSchema: { 
        type: 'object', 
        properties: { 
          sessionId: { 
            type: 'string', 
            description: 'Session ID to force execute. If omitted, executes the most recent session.'
          }
        } 
      } 
    },
    { 
      name: 'status', 
      description: 'Get comprehensive status of the remote development node including:\n- Node connectivity (online/offline)\n- Claude Code availability\n- Unity Editor status (running/not running)\n- Unity Game status (running/not running)\n- Unity Editor MCP server status (with launch timestamp)\n- Unity Game MCP server status (available during Play Mode)\n- Current task information (if any Claude Code task is running)\n- Active sessions list (all interactive Claude Code sessions with their IDs and status)\n\nUse this to check what Claude Code sessions are available for claude-continue, verify Unity is running, or troubleshoot connectivity issues.', 
      inputSchema: { 
        type: 'object', 
        properties: {} 
      } 
    },
    { 
      name: 'claude-abort', 
      description: 'Immediately cancel and kill the currently running Claude Code task or session. Use when:\n- Claude Code is stuck or frozen\n- Task is taking too long\n- Wrong task was started\n- Need to start fresh with a different approach\n\n**Important notes:**\n- The session cannot be resumed after aborting\n- Only affects Claude Code tasks (does not stop Unity, MCP servers, or other operations)\n- Use sparingly - interactive mode allows course correction without aborting\n- For interactive sessions, consider using claude-continue with corrective guidance instead of aborting', 
      inputSchema: { 
        type: 'object', 
        properties: {} 
      } 
    },
    { 
      name: 'claude-sessions', 
      description: 'List all active Claude Code sessions on the remote node. Shows session IDs, status (running/completed/failed), and timestamps. Use this to:\n- See what interactive sessions are available for claude-continue\n- Check the status of sessions\n- Find session IDs to resume specific sessions\n- Monitor session lifecycle\n\nEach session includes:\n- sessionId: Unique identifier for the session\n- status: Current state (running, completed, failed, aborted)\n- started: When the session was created\n- finished: When the session completed (if applicable)\n\nSessions are automatically cleaned up 5 minutes after completion.', 
      inputSchema: { 
        type: 'object', 
        properties: {} 
      } 
    },
    { name: 'view', description: 'View file contents or directory listing. For files: returns content with line numbers. For directories: returns list of files and subdirectories with [FILE] and [DIR] markers. Optionally specify line range for large files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File or directory path (relative to working directory)' }, lines: { type: 'array', items: { type: 'number' }, description: '[start, end] line numbers (1-indexed, end=-1 for EOF)' } }, required: ['path'] } },
    { name: 'grep', description: 'Search for a pattern in files. Can search a single file or recursively through directories. Returns matching lines with file path and line number.', inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Search pattern (regex supported)' }, path: { type: 'string', description: 'File or directory path (relative to working directory)' }, recursive: { type: 'boolean', description: 'Search directories recursively (default: false)' }, ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' }, filePattern: { type: 'string', description: 'Filter files by pattern (e.g. "\\.cs$" for C# files)' }, maxResults: { type: 'number', description: 'Maximum results to return (default: 100)' } }, required: ['pattern', 'path'] } },
    { name: 'str_replace', description: 'Replace a unique string in a file with another string. The old_str must appear exactly once in the file (this prevents accidental multiple replacements). Use this for precise edits to existing files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' }, old_str: { type: 'string', description: 'String to replace (must be unique in file)' }, new_str: { type: 'string', description: 'Replacement string (omit or use empty string to delete)' } }, required: ['path', 'old_str'] } },
    { name: 'file_create', description: 'Create a new file with the specified content. Creates parent directories automatically if needed. Will overwrite existing files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' }, file_text: { type: 'string', description: 'Complete file content' } }, required: ['path', 'file_text'] } },
    { name: 'file_delete', description: 'Delete a single file. Does NOT support wildcards or directories. For bulk deletion or directory removal, use the task() tool with Claude Code.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' } }, required: ['path'] } },
    { name: 'mkdir', description: 'Create a new directory. Automatically creates parent directories if they don\'t exist (recursive by default).', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to directory to create (relative to working directory)' }, recursive: { type: 'boolean', description: 'Create parent directories if needed (default: true)', default: true } }, required: ['path'] } },
    { name: 'rmdir', description: 'Remove an empty directory. Will fail if directory contains any files or subdirectories. For recursive directory deletion, use claude-code.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to empty directory to remove (relative to working directory)' } }, required: ['path'] } },
    { name: 'file_move', description: 'Move or rename a file. Can move files between directories. Automatically creates destination directory if needed.', inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Source file path (relative to working directory)' }, destination: { type: 'string', description: 'Destination file path (relative to working directory)' } }, required: ['source', 'destination'] } },
    { name: 'unity-editor', description: 'Call a Unity Editor MCP tool directly (port 3002). Includes default tools (play, stop, pause, status, viewlog) and any custom tools configured by the user. This bypasses Claude Code for instant Unity Editor control. IMPORTANT: Unity only compiles when it is the foreground application. After file operations, remind the user to focus Unity to trigger compilation.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool name to call (e.g. "play", "status", "viewlog"). Use unity-tools to see all available tools.' }, args: { type: 'object', description: 'Tool arguments as key-value pairs (e.g. {"lines": [1, 100]})' } }, required: ['tool'] } },
    { name: 'unity-game', description: 'Call a Unity Game MCP tool directly (port 3003) during Play Mode. Includes default tools (status, execute, viewlog) and any custom tools configured by the user. This bypasses Claude Code for instant game runtime control.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool name to call (e.g. "execute", "status", "viewlog"). Use unity-tools to see all available tools.' }, args: { type: 'object', description: 'Tool arguments as key-value pairs (e.g. {"script": "return 2+2"})' } }, required: ['tool'] } },
    { name: 'unity-tools', description: 'List all available Unity MCP tools from both Editor (port 3002) and Game (port 3003) servers. Shows tool names, descriptions, and required parameters.', inputSchema: { type: 'object', properties: {} } }
  ];
  
  // Add admin tool only for admin users
  if (isAdmin) {
    tools.push({
      name: 'admin',
      description: 'Admin tool for managing authorized nodes. Subcommands: user-list (list all nodes), user-add (add node), user-delete (remove node). Only visible to admin users.',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            enum: ['user-list', 'user-add', 'user-delete'],
            description: 'Admin subcommand to execute'
          },
          nodeId: {
            type: 'string',
            description: 'Node ID/token (required for user-add and user-delete)'
          },
          isAdmin: {
            type: 'boolean',
            description: 'Make the node an admin (only for user-add, default: false)'
          }
        },
        required: ['subcommand']
      }
    });
  }
  
  return tools;
}

async function handleAdminTool(args, currentNodeId) {
  const { subcommand, nodeId, isAdmin: makeAdmin } = args;
  
  if (!subcommand) {
    return { content: [{ type: 'text', text: '❌ Missing subcommand' }] };
  }
  
  switch (subcommand) {
    case 'user-list':
      const nodeStatuses = authorizedNodes.nodes.map(n => {
        const isConnected = nodes.has(n) && nodes.get(n).readyState === 1;
        const isAdminNode = authorizedNodes.admins.includes(n);
        const isSelf = n === currentNodeId;
        return `• ${n} - ${isConnected ? '🟢 connected' : '🔴 disconnected'}${isAdminNode ? ' [ADMIN]' : ''}${isSelf ? ' [YOU]' : ''}`;
      });
      
      const result = `📋 Authorized Nodes (${authorizedNodes.nodes.length}):
${nodeStatuses.join('\n')}

👑 Admin Nodes (${authorizedNodes.admins.length}):
${authorizedNodes.admins.map(n => `• ${n}${n === currentNodeId ? ' [YOU]' : ''}`).join('\n')}`;
      
      return { content: [{ type: 'text', text: result }] };
    
    case 'user-add':
      if (!nodeId) {
        return { content: [{ type: 'text', text: '❌ Missing nodeId parameter' }] };
      }
      
      // Add to appropriate lists
      if (makeAdmin) {
        if (!authorizedNodes.admins.includes(nodeId)) {
          authorizedNodes.admins.push(nodeId);
        }
        if (!authorizedNodes.nodes.includes(nodeId)) {
          authorizedNodes.nodes.push(nodeId);
        }
      } else {
        if (!authorizedNodes.nodes.includes(nodeId)) {
          authorizedNodes.nodes.push(nodeId);
        }
      }
      
      if (saveAuthorizedNodes(authorizedNodes)) {
        console.log(`✓ Node added${makeAdmin ? ' (admin)' : ''}`);
        return { content: [{ type: 'text', text: `✅ Node added: ${nodeId}${makeAdmin ? ' (admin)' : ''}` }] };
      } else {
        return { content: [{ type: 'text', text: '❌ Failed to save nodes file' }] };
      }
    
    case 'user-delete':
      if (!nodeId) {
        return { content: [{ type: 'text', text: '❌ Missing nodeId parameter' }] };
      }
      
      // Prevent self-deletion
      if (nodeId === currentNodeId) {
        return { content: [{ type: 'text', text: '❌ Cannot delete yourself. Ask another admin to remove you if needed.' }] };
      }
      
      // Remove from both lists
      authorizedNodes.nodes = authorizedNodes.nodes.filter(n => n !== nodeId);
      authorizedNodes.admins = authorizedNodes.admins.filter(n => n !== nodeId);
      
      if (saveAuthorizedNodes(authorizedNodes)) {
        console.log(`✓ Node removed`);
        return { content: [{ type: 'text', text: `✅ Node removed: ${nodeId}` }] };
      } else {
        return { content: [{ type: 'text', text: '❌ Failed to save nodes file' }] };
      }
    
    default:
      return { content: [{ type: 'text', text: `❌ Unknown subcommand: ${subcommand}` }] };
  }
}

function formatOfflineMessage() {
  return `⚠️ AIRON Node Offline - Ask user to run: airon https://dev.airon.games/mcp`;
}

function forwardToNode(ws, request, timeout = 120000) {
  return new Promise((resolve, reject) => {
    // Check pending request limits
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return reject(new Error('Too many pending requests'));
    }
    
    const id = request.id || crypto.randomUUID();
    const timer = setTimeout(() => { 
      pendingRequests.delete(id); 
      reject(new Error('Timeout')); 
    }, timeout);
    
    pendingRequests.set(id, { 
      resolve: (r) => { 
        clearTimeout(timer); 
        pendingRequests.delete(id);
        resolve(r); 
      }, 
      reject: (e) => {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(e);
      },
      ws // Store WebSocket reference for cleanup
    });
    
    ws.send(JSON.stringify({ ...request, id }));
  });
}

// WebSocket - Nodes connect here
wss.on('connection', (ws, req) => {
  // Get token from Authorization header
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '');
  
  if (!token || token.length < 16) {
    console.log('✗ Node rejected: invalid or missing token');
    ws.close(1008, 'Invalid token');
    return;
  }
  
  // Extract username from token (format: username:secret)
  const username = token.split(':')[0];
  
  console.log(`✓ Node connected [${username}]`);
  
  nodes.set(token, ws);
  ws.token = token;
  ws.username = username;
  ws.isAlive = true;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && pendingRequests.has(msg.id)) {
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg.result);
      }
    } catch (e) {
      console.error(`WebSocket message parse error: ${e.message}`);
    }
  });
  
  ws.on('close', () => { 
    console.log(`✗ Node disconnected [${username}]`);
    nodes.delete(token);
    
    // Clean up all pending requests for this WebSocket
    for (const [id, pending] of pendingRequests.entries()) {
      if (pending.ws === ws) {
        pending.reject(new Error('WebSocket disconnected'));
        pendingRequests.delete(id);
      }
    }
  });
  
  ws.on('pong', () => { ws.isAlive = true; });
});

// WebSocket heartbeat
setInterval(() => { 
  wss.clients.forEach((ws) => { 
    if (!ws.isAlive) return ws.terminate(); 
    ws.isAlive = false; 
    ws.ping(); 
  }); 
}, 30000);

// Health check
app.get('/health', (req, res) => { 
  res.json({ 
    status: 'ok', 
    nodes: nodes.size
  }); 
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => { 
  console.log('AIRON Relay started on port ' + PORT);
  
  if (authorizedNodes === null) {
    console.log('⚠️  ERROR: No airon-nodes.json found and AIRON_ADMIN_NODE not set.');
    console.log('⚠️  Server will reject all connections. Set AIRON_ADMIN_NODE environment variable.');
  } else {
    console.log(`✓ Authorized nodes: ${authorizedNodes.nodes.length}, Admins: ${authorizedNodes.admins.length}`);
  }
});
