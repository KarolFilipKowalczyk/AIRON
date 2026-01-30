#!/usr/bin/env node
/**
 * airon.js - AIRON (AI Remote Operations Node)
 *
 * Copyright (c) 2025 Karol Kowalczyk
 * Licensed under the MIT License
 * See: https://opensource.org/licenses/MIT
 *
 * Unified entry point for AIRON - can run as node client, relay server, or bridge.
 * Uses OAuth/OIDC for authentication (provider-agnostic).
 *
 * Usage:
 *   airon [options] [relay-url]           Node mode (default) - connect to relay
 *   airon -m relay                        Relay mode - run as relay server
 *   airon -m bridge [port]                Bridge mode - stdio MCP bridge (generic)
 *   airon -m bridge --editor [port]       Bridge mode - Unity Editor MCP
 *   airon -m bridge --game [port]         Bridge mode - Unity Game MCP
 *
 * Run 'airon --help' for full options.
 */

import { platform, homedir } from 'os';
import { execSync, spawnSync, spawn } from 'child_process';
import { resolve, relative, join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { randomUUID } from 'crypto';
import readline from 'readline';
import open from 'open';

// Static imports for all modes (required for SEA bundle)
import { startRelay } from './airon-relay.js';
import { startBridge } from './airon-bridge.js';

// ============================================================
// Configuration
// ============================================================

const CREDENTIALS_PATH = join(homedir(), '.airon', 'credentials.json');
const DEFAULT_RELAY_URL = 'https://dev.airon.games';
const DEFAULT_OIDC_ISSUER = 'https://accounts.google.com';

let WORKING_DIR = process.cwd();
let RELAY_URL = DEFAULT_RELAY_URL;
let UNITY_EDITOR_PORT = 3002;
let UNITY_GAME_PORT = 3003;

// OIDC configuration
let OIDC_ISSUER = null;
let OIDC_CLIENT_ID = null;
let OIDC_CLIENT_SECRET = null;

// OIDC endpoints (discovered at runtime)
let oidcConfig = null;

// Current tokens
let currentIdToken = null;
let currentCredentials = null;

// ============================================================
// Global State
// ============================================================

let currentTask = null;
let isAborted = false;
let activeSessions = new Map();
let currentSessionId = null;
let currentProcess = null;
let taskCompletionResolve = null;
let readlineInterface = null;

// ============================================================
// Path Validation
// ============================================================

function validatePath(requestedPath) {
  if (requestedPath.startsWith('\\\\') || requestedPath.match(/^[a-zA-Z]:/)) {
    throw new Error('Access denied: Absolute and UNC paths not allowed');
  }
  
  const absolutePath = resolve(WORKING_DIR, requestedPath);
  const relativePath = relative(WORKING_DIR, absolutePath);
  
  if (relativePath.startsWith('..')) {
    throw new Error('Access denied: Path must be within working directory');
  }
  
  try {
    const realPath = realpathSync(absolutePath);
    const realRelative = relative(WORKING_DIR, realPath);
    if (realRelative.startsWith('..')) {
      throw new Error('Access denied: Symlink points outside working directory');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  
  return absolutePath;
}

// ============================================================
// OIDC Discovery and Token Management
// ============================================================

async function discoverOIDC() {
  if (oidcConfig) return oidcConfig;
  
  const discoveryUrl = `${OIDC_ISSUER}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl);
  oidcConfig = await response.json();
  return oidcConfig;
}

async function loadCredentials() {
  try {
    const data = readFileSync(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveCredentials(credentials) {
  const dir = dirname(CREDENTIALS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

async function refreshTokens(refreshToken) {
  const config = await discoverOIDC();
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OIDC_CLIENT_ID,
    client_secret: OIDC_CLIENT_SECRET
  });
  
  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }
  
  return response.json();
}

async function authenticate() {
  if (!OIDC_CLIENT_ID) {
    throw new Error('OIDC client ID not configured. Use --client-id');
  }
  
  // Check for existing credentials
  const existing = await loadCredentials();
  
  if (existing?.refresh_token) {
    try {
      console.log('  🔄 Refreshing token...');
      const tokens = await refreshTokens(existing.refresh_token);
      tokens.refresh_token = tokens.refresh_token || existing.refresh_token;
      await saveCredentials(tokens);
      currentCredentials = tokens;
      console.log('  ✓ Token refreshed');
      return tokens.id_token;
    } catch (err) {
      console.log('  ⚠️ Token refresh failed, re-authenticating...');
    }
  }
  
  // Start OAuth flow via relay
  const state = randomUUID();
  
  const authUrl = new URL(`${RELAY_URL}/authorize`);
  authUrl.searchParams.set('client_type', 'node');
  authUrl.searchParams.set('state', state);
  
  console.log('  🔐 Opening browser for authentication...');
  console.log(`  📎 If browser doesn't open, visit: ${authUrl.toString()}\n`);
  
  open(authUrl.toString()).catch(() => {
    console.log('  ⚠️ Could not open browser automatically');
  });
  
  // Poll for tokens
  console.log('  ⏳ Waiting for authentication...');
  const pollInterval = 2000;
  const maxAttempts = 150;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    
    try {
      const response = await fetch(`${RELAY_URL}/poll-token?state=${state}`);
      const data = await response.json();
      
      if (data.status === 'ready') {
        const tokens = {
          id_token: data.id_token,
          refresh_token: data.refresh_token
        };
        await saveCredentials(tokens);
        currentCredentials = tokens;
        console.log('  ✓ Authentication successful');
        return tokens.id_token;
      }
      
      if (data.error) {
        throw new Error(data.error);
      }
    } catch (err) {
      if (err.message !== 'fetch failed') {
        throw err;
      }
    }
  }
  
  throw new Error('Authentication timeout');
}

async function refreshTokenIfNeeded() {
  if (!currentCredentials?.refresh_token) return;
  
  try {
    const parts = currentCredentials.id_token.split('.');
    if (parts.length !== 3) return;
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const expiryTime = payload.exp * 1000;
    
    if (Date.now() > expiryTime - 5 * 60 * 1000) {
      console.log('  🔄 Token expiring soon, refreshing...');
      const tokens = await refreshTokens(currentCredentials.refresh_token);
      tokens.refresh_token = tokens.refresh_token || currentCredentials.refresh_token;
      await saveCredentials(tokens);
      currentCredentials = tokens;
      currentIdToken = tokens.id_token;
      console.log('  ✓ Token refreshed');
    }
  } catch (err) {
    console.error('  ❌ Token refresh failed:', err.message);
  }
}

// ============================================================
// Claude Code Session Management
// ============================================================

function spawnClaudeCode(args, sessionId, sessionData) {
  return new Promise((resolve) => {
    const isWindows = platform() === 'win32';
    let localOutputBuffer = '';
    
    let proc;
    if (isWindows) {
      proc = spawn('cmd', ['/c', 'claude', ...args], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      proc = spawn('claude', args, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    
    proc.stdin.end();
    
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      console.log('     ' + text.replace(/\n/g, '\n     '));
      localOutputBuffer += text;
    });
    
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      localOutputBuffer += text;
      process.stdout.write('     ' + text.replace(/\n/g, '\n     '));
    });
    
    proc.on('close', (code) => {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.status = isAborted ? 'aborted' : (code === 0 ? 'completed' : 'failed');
        session.finished = new Date().toISOString();
        
        if (sessionData.cleanupAfter) {
          setTimeout(() => {
            activeSessions.delete(sessionId);
            console.log(`  🧹 Cleaned up session ${sessionId}`);
          }, 5 * 60 * 1000);
        }
      }
      
      const status = isAborted ? 'aborted' : (code === 0 ? 'completed' : 'failed');
      
      currentTask = {
        ...currentTask,
        status: status,
        finished: new Date().toISOString(),
        exitCode: code,
        output: localOutputBuffer
      };
      
      if (isAborted) {
        console.log(`\n  🛑 Session aborted\n`);
      } else {
        const successMsg = sessionData.successMessage || 'Session completed';
        const failMsg = sessionData.failMessage || `Session failed (exit ${code})`;
        console.log(code === 0 ? `\n  ✓ ${successMsg}\n` : `\n  ❌ ${failMsg}\n`);
      }
      
      isAborted = false;
      currentProcess = null;
      
      if (taskCompletionResolve) {
        const resolver = taskCompletionResolve;
        taskCompletionResolve = null;
        resolver(localOutputBuffer);
      } else {
        resolve(localOutputBuffer);
      }
    });
    
    proc.on('error', (err) => {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.status = 'error';
        session.finished = new Date().toISOString();
      }
      console.log(`\n  ❌ Process error: ${err.message}\n`);
      currentProcess = null;
      
      if (taskCompletionResolve) {
        taskCompletionResolve(`❌ Error: ${err.message}`);
        taskCompletionResolve = null;
      } else {
        resolve(`❌ Error: ${err.message}`);
      }
    });
    
    currentProcess = proc;
  });
}

