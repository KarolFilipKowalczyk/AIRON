#!/usr/bin/env node
/**
 * airon-relay.js - AIRON Relay Server
 * 
 * Copyright (c) 2025 Karol Kowalczyk
 * Licensed under the MIT License
 * See: https://opensource.org/licenses/MIT
 * 
 * MCP relay server for connecting Claude.ai to remote AIRON nodes.
 * Uses OAuth/OIDC for authentication (provider-agnostic).
 */

import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import * as jose from 'jose';

const app = express();
const server = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Configuration
// ============================================================

const OIDC_ISSUER = process.env.AIRON_OIDC_ISSUER || 'https://accounts.google.com';
const OIDC_CLIENT_ID = process.env.AIRON_OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.AIRON_OIDC_CLIENT_SECRET;
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.AIRON_BASE_URL || 'https://dev.airon.games';

// Connection limits
const MAX_TOTAL_SSE_CLIENTS = 1000;
const MAX_PENDING_REQUESTS = 10000;
const SSE_IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const FORWARD_TIMEOUT = 300000; // 5 minutes

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 100;

// ============================================================
// OIDC Discovery and Token Verification
// ============================================================

let oidcConfig = null;
let jwks = null;

async function discoverOIDC() {
  if (oidcConfig) return oidcConfig;
  
  const discoveryUrl = `${OIDC_ISSUER}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl);
  oidcConfig = await response.json();
  return oidcConfig;
}

async function getJWKS() {
  if (!jwks) {
    const config = await discoverOIDC();
    jwks = jose.createRemoteJWKSet(new URL(config.jwks_uri));
  }
  return jwks;
}

async function verifyToken(idToken) {
  const keySet = await getJWKS();
  
  const { payload } = await jose.jwtVerify(idToken, keySet, {
    issuer: OIDC_ISSUER,
    audience: OIDC_CLIENT_ID
  });
  
  return {
    email: payload.email,
    sub: payload.sub,
    name: payload.name
  };
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  
  try {
    // Check if it's a Claude.ai session token (our format: uuid-uuid)
    // JWTs have dots (header.payload.signature), our session tokens don't
    const isJWT = token.includes('.');
    const isSessionToken = !isJWT && claudeSessions.has(token);
    
    if (isSessionToken) {
      const session = claudeSessions.get(token);
      
      // Check if ID token needs refresh (5 min before expiry)
      if (Date.now() > session.idTokenExpiresAt - 5 * 60 * 1000) {
        console.log(`🔄 Refreshing ID token for ${session.email}...`);
        
        try {
          const config = await discoverOIDC();
          const tokenResponse = await fetch(config.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: session.refreshToken,
              client_id: OIDC_CLIENT_ID,
              client_secret: OIDC_CLIENT_SECRET
            })
          });
          
          if (!tokenResponse.ok) {
            const err = await tokenResponse.text();
            throw new Error(`Token refresh failed: ${err}`);
          }
          
          const tokens = await tokenResponse.json();
          
          // Update session with new tokens
          session.idToken = tokens.id_token;
          session.idTokenExpiresAt = Date.now() + 55 * 60 * 1000;
          if (tokens.refresh_token) {
            session.refreshToken = tokens.refresh_token;
          }
          
          console.log(`✓ ID token refreshed for ${session.email}`);
        } catch (refreshErr) {
          console.log(`✗ Token refresh failed: ${refreshErr.message}`);
          claudeSessions.delete(token);
          return res.status(401).json({ error: 'Session expired, please re-authenticate' });
        }
      }
      
      // Use session data
      req.user = { email: session.email, name: session.name };
      return next();
    }
    
    // Otherwise, treat as raw ID token (for node connections)
    const user = await verifyToken(token);
    req.user = user;
    next();
  } catch (err) {
    console.log(`✗ Auth failed: ${err.message}`);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================
// OAuth Proxy (for Claude.ai)
// ============================================================

const authStates = new Map(); // state -> { claudeRedirectUri, claudeState, codeVerifier, clientType }
const authCodes = new Map();  // code -> { idToken, refreshToken, user, expiresAt }
const nodeTokens = new Map(); // state -> { idToken, refreshToken, expiresAt }
const claudeSessions = new Map(); // sessionToken -> { email, name, refreshToken, idToken, idTokenExpiresAt }

// OAuth authorize - works for both Claude.ai and airon.js
app.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, client_type } = req.query;
  
  const isNodeClient = client_type === 'node';
  console.log(`📥 OAuth authorize: ${isNodeClient ? 'node client' : 'Claude.ai'}`);
  
  const config = await discoverOIDC();
  
  // Generate our own state to track this flow
  const ourState = crypto.randomUUID();
  
  // Store client info so we can handle callback appropriately
  authStates.set(ourState, {
    claudeRedirectUri: redirect_uri,
    claudeState: state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    clientType: isNodeClient ? 'node' : 'claude',
    createdAt: Date.now()
  });
  
  // Redirect to Google's authorize endpoint
  const authUrl = new URL(config.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', ourState);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  
  res.redirect(authUrl.toString());
});

// Google redirects here after user authenticates
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  
  console.log(`📥 OAuth callback: state=${state?.substring(0, 8)}...`);
  
  if (error) {
    console.log(`✗ OAuth error: ${error}`);
    return res.status(400).send(`Authentication error: ${error}`);
  }
  
  const stateData = authStates.get(state);
  if (!stateData) {
    console.log(`✗ Invalid state`);
    return res.status(400).send('Invalid state parameter');
  }
  
  authStates.delete(state);
  
  try {
    const config = await discoverOIDC();
    
    // Exchange code for tokens with Google
    const tokenResponse = await fetch(config.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE_URL}/callback`,
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET
      })
    });
    
    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${err}`);
    }
    
    const tokens = await tokenResponse.json();
    
    // Handle node client - store tokens for polling
    if (stateData.clientType === 'node') {
      nodeTokens.set(stateData.claudeState, {
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      
      console.log(`✓ Node auth success, tokens ready for polling`);
      return res.send(`
        <html>
        <head><title>AIRON Authentication</title></head>
        <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e;">
          <div style="text-align: center; color: #eee;">
            <h1 style="color: #4ade80;">✓ Authentication successful!</h1>
            <p>You can close this window and return to the terminal.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Handle Claude.ai - generate code and redirect
    const ourCode = crypto.randomUUID();
    
    // Verify the ID token to get user info
    const user = await verifyToken(tokens.id_token);
    
    authCodes.set(ourCode, {
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      user: user,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes to exchange code
    });
    
    // Redirect back to Claude with our code
    const redirectUrl = new URL(stateData.claudeRedirectUri);
    redirectUrl.searchParams.set('code', ourCode);
    if (stateData.claudeState) {
      redirectUrl.searchParams.set('state', stateData.claudeState);
    }
    
    console.log(`✓ OAuth success, redirecting to Claude`);
    res.redirect(redirectUrl.toString());
    
  } catch (err) {
    console.log(`✗ OAuth callback error: ${err.message}`);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// Claude.ai calls this to exchange code for token
app.post('/token', async (req, res) => {
  const { grant_type, code, redirect_uri, code_verifier } = req.body;
  
  console.log(`📥 Token exchange: grant_type=${grant_type}`);
  
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  
  const codeData = authCodes.get(code);
  if (!codeData) {
    console.log(`✗ Invalid code`);
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  if (Date.now() > codeData.expiresAt) {
    authCodes.delete(code);
    console.log(`✗ Code expired`);
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  authCodes.delete(code);
  
  // Generate a long-lived session token for Claude.ai
  const sessionToken = crypto.randomUUID() + '-' + crypto.randomUUID();
  
  // Store session with refresh token for auto-refresh
  claudeSessions.set(sessionToken, {
    email: codeData.user.email,
    name: codeData.user.name,
    refreshToken: codeData.refreshToken,
    idToken: codeData.idToken,
    idTokenExpiresAt: Date.now() + 55 * 60 * 1000, // ID tokens last ~1 hour, refresh at 55 min
    createdAt: Date.now()
  });
  
  console.log(`✓ Session created for ${codeData.user.email} (expires in 7 days)`);
  
  res.json({
    access_token: sessionToken,
    token_type: 'Bearer',
    expires_in: 7 * 24 * 3600 // Tell Claude.ai it's valid for 7 days
  });
});

// Node client polls this for tokens
app.get('/poll-token', (req, res) => {
  const { state } = req.query;
  
  const tokenData = nodeTokens.get(state);
  
  if (!tokenData) {
    return res.json({ status: 'pending' });
  }
  
  if (Date.now() > tokenData.expiresAt) {
    nodeTokens.delete(state);
    return res.status(400).json({ error: 'Token expired' });
  }
  
  nodeTokens.delete(state);
  console.log(`✓ Node token retrieved`);
  
  res.json({
    status: 'ready',
    id_token: tokenData.idToken,
    refresh_token: tokenData.refreshToken
  });
});

// Cleanup expired states and codes
setInterval(() => {
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  
  for (const [state, data] of authStates.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) authStates.delete(state);
  }
  for (const [code, data] of authCodes.entries()) {
    if (now > data.expiresAt) authCodes.delete(code);
  }
  for (const [state, data] of nodeTokens.entries()) {
    if (now > data.expiresAt) nodeTokens.delete(state);
  }
  // Cleanup Claude sessions older than 7 days
  for (const [token, session] of claudeSessions.entries()) {
    if (now - session.createdAt > SEVEN_DAYS) {
      console.log(`🧹 Expired session for ${session.email}`);
      claudeSessions.delete(token);
    }
  }
}, 60000);

// ============================================================
// Rate Limiting
// ============================================================

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000);

// ============================================================
// In-Memory State
// ============================================================

const mcpSessions = new Map();
const nodeConnections = new Map();
const pendingRequests = new Map();

// ============================================================
// Helper Functions
// ============================================================

function resetIdleTimer(session, sessionId) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    console.log(`✗ MCP session timeout: ${session.user.email} (${sessionId.substring(0, 8)}...)`);
    mcpSessions.delete(sessionId);
    try { session.res.end(); } catch {}
  }, SSE_IDLE_TIMEOUT);
  session.lastActivity = Date.now();
}