// ============================================================
// Command Line Parsing
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  const argAliases = {
    'h': 'help',
    'm': 'mode',
    'e': 'editor-port',
    'g': 'game-port',
    'p': 'path'
  };

  const booleanFlags = ['help', 'h'];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      if (booleanFlags.includes(key)) {
        parsed[key] = true;
      } else {
        const value = args[i + 1];
        if (value && !value.startsWith('-')) {
          parsed[key] = value;
          i++;
        }
      }
    } else if (args[i].startsWith('-')) {
      const shortKey = args[i].substring(1);
      const longKey = argAliases[shortKey] || shortKey;
      if (booleanFlags.includes(shortKey)) {
        parsed[longKey] = true;
      } else {
        const value = args[i + 1];
        if (value && !value.startsWith('-')) {
          parsed[longKey] = value;
          i++;
        }
      }
    } else if (!parsed.relay) {
      parsed.relay = args[i];
    }
  }

  return parsed;
}

const args = parseArgs();

// Handle --help flag
if (args.help || args.h) {
  console.log('\n  AIRON - AI Remote Operations Node\n');
  console.log('  Usage: airon [options] [relay-url]\n');
  console.log('  Modes:');
  console.log('    -m, --mode <mode>          Operating mode: node (default), relay, or bridge');
  console.log('');
  console.log('  Node Mode (default) - Connect to relay server:');
  console.log('    airon [relay-url] [options]');
  console.log('    --issuer <url>             OIDC issuer URL (default: https://accounts.google.com)');
  console.log('    --client-id <id>           OAuth Client ID');
  console.log('    --client-secret <secret>   OAuth Client Secret (for token refresh)');
  console.log('    -e, --editor-port <port>   Unity Editor MCP port (default: 3002)');
  console.log('    -g, --game-port <port>     Unity Game MCP port (default: 3003)');
  console.log('    -p, --path <directory>     Working directory (default: current)');
  console.log('');
  console.log('  Relay Mode - Run as relay server:');
  console.log('    airon -m relay');
  console.log('    Environment variables:');
  console.log('      PORT                     Server port (default: 3001)');
  console.log('      AIRON_OIDC_ISSUER        OIDC issuer URL');
  console.log('      AIRON_OIDC_CLIENT_ID     OAuth Client ID');
  console.log('');
  console.log('  Bridge Mode - Stdio MCP bridge:');
  console.log('    airon -m bridge [port]               Generic MCP on specified port');
  console.log('    airon -m bridge --editor [port]      Unity Editor MCP (default: 3002)');
  console.log('    airon -m bridge --game [port]        Unity Game MCP (default: 3003)');
  console.log('');
  console.log('  General:');
  console.log('    -h, --help                 Show this help message');
  console.log('');
  console.log('  Examples:');
  console.log('    airon --client-id <id>');
  console.log('    airon https://custom-relay.com --client-id <id>');
  console.log('    airon -m relay');
  console.log('    airon -m bridge --editor\n');
  process.exit(0);
}

// Mode routing
const runMode = args.mode || 'node';

if (runMode === 'relay') {
  startRelay();
} else if (runMode === 'bridge') {
  const bridgeArgs = process.argv.slice(2).filter(a => a !== '-m' && a !== '--mode' && a !== 'bridge');
  let bridgeMode = null;
  let bridgePort = null;

  for (let i = 0; i < bridgeArgs.length; i++) {
    if (bridgeArgs[i] === '--editor') {
      bridgeMode = 'editor';
      if (bridgeArgs[i + 1] && !bridgeArgs[i + 1].startsWith('--') && !isNaN(parseInt(bridgeArgs[i + 1]))) {
        bridgePort = parseInt(bridgeArgs[i + 1]);
        i++;
      }
    } else if (bridgeArgs[i] === '--game') {
      bridgeMode = 'game';
      if (bridgeArgs[i + 1] && !bridgeArgs[i + 1].startsWith('--') && !isNaN(parseInt(bridgeArgs[i + 1]))) {
        bridgePort = parseInt(bridgeArgs[i + 1]);
        i++;
      }
    } else if (!bridgeArgs[i].startsWith('-') && !isNaN(parseInt(bridgeArgs[i]))) {
      bridgePort = parseInt(bridgeArgs[i]);
    }
  }

  startBridge(bridgeMode, bridgePort);
} else if (runMode !== 'node') {
  console.error(`\n  ❌ Unknown mode: ${runMode}`);
  console.error('  Valid modes: node, relay, bridge\n');
  process.exit(1);
} else {
  runNodeMode();
}

// ============================================================
// Node Mode
// ============================================================