function formatOfflineMessage() {
  return `⚠️ AIRON Node Offline

Make sure to ask what is the user preference before continuing.

Options:
1. Start the AIRON node on your dev machine
2. Continue working with local bash tools only

Note: Remote Unity control, Claude Code sessions, and file operations require the node to be online.`;
}

function forwardToNode(nodeConnection, userEmail, request, timeout = FORWARD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return reject(new Error('Too many pending requests'));
    }
    
    const requestId = crypto.randomUUID();
    
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Timeout'));
    }, timeout);
    
    pendingRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(err);
      },
      userEmail,
      timer
    });
    
    const event = {
      id: requestId,
      method: request.method,
      params: request.params
    };
    
    try {
      nodeConnection.res.write(`event: request\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('Failed to send request to node'));
    }
  });
}

// ============================================================
// Tools Definition
// ============================================================

function getTools() {
  return [
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
          sessionId: { type: 'string', description: 'Session ID to continue. If omitted, continues the most recent session.' }, 
          input: { type: 'string', description: 'User input to provide to Claude Code.' } 
        } 
      } 
    },
    { 
      name: 'claude-force', 
      description: 'Force execution of a Claude Code session with --dangerously-skip-permissions.\n\n**⚠️ IMPORTANT: This command RE-RUNS the task with full permissions**\nWhen you call claude-force, the original task is executed again with `--dangerously-skip-permissions`, which means:\n- File operations will be performed\n- Commands will be executed\n- No additional approval is required\n\n**Workflow:**\n1. claude-code runs in safe mode (analyzes and explains what it wants to do)\n2. User reviews the explanation\n3. claude-force approves and executes with full permissions\n\n**Session Management:**\n- If sessionId provided: Force execute that specific session\n- If sessionId omitted: Force execute the most recent session\n- Check status tool to see active_sessions list\n\n**Example:**\n1. claude-code: "create a file test.txt"\n2. Response: "I need permission to create the file..."\n3. claude-force\n4. Response: "✓ Created test.txt" (file actually created with --dangerously-skip-permissions)', 
      inputSchema: { 
        type: 'object', 
        properties: { 
          sessionId: { type: 'string', description: 'Session ID to force execute. If omitted, executes the most recent session.' }
        } 
      } 
    },
    { 
      name: 'status', 
      description: 'READ-ONLY: Get comprehensive status of the remote development node. Does not modify files, run code, or control Unity.\n\nReturns information about:\n- Node connectivity (online/offline)\n- Claude Code availability\n- Unity Editor status (running/not running)\n- Unity Game status (running/not running)\n- Unity Editor MCP server status (with launch timestamp)\n- Unity Game MCP server status (available during Play Mode)\n- Current task information (if any Claude Code task is running)\n- Active sessions list (all interactive Claude Code sessions with their IDs and status)\n\nUse this to check what Claude Code sessions are available for claude-continue, verify Unity is running, or troubleshoot connectivity issues.', 
      inputSchema: { type: 'object', properties: {} } 
    },
    { 
      name: 'claude-abort', 
      description: 'Immediately cancel and kill the currently running Claude Code task or session. Use when:\n- Claude Code is stuck or frozen\n- Task is taking too long\n- Wrong task was started\n- Need to start fresh with a different approach\n\n**Important notes:**\n- The session cannot be resumed after aborting\n- Only affects Claude Code tasks (does not stop Unity, MCP servers, or other operations)\n- Use sparingly - interactive mode allows course correction without aborting\n- For interactive sessions, consider using claude-continue with corrective guidance instead of aborting', 
      inputSchema: { type: 'object', properties: {} } 
    },
    { 
      name: 'claude-sessions', 
      description: 'READ-ONLY: List all active Claude Code sessions on the remote node. Does not modify files, run code, or control Unity.\n\nShows session IDs, status (running/completed/failed), and timestamps. Use this to:\n- See what interactive sessions are available for claude-continue\n- Check the status of sessions\n- Find session IDs to resume specific sessions\n- Monitor session lifecycle\n\nEach session includes:\n- sessionId: Unique identifier for the session\n- status: Current state (running, completed, failed, aborted)\n- started: When the session was created\n- finished: When the session completed (if applicable)\n\nSessions are automatically cleaned up 5 minutes after completion.', 
      inputSchema: { type: 'object', properties: {} } 
    },
    { name: 'view', description: 'READ-ONLY: View file contents or directory listing. Does not modify files.\n\nFor files: returns content with line numbers. For directories: returns list of files and subdirectories with [FILE] and [DIR] markers. Optionally specify line range for large files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File or directory path (relative to working directory)' }, lines: { type: 'array', items: { type: 'number' }, description: '[start, end] line numbers (1-indexed, end=-1 for EOF)' } }, required: ['path'] } },
    { name: 'grep', description: 'READ-ONLY: Search for a pattern in files. Does not modify files.\n\nCan search a single file or recursively through directories. Returns matching lines with file path and line number.', inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Search pattern (regex supported)' }, path: { type: 'string', description: 'File or directory path (relative to working directory)' }, recursive: { type: 'boolean', description: 'Search directories recursively (default: false)' }, ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' }, filePattern: { type: 'string', description: 'Filter files by pattern (e.g. "\\.cs$" for C# files)' }, maxResults: { type: 'number', description: 'Maximum results to return (default: 100)' } }, required: ['pattern', 'path'] } },
    { name: 'str_replace', description: 'Replace a unique string in a file with another string. The old_str must appear exactly once in the file (this prevents accidental multiple replacements). Use this for precise edits to existing files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' }, old_str: { type: 'string', description: 'String to replace (must be unique in file)' }, new_str: { type: 'string', description: 'Replacement string (omit or use empty string to delete)' } }, required: ['path', 'old_str'] } },
    { name: 'file_create', description: 'Create a new file with the specified content. Creates parent directories automatically if needed. Will overwrite existing files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' }, file_text: { type: 'string', description: 'Complete file content' } }, required: ['path', 'file_text'] } },
    { name: 'file_delete', description: 'Delete a single file. Does NOT support wildcards or directories. For bulk deletion or directory removal, use the task() tool with Claude Code.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file (relative to working directory)' } }, required: ['path'] } },
    { name: 'mkdir', description: 'Create a new directory. Automatically creates parent directories if they don\'t exist (recursive by default).', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to directory to create (relative to working directory)' }, recursive: { type: 'boolean', description: 'Create parent directories if needed (default: true)', default: true } }, required: ['path'] } },
    { name: 'rmdir', description: 'Remove an empty directory. Will fail if directory contains any files or subdirectories. For recursive directory deletion, use claude-code.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to empty directory to remove (relative to working directory)' } }, required: ['path'] } },
    { name: 'file_move', description: 'Move or rename a file. Can move files between directories. Automatically creates destination directory if needed.', inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Source file path (relative to working directory)' }, destination: { type: 'string', description: 'Destination file path (relative to working directory)' } }, required: ['source', 'destination'] } },
    { name: 'unity-editor', description: 'Call a Unity Editor MCP tool directly (port 3002). Includes default tools (play, stop, pause, status, viewlog) and any custom tools configured by the user. This bypasses Claude Code for instant Unity Editor control. IMPORTANT: Unity only compiles when it is the foreground application. After file operations, remind the user to focus Unity to trigger compilation.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool name to call (e.g. "play", "status", "viewlog"). Use unity-tools to see all available tools.' }, args: { type: 'object', description: 'Tool arguments as key-value pairs (e.g. {"lines": [1, 100]})' } }, required: ['tool'] } },
    { name: 'unity-game', description: 'Call a Unity Game MCP tool directly (port 3003) during Play Mode. Includes default tools (status, execute, viewlog) and any custom tools configured by the user. This bypasses Claude Code for instant game runtime control.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool name to call (e.g. "execute", "status", "viewlog"). Use unity-tools to see all available tools.' }, args: { type: 'object', description: 'Tool arguments as key-value pairs (e.g. {"script": "return 2+2"})' } }, required: ['tool'] } },
    { name: 'unity-tools', description: 'READ-ONLY: List all available Unity MCP tools from both Editor (port 3002) and Game (port 3003) servers. Does not modify files or control Unity.\n\nShows tool names, descriptions, and required parameters.', inputSchema: { type: 'object', properties: {} } }
  ];
}

// ============================================================
// /mcp - Claude.ai MCP Endpoint
// ============================================================

app.get('/mcp', authMiddleware, (req, res) => {
  const { user } = req;
  const clientIp = req.ip || req.connection.remoteAddress;
  
  console.log(`📥 MCP connection: ${user.email} from ${clientIp}`);
  
  if (!checkRateLimit(clientIp)) {
    console.log(`✗ Rate limit exceeded: ${user.email}`);
    return res.status(429).send('Too many requests, please try again later.');
  }
  
  if (mcpSessions.size >= MAX_TOTAL_SSE_CLIENTS) {
    console.log(`✗ Connection rejected (capacity): ${user.email}`);
    return res.status(503).send('Server at capacity. Please try again later.');
  }
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const sessionId = crypto.randomUUID();
  
  const session = {
    res,
    user,
    lastActivity: Date.now(),
    idleTimer: null
  };
  
  resetIdleTimer(session, sessionId);
  mcpSessions.set(sessionId, session);
  
  console.log(`✓ MCP session created: ${user.email} (${sessionId.substring(0, 8)}...)`);
  
  const messageEndpoint = `${BASE_URL}/mcp?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${messageEndpoint}\n\n`);
  
  req.on('close', () => {
    const s = mcpSessions.get(sessionId);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    mcpSessions.delete(sessionId);
    console.log(`✗ MCP session closed: ${user.email} (${sessionId.substring(0, 8)}...)`);
  });
});

app.post('/mcp', authMiddleware, async (req, res) => {
  const { sessionId } = req.query;
  const session = mcpSessions.get(sessionId);
  
  if (!session) {
    console.log(`✗ Invalid session: ${req.user.email} (session not found)`);
    return res.status(400).json({ error: 'Invalid session' });
  }
  
  if (session.user.email !== req.user.email) {
    console.log(`✗ Session mismatch: ${req.user.email} tried to use session of ${session.user.email}`);
    return res.status(403).json({ error: 'Session belongs to different user' });
  }
  
  resetIdleTimer(session, sessionId);
  
  const { method, params, id } = req.body;
  let result;
  
  if (method === 'initialize') {
    result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'airon-relay', version: '1.0.0' }
    };
  } else if (method === 'tools/list') {
    result = { tools: getTools() };
  } else if (method === 'tools/call') {
    const nodeConnection = nodeConnections.get(session.user.email);
    
    if (!nodeConnection) {
      result = { content: [{ type: 'text', text: formatOfflineMessage() }] };
    } else {
      try {
        result = await forwardToNode(nodeConnection, session.user.email, { method, params, id });
      } catch (err) {
        result = { content: [{ type: 'text', text: '⚠️ Error: ' + err.message }] };
      }
    }
  } else {
    result = {};
  }
  
  const response = { jsonrpc: '2.0', id, result };
  session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  res.json({ ok: true });
});

// ============================================================
// /node - airon.js Node Endpoint
// ============================================================

app.get('/node', authMiddleware, (req, res) => {
  const { user } = req;
  
  console.log(`📥 Node connection: ${user.email}`);
  
  const existingConnection = nodeConnections.get(user.email);
  if (existingConnection) {
    console.log(`⚠️ Replacing existing node connection: ${user.email}`);
    if (existingConnection.pingInterval) clearInterval(existingConnection.pingInterval);
    try { existingConnection.res.end(); } catch {}
    
    for (const [reqId, pending] of pendingRequests.entries()) {
      if (pending.userEmail === user.email) {
        pending.reject(new Error('Node reconnected'));
        pendingRequests.delete(reqId);
      }
    }
  }
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const nodeId = crypto.randomUUID();
  
  const pingInterval = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      clearInterval(pingInterval);
    }
  }, 25000);
  
  nodeConnections.set(user.email, {
    res,
    user,
    nodeId,
    lastActivity: Date.now(),
    pingInterval
  });
  
  console.log(`✓ Node connected: ${user.email} (${nodeId.substring(0, 8)}...)`);
  
  res.write(`event: connected\ndata: ${JSON.stringify({ nodeId })}\n\n`);
  
  req.on('close', () => {
    const conn = nodeConnections.get(user.email);
    if (conn?.pingInterval) clearInterval(conn.pingInterval);
    nodeConnections.delete(user.email);
    console.log(`✗ Node disconnected: ${user.email}`);
    
    for (const [reqId, pending] of pendingRequests.entries()) {
      if (pending.userEmail === user.email) {
        pending.reject(new Error('Node disconnected'));
        pendingRequests.delete(reqId);
      }
    }
  });
});

app.post('/node', authMiddleware, (req, res) => {
  const { requestId } = req.query;
  const pending = pendingRequests.get(requestId);
  
  if (!pending) {
    return res.status(400).json({ error: 'Unknown request ID' });
  }
  
  if (pending.userEmail !== req.user.email) {
    return res.status(403).json({ error: 'Request belongs to different user' });
  }
  
  pending.resolve(req.body.result);
  res.json({ ok: true });
});

// ============================================================
// Health Check
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mcpSessions: mcpSessions.size,
    nodeConnections: nodeConnections.size,
    pendingRequests: pendingRequests.size
  });
});

// ============================================================
// Start Server
// ============================================================

export async function startRelay() {
  if (!OIDC_CLIENT_ID) {
    console.error('❌ ERROR: AIRON_OIDC_CLIENT_ID environment variable not set');
    process.exit(1);
  }
  if (!OIDC_CLIENT_SECRET) {
    console.error('❌ ERROR: AIRON_OIDC_CLIENT_SECRET environment variable not set');
    process.exit(1);
  }
  
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║             AIRON Relay Server               ║
╚══════════════════════════════════════════════╝

  🌐 Listening on port ${PORT}
  🔐 OIDC enabled (issuer: ${OIDC_ISSUER})
  
  Endpoints:
    GET  /authorize        OAuth authorization
    GET  /callback         OAuth callback
    POST /token            Token exchange
    GET  /mcp              Claude.ai SSE connection
    POST /mcp?sessionId=x  Claude.ai MCP messages
    GET  /node             airon.js SSE connection
    POST /node?requestId=x airon.js tool responses
    GET  /health           Health check
`);
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startRelay();
}