function runNodeMode() {

// Handle configuration
if (args.path) {
  const requestedPath = resolve(args.path);
  if (!existsSync(requestedPath)) {
    console.error(`\n  ❌ Error: Path does not exist: ${requestedPath}\n`);
    process.exit(1);
  }
  WORKING_DIR = requestedPath;
}

OIDC_ISSUER = args['issuer'] || process.env.AIRON_OIDC_ISSUER || DEFAULT_OIDC_ISSUER;
OIDC_CLIENT_ID = args['client-id'] || process.env.AIRON_OIDC_CLIENT_ID;
OIDC_CLIENT_SECRET = args['client-secret'] || process.env.AIRON_OIDC_CLIENT_SECRET;
RELAY_URL = args.relay || DEFAULT_RELAY_URL;
UNITY_EDITOR_PORT = parseInt(args['editor-port']) || 3002;
UNITY_GAME_PORT = parseInt(args['game-port']) || 3003;

if (!OIDC_CLIENT_ID) {
  console.error('\n  ❌ Error: OAuth client ID required\n');
  console.error('  Use: airon --client-id <id>\n');
  console.error('  Or set environment variable: AIRON_OIDC_CLIENT_ID\n');
  process.exit(1);
}

// ============================================================
// Status Checks
// ============================================================

function checkClaudeCode() {
  try {
    const result = spawnSync('claude', ['--version'], { timeout: 5000 });
    return result.status === 0 ? 'available' : 'not found';
  } catch {
    return 'not found';
  }
}

function checkProcess(name) {
  try {
    const isWindows = platform() === 'win32';
    if (isWindows) {
      const result = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf-8', timeout: 5000 });
      return result.toLowerCase().includes(name.toLowerCase());
    } else {
      const result = execSync(`pgrep -x "${name}"`, { encoding: 'utf-8', timeout: 5000 });
      return result.trim().length > 0;
    }
  } catch {
    return false;
  }
}

function checkUnityEditor() {
  const isWindows = platform() === 'win32';
  const processName = isWindows ? 'Unity.exe' : 'Unity';
  return checkProcess(processName) ? 'running' : 'not running';
}

function checkUnityGame() {
  const isWindows = platform() === 'win32';
  try {
    if (isWindows) {
      const result = execSync('tasklist /NH', { encoding: 'utf-8', timeout: 5000 });
      if (result.includes('TRTCU.exe') || result.includes('Game.exe')) {
        return 'running';
      }
    }
  } catch {}
  return 'not running';
}

function checkPort(port) {
  try {
    const isWindows = platform() === 'win32';
    if (isWindows) {
      const result = execSync(`netstat -an | findstr :${port}`, { encoding: 'utf-8', timeout: 5000 });
      return result.includes('LISTENING');
    } else {
      const result = execSync(`lsof -i :${port} -sTCP:LISTEN`, { encoding: 'utf-8', timeout: 5000 });
      return result.trim().length > 0;
    }
  } catch {
    return false;
  }
}

async function checkUnityEditorMCP() {
  if (!checkPort(UNITY_EDITOR_PORT)) return 'not running';
  
  try {
    const response = await fetch(`http://localhost:${UNITY_EDITOR_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'status', arguments: {} }
      })
    });
    
    const data = await response.json();
    if (data.result?.content?.[0]?.text) {
      const status = JSON.parse(data.result.content[0].text);
      if (status.serverStartTime) {
        return `launched: ${status.serverStartTime}`;
      }
    }
  } catch {}
  
  return 'running';
}

async function checkUnityGameMCP() {
  if (!checkPort(UNITY_GAME_PORT)) return 'not running';
  
  try {
    const response = await fetch(`http://localhost:${UNITY_GAME_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'status', arguments: {} }
      })
    });
    
    const data = await response.json();
    if (data.result?.content?.[0]?.text) {
      const status = JSON.parse(data.result.content[0].text);
      if (status.serverStartTime) {
        if (status.running === false) {
          return `standby: ${status.serverStartTime}`;
        }
        return `launched: ${status.serverStartTime}`;
      }
    }
  } catch {}
  
  return 'running';
}

async function getStatus() {
  let taskInfo = null;
  if (currentTask && currentTask.status === 'running') {
    taskInfo = {
      description: currentTask.description,
      started: currentTask.started,
      sessionId: currentTask.sessionId,
      interactive: currentTask.interactive
    };
  }
  
  const sessions = Array.from(activeSessions.values()).map(s => ({
    sessionId: s.sessionId,
    status: s.status,
    started: s.started
  }));
  
  return {
    node: 'online',
    claude_code: checkClaudeCode(),
    unity_editor: checkUnityEditor(),
    unity_game: checkUnityGame(),
    unity_editor_mcp: await checkUnityEditorMCP(),
    unity_game_mcp: await checkUnityGameMCP(),
    current_task: taskInfo,
    active_sessions: sessions.length > 0 ? sessions : null
  };
}

// ============================================================
// Claude Code Operations
// ============================================================

function runClaudeCodeInteractive(description) {
  const sessionId = randomUUID();
  currentSessionId = sessionId;
  
  currentTask = {
    description: description,
    started: new Date().toISOString(),
    status: 'running',
    sessionId: sessionId,
    interactive: true
  };
  
  console.log(`\n  🤖 Claude Code session ID: ${sessionId}\n`);

  const cliArgs = ['-p', description];

  activeSessions.set(sessionId, {
    process: null,
    status: 'running',
    output: [],
    sessionId: sessionId,
    started: currentTask.started,
    description: description
  });
  
  const promise = spawnClaudeCode(cliArgs, sessionId, {
    cleanupAfter: true,
    successMessage: 'Session completed'
  });
  
  activeSessions.get(sessionId).process = currentProcess;
  
  return promise;
}

function continueClaudeSession(sessionId, userInput) {
  return new Promise((resolve) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      resolve(`❌ Session ${sessionId} not found.`);
      return;
    }
    
    console.log(`\n  ▶️  Continuing session ${sessionId}`);
    if (userInput) {
      console.log(`  💬 Input: ${userInput}\n`);
    }
    
    taskCompletionResolve = resolve;
    
    const originalDescription = session.description || 'Continue session';
    
    currentTask = {
      description: `Continue: ${originalDescription}`,
      started: new Date().toISOString(),
      status: 'running',
      sessionId: sessionId,
      interactive: true
    };

    const cliArgs = ['-p', originalDescription];
    
    currentProcess = spawnClaudeCode(cliArgs, sessionId, {
      cleanupAfter: false,
      successMessage: 'Session continued'
    });
    
    session.process = currentProcess;
    session.status = 'running';
  });
}

function forceClaudeSession(sessionId) {
  return new Promise((resolve) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      resolve(`❌ Session ${sessionId} not found.`);
      return;
    }
    
    console.log(`\n  ⚡ Forcing execution of session ${sessionId}`);
    console.log(`  ⚠️  Running with --dangerously-skip-permissions\n`);
    
    taskCompletionResolve = resolve;
    
    const originalDescription = session.description || 'Continue session';
    
    currentTask = {
      description: `Force execute: ${originalDescription}`,
      started: new Date().toISOString(),
      status: 'running',
      sessionId: sessionId,
      interactive: false
    };

    const cliArgs = ['-p', originalDescription, '--dangerously-skip-permissions'];
    
    currentProcess = spawnClaudeCode(cliArgs, sessionId, {
      cleanupAfter: false,
      successMessage: 'Forced execution completed'
    });
    
    session.process = currentProcess;
    session.status = 'running';
  });
}

// ============================================================
// Tool Handlers
// ============================================================

async function handleStatus() {
  const status = await getStatus();
  return JSON.stringify(status, null, 2);
}

async function handleClaudeCode(toolArgs) {
  if (!toolArgs?.description) {
    return '❌ Error: No task description provided';
  }
  if (currentTask?.status === 'running') {
    return '❌ Error: A Claude Code task is already running.';
  }
  
  return await runClaudeCodeInteractive(toolArgs.description);
}

async function handleClaudeContinue(toolArgs) {
  if (toolArgs?.sessionId) {
    return await continueClaudeSession(toolArgs.sessionId, toolArgs?.input || '');
  }
  
  if (currentSessionId && activeSessions.has(currentSessionId)) {
    return await continueClaudeSession(currentSessionId, toolArgs?.input || '');
  }
  
  return '❌ No active session to continue.';
}

async function handleClaudeForce(toolArgs) {
  if (toolArgs?.sessionId) {
    return await forceClaudeSession(toolArgs.sessionId);
  }
  
  if (currentSessionId && activeSessions.has(currentSessionId)) {
    return await forceClaudeSession(currentSessionId);
  }
  
  return '❌ No active session to force execute.';
}

async function handleClaudeSessions() {
  if (activeSessions.size === 0) {
    return 'No active Claude Code sessions';
  }
  
  const sessions = Array.from(activeSessions.values()).map(s => ({
    sessionId: s.sessionId,
    status: s.status,
    started: s.started,
    finished: s.finished,
    isCurrent: s.sessionId === currentSessionId
  }));
  
  return JSON.stringify(sessions, null, 2);
}

async function handleClaudeAbort() {
  if (currentTask?.status === 'running' && currentProcess) {
    currentProcess.kill();
    currentTask.status = 'aborted';
    currentTask.finished = new Date().toISOString();
    currentProcess = null;
    return '✓ Task aborted';
  }
  return '❌ No running task to abort';
}

// File operation handlers
async function handleStrReplace(toolArgs) {
  try {
    if (!toolArgs?.path || !toolArgs?.old_str) {
      return '❌ Error: path and old_str are required';
    }
    const absolutePath = validatePath(toolArgs.path);
    const content = readFileSync(absolutePath, 'utf-8');
    const occurrences = content.split(toolArgs.old_str).length - 1;
    if (occurrences === 0) return `❌ Error: old_str not found in ${toolArgs.path}`;
    if (occurrences > 1) return `❌ Error: old_str appears ${occurrences} times (must be unique)`;
    const newContent = content.replace(toolArgs.old_str, toolArgs.new_str || '');
    writeFileSync(absolutePath, newContent, 'utf-8');
    return `✓ File edited: ${toolArgs.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileCreate(toolArgs) {
  try {
    if (!toolArgs?.path || toolArgs?.file_text === undefined) {
      return '❌ Error: path and file_text are required';
    }
    const absolutePath = validatePath(toolArgs.path);
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absolutePath, toolArgs.file_text, 'utf-8');
    return `✓ File created: ${toolArgs.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileDelete(toolArgs) {
  try {
    const { unlinkSync, statSync } = await import('fs');
    if (!toolArgs?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(toolArgs.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${toolArgs.path} does not exist`;
    if (statSync(absolutePath).isDirectory()) return `❌ Error: ${toolArgs.path} is a directory`;
    unlinkSync(absolutePath);
    return `✓ File deleted: ${toolArgs.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileMove(toolArgs) {
  try {
    const { renameSync } = await import('fs');
    if (!toolArgs?.source || !toolArgs?.destination) return '❌ Error: source and destination required';
    const absoluteSource = validatePath(toolArgs.source);
    const absoluteDestination = validatePath(toolArgs.destination);
    if (!existsSync(absoluteSource)) return `❌ Error: ${toolArgs.source} does not exist`;
    if (existsSync(absoluteDestination)) return `❌ Error: ${toolArgs.destination} already exists`;
    const destDir = dirname(absoluteDestination);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    renameSync(absoluteSource, absoluteDestination);
    return `✓ Moved: ${toolArgs.source} → ${toolArgs.destination}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleMkdir(toolArgs) {
  try {
    if (!toolArgs?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(toolArgs.path);
    if (existsSync(absolutePath)) return `❌ Error: ${toolArgs.path} already exists`;
    mkdirSync(absolutePath, { recursive: toolArgs.recursive !== false });
    return `✓ Directory created: ${toolArgs.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleRmdir(toolArgs) {
  try {
    const { rmdirSync, statSync, readdirSync } = await import('fs');
    if (!toolArgs?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(toolArgs.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${toolArgs.path} does not exist`;
    if (!statSync(absolutePath).isDirectory()) return `❌ Error: ${toolArgs.path} is not a directory`;
    const contents = readdirSync(absolutePath);
    if (contents.length > 0) return `❌ Error: ${toolArgs.path} is not empty`;
    rmdirSync(absolutePath);
    return `✓ Directory removed: ${toolArgs.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleView(toolArgs) {
  try {
    const { readdirSync, statSync } = await import('fs');
    if (!toolArgs?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(toolArgs.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${toolArgs.path} does not exist`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      const entries = readdirSync(absolutePath, { withFileTypes: true });
      const formatted = entries.map(e => e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`).join('\n');
      return formatted || '(empty directory)';
    } else {
      const content = readFileSync(absolutePath, 'utf-8');
      const lines = content.split('\n');
      if (toolArgs.lines && Array.isArray(toolArgs.lines) && toolArgs.lines.length === 2) {
        let [start, end] = toolArgs.lines;
        start = Math.max(1, start);
        end = end === -1 ? lines.length : Math.min(end, lines.length);
        return lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
      }
      return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    }
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleGrep(toolArgs) {
  try {
    const { readdirSync, statSync } = await import('fs');
    if (!toolArgs?.path || !toolArgs?.pattern) return '❌ Error: path and pattern required';
    const absolutePath = validatePath(toolArgs.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${toolArgs.path} does not exist`;
    const flags = toolArgs.ignoreCase ? 'gi' : 'g';
    const regex = new RegExp(toolArgs.pattern, flags);
    const results = [];
    const maxResults = toolArgs.maxResults || 100;
    
    function searchFile(filePath, displayPath) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (regex.test(line) && results.length < maxResults) {
            results.push(`${displayPath}:${index + 1}: ${line.trim()}`);
          }
        });
      } catch {}
    }
    
    function searchDirectory(dirPath, displayPrefix = '') {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = join(dirPath, entry.name);
        const displayPath = displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && toolArgs.recursive) {
          searchDirectory(fullPath, displayPath);
        } else if (entry.isFile()) {
          if (toolArgs.filePattern) {
            const fileRegex = new RegExp(toolArgs.filePattern);
            if (!fileRegex.test(entry.name)) continue;
          }
          searchFile(fullPath, displayPath);
        }
      }
    }
    
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      searchDirectory(absolutePath, toolArgs.path);
    } else {
      searchFile(absolutePath, toolArgs.path);
    }
    return results.length > 0 ? results.join('\n') : 'No matches found';
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

// Unity MCP handlers
async function callUnityMCPForTool(server, tool, toolArgs) {
  const port = server === 'editor' ? UNITY_EDITOR_PORT : UNITY_GAME_PORT;
  const url = `http://localhost:${port}/mcp`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: toolArgs }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();
    
    if (data.error) {
      return `❌ Error: ${data.error.message}`;
    }
    
    if (data.result?.content) {
      const content = data.result.content;
      if (Array.isArray(content) && content.length > 0) {
        return content[0].text;
      }
      return 'Done';
    }
    
    return 'Done';
  } catch (err) {
    if (err.name === 'AbortError') {
      return `❌ Timeout: Unity MCP server on port ${port} did not respond`;
    }
    return `❌ Connection failed: ${err.message}`;
  }
}

async function listUnityToolsFormatted() {
  const servers = [
    { name: 'Unity Editor', port: UNITY_EDITOR_PORT },
    { name: 'Unity Game', port: UNITY_GAME_PORT }
  ];
  
  let output = '';
  
  for (const { name, port } of servers) {
    try {
      const response = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/list'
        })
      });
      
      const data = await response.json();
      
      if (data.error) {
        output += `❌ ${name} (port ${port}): ${data.error.message}\n`;
        continue;
      }
      
      const tools = data.result?.tools || [];
      output += `\n📦 ${name} (port ${port}):\n`;
      output += '─'.repeat(50) + '\n';
      
      if (tools.length === 0) {
        output += '  No tools available\n';
      } else {
        for (const tool of tools) {
          output += `  • ${tool.name}\n`;
          output += `    ${tool.description}\n`;
          const props = tool.inputSchema?.properties;
          if (props && Object.keys(props).length > 0) {
            const params = Object.keys(props).map(key => {
              const required = tool.inputSchema?.required?.includes(key);
              return required ? `${key}*` : key;
            }).join(', ');
            output += `    Parameters: ${params}\n`;
          }
        }
      }
      output += '\n';
    } catch (err) {
      output += `❌ ${name} (port ${port}): Connection failed\n`;
    }
  }
  
  return output;
}

async function handleToolCall(name, toolArgs) {
  const handlers = {
    'status': handleStatus,
    'claude-code': handleClaudeCode,
    'claude-continue': handleClaudeContinue,
    'claude-force': handleClaudeForce,
    'claude-sessions': handleClaudeSessions,
    'claude-abort': handleClaudeAbort,
    'str_replace': handleStrReplace,
    'file_create': handleFileCreate,
    'file_delete': handleFileDelete,
    'file_move': handleFileMove,
    'mkdir': handleMkdir,
    'rmdir': handleRmdir,
    'view': handleView,
    'grep': handleGrep
  };
  
  if (handlers[name]) {
    return await handlers[name](toolArgs);
  }

  if (name === 'unity-editor') {
    if (!toolArgs?.tool) return '❌ Error: tool parameter is required';
    return await callUnityMCPForTool('editor', toolArgs.tool, toolArgs.args || {});
  }
  
  if (name === 'unity-game') {
    if (!toolArgs?.tool) return '❌ Error: tool parameter is required';
    return await callUnityMCPForTool('game', toolArgs.tool, toolArgs.args || {});
  }
  
  if (name === 'unity-tools') {
    return await listUnityToolsFormatted();
  }
  
  return `⚠️ Unknown tool: ${name}`;
}

// ============================================================
// SSE Connection to Relay
// ============================================================

async function connectToRelay() {
  console.log(`\n  📡 Connecting to ${RELAY_URL}/node ...`);
  
  const response = await fetch(`${RELAY_URL}/node`, {
    headers: {
      'Authorization': `Bearer ${currentIdToken}`,
      'Accept': 'text/event-stream'
    }
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Connection failed: ${response.status} - ${text}`);
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  console.log('  ✓ Connected to relay\n');
  console.log('  ' + '─'.repeat(50) + '\n');
  
  // Start interactive CLI
  startInteractiveCLI();
  
  while (true) {
    const { done, value } = await reader.read();
    
    if (done) {
      console.log('\n  ✗ Connection closed, reconnecting...');
      break;
    }
    
    buffer += decoder.decode(value, { stream: true });
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    let currentEvent = null;
    let currentData = '';
    
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '' && currentEvent && currentData) {
        await handleSSEEvent(currentEvent, currentData);
        currentEvent = null;
        currentData = '';
      }
    }
  }
}

async function handleSSEEvent(event, data) {
  if (event === 'connected') {
    // Node registered, no action needed
  } else if (event === 'ping') {
    // Keepalive, refresh token if needed
    await refreshTokenIfNeeded();
  } else if (event === 'request') {
    const request = JSON.parse(data);
    await handleToolRequest(request);
  }
}

async function handleToolRequest(request) {
  const { id: requestId, method, params } = request;
  const toolName = params?.name;
  const toolArgs = params?.arguments || {};
  
  console.log(`\n  📞 Call: ${toolName}`);
  if (Object.keys(toolArgs).length > 0) {
    console.log('  Arguments:', JSON.stringify(toolArgs, null, 2).replace(/\n/g, '\n  '));
  }
  
  let result;
  try {
    result = await handleToolCall(toolName, toolArgs);
  } catch (err) {
    result = `⚠️ Error: ${err.message}`;
  }
  
  console.log(`\n  📤 Response:`);
  result.split('\n').forEach(line => console.log(`  ${line}`));
  console.log('');
  
  // Send response back to relay
  try {
    await fetch(`${RELAY_URL}/node?requestId=${requestId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentIdToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ result: { content: [{ type: 'text', text: result }] } })
    });
  } catch (err) {
    console.error(`  ❌ Failed to send response: ${err.message}`);
  }
  
  if (readlineInterface) {
    readlineInterface.prompt();
  }
}

// ============================================================
// Interactive CLI
// ============================================================

function startInteractiveCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'AIRON> '
  });
  
  readlineInterface = rl;

  console.log('  💬 Interactive mode enabled. Type "help" for commands.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    
    if (!input) {
      rl.prompt();
      return;
    }

    const parts = input.split(' ');
    const command = parts[0].toLowerCase();
    const commandArgs = parts.slice(1).join(' ');

    switch (command) {
      case 'help':
        console.log('');
        console.log('  Available commands:');
        console.log('  ─────────────────────────────────────────');
        console.log('  status                     - Check Unity and MCP server status');
        console.log('  claude-sessions            - List active Claude Code sessions');
        console.log('  claude-code <description>  - Run Claude Code task');
        console.log('  claude-continue [input]    - Continue session');
        console.log('  claude-force               - Force execute with full permissions');
        console.log('  claude-abort               - Abort current task');
        console.log('  unity-editor <tool> [args] - Call Unity Editor MCP tool');
        console.log('  unity-game <tool> [args]   - Call Unity Game MCP tool');
        console.log('  unity-tools                - List Unity MCP tools');
        console.log('  help                       - Show this help');
        console.log('  exit                       - Exit AIRON');
        console.log('');
        break;

      case 'status':
        console.log('');
        console.log(JSON.stringify(await getStatus(), null, 2));
        console.log('');
        break;

      case 'claude-sessions':
      case 'sessions':
        console.log('');
        if (activeSessions.size === 0) {
          console.log('  No active sessions');
        } else {
          console.log('  Active Claude Code Sessions:');
          for (const [id, session] of activeSessions) {
            const current = id === currentSessionId ? ' [CURRENT]' : '';
            console.log(`  ${id}${current}`);
            console.log(`    Status: ${session.status}`);
          }
        }
        console.log('');
        break;

      case 'claude-code':
        if (!commandArgs) {
          console.log('\n  ❌ Usage: claude-code <description>');
        } else {
          await runClaudeCodeInteractive(commandArgs);
        }
        break;

      case 'claude-continue':
        if (currentSessionId && activeSessions.has(currentSessionId)) {
          await continueClaudeSession(currentSessionId, commandArgs || '');
        } else {
          console.log('\n  ⚠️  No active session to continue');
        }
        break;

      case 'claude-force':
      case 'force':
        if (currentSessionId && activeSessions.has(currentSessionId)) {
          await forceClaudeSession(currentSessionId);
        } else {
          console.log('\n  ⚠️  No active session to force');
        }
        break;

      case 'claude-abort':
      case 'abort':
        if (!currentProcess) {
          console.log('\n  ⚠️  No task running');
        } else {
          isAborted = true;
          if (platform() === 'win32') {
            spawn('taskkill', ['/pid', currentProcess.pid, '/f', '/t']);
          } else {
            currentProcess.kill('SIGTERM');
          }
        }
        break;
      
      case 'unity-editor':
      case 'unity-game':
        if (!commandArgs) {
          console.log(`\n  ❌ Usage: ${command} <tool> [key=value ...]`);
        } else {
          const server = command === 'unity-editor' ? 'editor' : 'game';
          const argParts = commandArgs.split(' ');
          const tool = argParts[0];
          const toolArgs = {};
          
          for (let i = 1; i < argParts.length; i++) {
            const match = argParts[i].match(/^(\w+)=(.+)$/);
            if (match) {
              toolArgs[match[1]] = match[2].replace(/^["']|["']$/g, '');
            }
          }
          
          console.log(`\n  🎮 Calling ${server} tool: ${tool}`);
          const result = await callUnityMCPForTool(server, tool, toolArgs);
          console.log(`  ${result}`);
        }
        break;
      
      case 'unity-tools':
        console.log('\n  🔧 Fetching Unity MCP tools...\n');
        console.log(await listUnityToolsFormatted());
        break;

      case 'exit':
      case 'quit':
        console.log('\n  👋 Goodbye!\n');
        process.exit(0);
        break;

      default:
        console.log(`\n  ❌ Unknown command: ${command}. Type "help" for commands.`);
        break;
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n  👋 Goodbye!\n');
    process.exit(0);
  });
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║     █████╗ ██╗██████╗  ██████╗ ███╗   ██╗    ║
║    ██╔══██╗██║██╔══██╗██╔═══██╗████╗  ██║    ║
║    ███████║██║██████╔╝██║   ██║██╔██╗ ██║    ║
║    ██╔══██║██║██╔══██╗██║   ██║██║╚██╗██║    ║
║    ██║  ██║██║██║  ██║╚██████╔╝██║ ╚████║    ║
║    ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ║
║                                              ║
║           AI Remote Operations Node          ║
╚══════════════════════════════════════════════╝
  `);
  
  console.log(`  🔗 Relay: ${RELAY_URL}`);
  console.log(`  🔐 OIDC Issuer: ${OIDC_ISSUER}`);
  console.log(`  🎮 Unity Editor Port: ${UNITY_EDITOR_PORT}`);
  console.log(`  🎮 Unity Game Port: ${UNITY_GAME_PORT}`);
  console.log(`  📁 Working directory: ${WORKING_DIR}`);
  
  // Authenticate
  try {
    currentIdToken = await authenticate();
  } catch (err) {
    console.error(`\n  ❌ Authentication failed: ${err.message}\n`);
    process.exit(1);
  }
  
  // Connect with auto-reconnect
  while (true) {
    try {
      await connectToRelay();
    } catch (err) {
      console.error(`  ❌ Connection error: ${err.message}`);
    }
    
    console.log('  ⏳ Reconnecting in 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));
    
    // Refresh token before reconnecting
    try {
      await refreshTokenIfNeeded();
    } catch {}
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

} // End of runNodeMode()