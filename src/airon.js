#!/usr/bin/env node
/**
 * airon.js - AIRON Node Client
 * 
 * Copyright (c) 2025 Karol Kowalczyk
 * Licensed under the MIT License
 * See: https://opensource.org/licenses/MIT
 * 
 * Usage: airon <relay-url> [-u|--user <username>] [-s|--secret <secret>] [-e|--editor-port <port>] [-g|--game-port <port>]
 */

import WebSocket from 'ws';
import { platform, homedir } from 'os';
import { execSync, spawnSync, spawn } from 'child_process';
import { resolve, relative, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { randomUUID } from 'crypto';
import readline from 'readline';

const WORKING_DIR = process.cwd(); // Where airon.js was launched

// Global state variables - must be declared before functions that use them
let currentTask = null;
let isAborted = false;
let activeSessions = new Map(); // sessionId -> { process, status, output, sessionId }
let currentSessionId = null; // Track the most recent session
let currentProcess = null;
let outputBuffer = '';
let taskCompletionResolve = null;
let readlineInterface = null; // Store readline interface globally

function validatePath(requestedPath) {
  // Block UNC paths and absolute paths
  if (requestedPath.startsWith('\\\\') || requestedPath.match(/^[a-zA-Z]:/)) {
    throw new Error('Access denied: Absolute and UNC paths not allowed');
  }
  
  const absolutePath = resolve(WORKING_DIR, requestedPath);
  const relativePath = relative(WORKING_DIR, absolutePath);
  
  // Allow the working directory itself (empty relative path)
  // But block paths that escape to parent directories
  if (relativePath.startsWith('..')) {
    throw new Error('Access denied: Path must be within working directory');
  }
  
  // Resolve symlinks and check again
  try {
    const realPath = realpathSync(absolutePath);
    const realRelative = relative(WORKING_DIR, realPath);
    if (realRelative.startsWith('..')) {
      throw new Error('Access denied: Symlink points outside working directory');
    }
  } catch (err) {
    // If realpath fails (file doesn't exist yet), that's ok
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  
  return absolutePath;
}

// Spawn Claude Code with common event handling
function spawnClaudeCode(args, sessionId, sessionData) {
  return new Promise((resolve) => {
    const isWindows = platform() === 'win32';
    let localOutputBuffer = ''; // Local buffer to avoid bundling scope issues
    
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
    
    // Close stdin immediately - we're not using interactive mode
    proc.stdin.end();
    
    // Setup stdout handler
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      console.log('     ' + text.replace(/\n/g, '\n     '));
      localOutputBuffer += text;
    });
    
    // Setup stderr handler
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      localOutputBuffer += text;
      process.stdout.write('     ' + text.replace(/\n/g, '\n     '));
    });
    
    // Setup close handler
    proc.on('close', (code) => {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.status = isAborted ? 'aborted' : (code === 0 ? 'completed' : 'failed');
        session.finished = new Date().toISOString();
        
        // Clean up completed/failed sessions after 5 minutes (only for initial sessions)
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
        output: localOutputBuffer // Use local buffer
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
        resolver(localOutputBuffer); // Use local buffer
      } else {
        resolve(localOutputBuffer); // Use local buffer
      }
    });
    
    // Setup error handler
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
    
    // Set currentProcess as side effect so it's available globally
    currentProcess = proc;
  });
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { relay: args[0] }; // First unnamed arg is relay
  
  // Map of short args to long args
  const argAliases = {
    'u': 'user',
    's': 'secret',
    'e': 'editor-port',
    'g': 'game-port'
  };
  
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      // Long argument (e.g., --port)
      const key = args[i].substring(2);
      const value = args[i + 1];
      if (value && !value.startsWith('-')) {
        parsed[key] = value;
        i++; // Skip next arg since we consumed it
      }
    } else if (args[i].startsWith('-')) {
      // Short argument (e.g., -p)
      const shortKey = args[i].substring(1);
      const longKey = argAliases[shortKey] || shortKey;
      const value = args[i + 1];
      if (value && !value.startsWith('-')) {
        parsed[longKey] = value;
        i++; // Skip next arg since we consumed it
      }
    }
  }
  
  return parsed;
}

// Prompt for input
async function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    if (hidden) {
      // For hidden input, manually handle stdin
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      
      let input = '';
      const onData = (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          // Enter or Ctrl+D
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input.trim());
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit(0);
        } else if (char === '\u007f' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
        }
      };
      
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

const args = parseArgs();

// Validate relay URL
if (!args.relay) {
  console.error('\n  ❌ Error: Missing relay URL\n');
  console.error('  Usage: airon <relay-url> [-u|--user <username>] [-s|--secret <secret>] [-e|--editor-port <port>] [-g|--game-port <port>]\n');
  console.error('  Example: airon https://relay.example.com/mcp -u myusername -s my-secret-token-here\n');
  console.error('  Or: airon https://relay.example.com/mcp --user myusername --secret my-secret-token-here\n');
  console.error('  Or: airon https://relay.example.com/mcp -u myusername -s token -e 3002 -g 3003\n');
  console.error('  Or: airon https://relay.example.com/mcp (will prompt for user/secret)\n');
  process.exit(1);
}

// Validate URL format
if (!args.relay.match(/^https?:\/\//)) {
  console.error('\n  ❌ Error: Invalid relay URL\n');
  console.error('  URL must start with http:// or https://\n');
  console.error(`  You provided: ${args.relay}\n`);
  console.error('  Example: https://relay.example.com/mcp\n');
  process.exit(1);
}

// Force HTTPS for non-localhost connections
if (!args.relay.match(/^https:\/\//) && !args.relay.includes('localhost') && !args.relay.includes('127.0.0.1')) {
  console.error('\n  ❌ Error: HTTPS required for remote connections\n');
  console.error('  Only localhost can use HTTP\n');
  console.error(`  You provided: ${args.relay}\n`);
  console.error('  Use: https:// instead of http://\n');
  process.exit(1);
}

// Global variables that will be set by main()
let RELAY_URL;
let token;
let MCP_URL;
let UNITY_SECRET;
let UNITY_EDITOR_PORT;
let UNITY_GAME_PORT;

// Main async function to handle prompts and connection
async function main() {
  // Prompt for user and secret if not provided
  if (!args.user) {
    args.user = await prompt('  👤 Username: ');
  }

  if (!args.secret) {
    args.secret = await prompt('  🔑 Secret: ', true); // Hidden input
  }

  if (!args.user || !args.secret) {
    console.error('\n  ❌ Error: User and secret are required\n');
    process.exit(1);
  }

  if (args.secret.length < 16) {
    console.error('\n  ❌ Error: Secret must be at least 16 characters\n');
    process.exit(1);
  }

RELAY_URL = args.relay.replace(/^https?:\/\//, 'wss://').replace(/\/mcp$/, ''); // Convert to WebSocket URL
token = `${args.user}:${args.secret}`;
MCP_URL = `${args.relay}/${args.user}/${args.secret}`;
UNITY_SECRET = args.secret; // Use same secret for Unity MCP
UNITY_EDITOR_PORT = parseInt(args['editor-port']) || 3002; // Default to 3002
UNITY_GAME_PORT = parseInt(args['game-port']) || 3003; // Default to 3003

console.log(`\n  🔗 Connecting to: ${RELAY_URL}`);
console.log(`  👤 User: ${args.user}`);
console.log(`  🎮 Unity Editor Port: ${UNITY_EDITOR_PORT}`);
console.log(`  🎮 Unity Game Port: ${UNITY_GAME_PORT}\n`);

// Check and setup Claude Code settings
function checkClaudeSettings() {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  
  console.log('\n  🔍 Checking Claude Code MCP settings...');
  
  // Check if .claude directory exists
  if (!existsSync(claudeDir)) {
    console.log('  📁 Creating .claude directory...');
    try {
      mkdirSync(claudeDir, { recursive: true });
    } catch (err) {
      console.error(`  ❌ Failed to create .claude directory: ${err.message}`);
      return;
    }
  }
  
  // Check if settings.json exists
  if (!existsSync(settingsPath)) {
    console.log('  📝 Creating settings.json with MCP permissions...');
    const defaultSettings = {
      permissions: {
        allow: [
          // Unity MCP Servers
          "mcp__unity-editor__*",
          "mcp__unity-game__*",
          
          // Claude Code File Operations (restricted to working directory)
          "read_file__**",
          "write_file__**",
          "edit_file__**",
          "create_file__**",
          "list_directory__**"
        ],
        deny: [
          // Deny execution commands for safety
          "execute__*",
          "run_terminal_command__*"
        ]
      }
    };
    
    try {
      writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf-8');
      console.log('  ✅ Created settings.json with Unity MCP permissions');
    } catch (err) {
      console.error(`  ❌ Failed to create settings.json: ${err.message}`);
    }
  } else {
    // File exists, check if it has permissions
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      
      if (!settings.permissions || !settings.permissions.allow || settings.permissions.allow.length === 0) {
        console.log('  ⚠️  settings.json exists but has no permissions configured');
        console.log('  📝 Please add permissions manually to ~/.claude/settings.json:');
        console.log('');
        console.log('  {');
        console.log('    "permissions": {');
        console.log('      "allow": [');
        console.log('        // Unity MCP Servers');
        console.log('        "mcp__unity-editor__*",');
        console.log('        "mcp__unity-game__*",');
        console.log('        ');
        console.log('        // Claude Code File Operations (working directory only)');
        console.log('        "read_file__**",');
        console.log('        "write_file__**",');
        console.log('        "edit_file__**",');
        console.log('        "create_file__**",');
        console.log('        "list_directory__**"');
        console.log('      ],');
        console.log('      "deny": [');
        console.log('        // Deny execution for safety');
        console.log('        "execute__*",');
        console.log('        "run_terminal_command__*"');
        console.log('      ]');
        console.log('    }');
        console.log('  }');
        console.log('');
        console.log('  ❌ AIRON node cannot start without permissions configured.\n');
        process.exit(1);
      } else {
        // Check if Unity MCP permissions are present
        const hasUnityEditor = settings.permissions.allow.some(p => p.includes('unity-editor'));
        const hasUnityGame = settings.permissions.allow.some(p => p.includes('unity-game'));
        
        if (hasUnityEditor && hasUnityGame) {
          console.log('  ✅ Unity MCP permissions are configured');
        } else {
          console.log('  ⚠️  Unity MCP permissions may be incomplete');
          if (!hasUnityEditor) console.log('     Missing: mcp__unity-editor__*');
          if (!hasUnityGame) console.log('     Missing: mcp__unity-game__*');
        }
      }
    } catch (err) {
      console.error(`  ❌ Failed to read/parse settings.json: ${err.message}`);
    }
  }
  
  console.log('');
}

// Run settings check
checkClaudeSettings();

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
  // Check for common Unity player processes
  const isWindows = platform() === 'win32';
  try {
    if (isWindows) {
      const result = execSync('tasklist /NH', { encoding: 'utf-8', timeout: 5000 });
      // Look for common Unity game patterns (customize as needed)
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
  if (!checkPort(UNITY_EDITOR_PORT)) {
    return 'not running';
  }
  
  try {
    const response = await fetch(`http://localhost:${UNITY_EDITOR_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'status',
          arguments: {}
        }
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
  
  return `running (port ${UNITY_EDITOR_PORT})`;
}

async function checkUnityGameMCP() {
  if (!checkPort(UNITY_GAME_PORT)) {
    return 'not running';
  }
  
  try {
    const response = await fetch(`http://localhost:${UNITY_GAME_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'status',
          arguments: {}
        }
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
  
  return `running (port ${UNITY_GAME_PORT})`;
}

async function getStatus() {
  let taskInfo = null;
  // Only show task if it's actually running
  if (currentTask && currentTask.status === 'running') {
    taskInfo = {
      description: currentTask.description,
      started: currentTask.started,
      sessionId: currentTask.sessionId,
      interactive: currentTask.interactive
    };
  }
  
  // List active sessions
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
  
  const sessionOutput = [];
  
  console.log(`\n  🤖 Claude Code session ID: ${sessionId}\n`);

  // Run in safe mode first - no --dangerously-skip-permissions
  // Let Claude Code analyze and explain what it wants to do
  const args = ['-p', description];

  activeSessions.set(sessionId, {
    process: null, // Will be set below
    status: 'running',
    output: sessionOutput,
    sessionId: sessionId,
    started: currentTask.started,
    description: description // Store original description for force execution
  });
  
  const promise = spawnClaudeCode(args, sessionId, {
    cleanupAfter: true,
    successMessage: 'Session completed'
  });
  
  // The promise wraps the process setup, currentProcess is set inside spawnClaudeCode
  // Update session with process after spawn returns
  activeSessions.get(sessionId).process = currentProcess;
  
  return promise;
}

function continueClaudeSession(sessionId, userInput) {
  return new Promise((resolve) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      resolve(`❌ Session ${sessionId} not found. Available sessions: ${Array.from(activeSessions.keys()).join(', ')}`);
      return;
    }
    
    console.log(`\n  ▶️  Continuing session ${sessionId}`);
    if (userInput) {
      console.log(`  💬 Input: ${userInput}\n`);
    }
    
    taskCompletionResolve = resolve;
    
    // Get original description from session
    const originalDescription = session.description || 'Continue session';
    
    currentTask = {
      description: `Continue: ${originalDescription}`,
      started: new Date().toISOString(),
      status: 'running',
      sessionId: sessionId,
      interactive: true
    };

    // Continue in interactive mode (no --dangerously-skip-permissions)
    const args = ['-p', originalDescription];
    
    currentProcess = spawnClaudeCode(args, sessionId, {
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
      resolve(`❌ Session ${sessionId} not found. Available sessions: ${Array.from(activeSessions.keys()).join(', ')}`);
      return;
    }
    
    console.log(`\n  ⚡ Forcing execution of session ${sessionId}`);
    console.log(`  ⚠️  Running with --dangerously-skip-permissions\n`);
    
    taskCompletionResolve = resolve;
    
    // Get original description from session
    const originalDescription = session.description || 'Continue session';
    
    currentTask = {
      description: `Force execute: ${originalDescription}`,
      started: new Date().toISOString(),
      status: 'running',
      sessionId: sessionId,
      interactive: false
    };

    // Run the ORIGINAL task with --dangerously-skip-permissions
    const args = ['-p', originalDescription, '--dangerously-skip-permissions'];
    
    currentProcess = spawnClaudeCode(args, sessionId, {
      cleanupAfter: false,
      successMessage: 'Forced execution completed'
    });
    
    session.process = currentProcess;
    session.status = 'running';
  });
}

// Tool Handlers - Individual functions for each tool
async function handleStatus() {
  const status = await getStatus();
  return JSON.stringify(status, null, 2);
}

async function handleClaudeCode(args) {
  if (!args?.description) {
    return '❌ Error: No task description provided';
  }
  if (currentTask?.status === 'running') {
    return '❌ Error: A Claude Code task is already running. Use "claude-abort" to cancel or "claude-continue" to get result.';
  }
  
  const result = await runClaudeCodeInteractive(args.description);
  return result;
}

async function handleClaudeContinue(args) {
  // If sessionId provided, continue that specific session
  if (args?.sessionId) {
    const userInput = args?.input || '';
    const result = await continueClaudeSession(args.sessionId, userInput);
    return result;
  }
  
  // If currentSessionId exists, continue most recent interactive session
  if (currentSessionId && activeSessions.has(currentSessionId)) {
    const userInput = args?.input || '';
    const result = await continueClaudeSession(currentSessionId, userInput);
    return result;
  }
  
  return '❌ No active session to continue. Use claude-sessions to see available sessions.';
}

async function handleClaudeForce(args) {
  // If sessionId provided, force that specific session
  if (args?.sessionId) {
    const result = await forceClaudeSession(args.sessionId);
    return result;
  }
  
  // If currentSessionId exists, force most recent session
  if (currentSessionId && activeSessions.has(currentSessionId)) {
    const result = await forceClaudeSession(currentSessionId);
    return result;
  }
  
  return '❌ No active session to force execute. Use claude-sessions to see available sessions.';
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


// File Operation Handlers
async function handleStrReplace(args) {
  try {
    const { readFileSync, writeFileSync } = await import('fs');
    if (!args?.path || !args?.old_str) {
      return '❌ Error: path and old_str are required';
    }
    const absolutePath = validatePath(args.path);
    const content = readFileSync(absolutePath, 'utf-8');
    const occurrences = content.split(args.old_str).length - 1;
    if (occurrences === 0) return `❌ Error: old_str not found in ${args.path}`;
    if (occurrences > 1) return `❌ Error: old_str appears ${occurrences} times in ${args.path} (must be unique)`;
    const newContent = content.replace(args.old_str, args.new_str || '');
    writeFileSync(absolutePath, newContent, 'utf-8');
    return `✓ File edited: ${args.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileCreate(args) {
  try {
    const { writeFileSync, mkdirSync, existsSync } = await import('fs');
    const { dirname } = await import('path');
    if (!args?.path || args?.file_text === undefined) {
      return '❌ Error: path and file_text are required';
    }
    const absolutePath = validatePath(args.path);
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absolutePath, args.file_text, 'utf-8');
    return `✓ File created: ${args.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileDelete(args) {
  try {
    const { unlinkSync, existsSync, statSync } = await import('fs');
    if (!args?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(args.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${args.path} does not exist`;
    if (statSync(absolutePath).isDirectory()) return `❌ Error: ${args.path} is a directory. Only files can be deleted.`;
    unlinkSync(absolutePath);
    return `✓ File deleted: ${args.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleFileMove(args) {
  try {
    const { renameSync, existsSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    if (!args?.source || !args?.destination) return '❌ Error: source and destination are required';
    const absoluteSource = validatePath(args.source);
    const absoluteDestination = validatePath(args.destination);
    if (!existsSync(absoluteSource)) return `❌ Error: ${args.source} does not exist`;
    if (existsSync(absoluteDestination)) return `❌ Error: ${args.destination} already exists`;
    const destDir = dirname(absoluteDestination);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    renameSync(absoluteSource, absoluteDestination);
    return `✓ Moved: ${args.source} → ${args.destination}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleMkdir(args) {
  try {
    const { mkdirSync, existsSync } = await import('fs');
    if (!args?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(args.path);
    if (existsSync(absolutePath)) return `❌ Error: ${args.path} already exists`;
    const recursive = args.recursive !== false;
    mkdirSync(absolutePath, { recursive });
    return `✓ Directory created: ${args.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleRmdir(args) {
  try {
    const { rmdirSync, existsSync, statSync, readdirSync } = await import('fs');
    if (!args?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(args.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${args.path} does not exist`;
    if (!statSync(absolutePath).isDirectory()) return `❌ Error: ${args.path} is not a directory`;
    const contents = readdirSync(absolutePath);
    if (contents.length > 0) return `❌ Error: ${args.path} is not empty (contains ${contents.length} items). Only empty directories can be removed.`;
    rmdirSync(absolutePath);
    return `✓ Directory removed: ${args.path}`;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleView(args) {
  try {
    const { readFileSync, readdirSync, statSync, existsSync } = await import('fs');
    if (!args?.path) return '❌ Error: path is required';
    const absolutePath = validatePath(args.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${args.path} does not exist`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      const entries = readdirSync(absolutePath, { withFileTypes: true });
      const formatted = entries.map(e => e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`).join('\n');
      return formatted || '(empty directory)';
    } else {
      const content = readFileSync(absolutePath, 'utf-8');
      const lines = content.split('\n');
      if (args.lines && Array.isArray(args.lines) && args.lines.length === 2) {
        let [start, end] = args.lines;
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

async function handleGrep(args) {
  try {
    const { readFileSync, readdirSync, statSync, existsSync } = await import('fs');
    const { join } = await import('path');
    if (!args?.path || !args?.pattern) return '❌ Error: path and pattern are required';
    const absolutePath = validatePath(args.path);
    if (!existsSync(absolutePath)) return `❌ Error: ${args.path} does not exist`;
    const flags = args.ignoreCase ? 'gi' : 'g';
    const regex = new RegExp(args.pattern, flags);
    const results = [];
    const maxResults = args.maxResults || 100;
    function searchFile(filePath, displayPath) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (regex.test(line) && results.length < maxResults) {
            results.push(`${displayPath}:${index + 1}: ${line.trim()}`);
          }
        });
      } catch (err) {}
    }
    function searchDirectory(dirPath, displayPrefix = '') {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = join(dirPath, entry.name);
        const displayPath = displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && args.recursive) {
          searchDirectory(fullPath, displayPath);
        } else if (entry.isFile()) {
          if (args.filePattern) {
            const fileRegex = new RegExp(args.filePattern);
            if (!fileRegex.test(entry.name)) continue;
          }
          searchFile(fullPath, displayPath);
        }
      }
    }
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      searchDirectory(absolutePath, args.path);
    } else {
      searchFile(absolutePath, args.path);
    }
    return results.length > 0 ? results.join('\n') : 'No matches found';
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

async function handleToolCall(name, args) {
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
    return await handlers[name](args);
  }

  // unity-editor - Call Unity Editor MCP tool
  if (name === 'unity-editor') {
    if (!args?.tool) {
      return '❌ Error: tool parameter is required';
    }
    const result = await callUnityMCPForTool('editor', args.tool, args.args || {});
    
    // If entering Play Mode, wait for it to be ready
    if (args.tool === 'play' && result.includes('Entering Play Mode')) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      return result + ' (waiting for Game MCP to start...)';
    }
    
    return result;
  }
  
  // unity-game - Call Unity Game MCP tool
  if (name === 'unity-game') {
    if (!args?.tool) {
      return '❌ Error: tool parameter is required';
    }
    return await callUnityMCPForTool('game', args.tool, args.args || {});
  }
  
  // unity-tools - List all Unity MCP tools
  if (name === 'unity-tools') {
    return await listUnityToolsFormatted();
  }
  
  // Unknown tool
  return `⚠️ Unknown tool: ${name}`;
}

function connect(token) {
  const ws = new WebSocket(RELAY_URL, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  ws.on('open', () => {
    console.log('  ✓ Connected to relay. Waiting for tasks...\n');
    console.log('  ' + '─'.repeat(50) + '\n');
    
    // Start interactive CLI after successful connection
    startInteractiveCLI();
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      // Handle error messages from relay
      if (msg.error) {
        console.error('\n  ❌ ERROR FROM RELAY:');
        console.error('     ' + msg.message);
        return;
      }
      
      if (msg.method === 'tools/call') {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments || {};
        
        // Format args nicely with proper newlines
        const formattedArgs = {};
        for (const [key, val] of Object.entries(toolArgs)) {
          if (typeof val === 'string' && val.includes('\n')) {
            formattedArgs[key] = val; // Keep original for display
          } else {
            formattedArgs[key] = val;
          }
        }
        
        // Log call with formatted arguments
        console.log(`\n  📞 Call: ${toolName}`);
        if (Object.keys(formattedArgs).length > 0) {
          console.log('  Arguments:');
          for (const [key, val] of Object.entries(formattedArgs)) {
            if (typeof val === 'string' && val.includes('\n')) {
              console.log(`    ${key}:`);
              val.split('\n').forEach(line => console.log(`      ${line}`));
            } else {
              console.log(`    ${key}: ${JSON.stringify(val)}`);
            }
          }
        }
        
        const result = await handleToolCall(toolName, toolArgs);
        
        // Log nicely formatted response
        if (toolName === 'task' && currentTask && currentTask.status !== 'running') {
          // Task completion - show full formatted output
          console.log(`\n  📤 Response:\n`);
          const formatted = result.replace(/\\n/g, '\n');
          console.log('  ' + formatted.replace(/\n/g, '\n  '));
          console.log('');
        } else {
          // Other tools - show formatted response
          console.log(`\n  📤 Response:`);
          const formatted = result.replace(/\\n/g, '\n');
          formatted.split('\n').forEach(line => console.log(`  ${line}`));
          console.log('');
        }
        
        ws.send(JSON.stringify({
          id: msg.id,
          result: { content: [{ type: 'text', text: result }] }
        }));
        
        // Refresh prompt after response
        if (readlineInterface) {
          readlineInterface.prompt();
        }
      }
    } catch (e) {
      console.error('  ❌ Error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason?.toString() || '';
    if (code === 1008) {
      console.log('\n  ❌ AUTHENTICATION FAILED: ' + reasonText);
      console.log('  Check your token.\n');
      process.exit(1);
    } else {
      console.log('\n  ⚠️ Disconnected' + (reasonText ? ': ' + reasonText : '') + '. Reconnecting in 5s...');
      setTimeout(() => connect(token), 5000);
    }
  });

  ws.on('error', (err) => {
    console.error('  ❌ Connection error:', err.message);
  });
}

// Helper to call Unity MCP servers directly
async function callUnityMCP(server, tool, args) {
  const port = server === 'editor' ? UNITY_EDITOR_PORT : UNITY_GAME_PORT;
  const url = `http://localhost:${port}/mcp`;
  
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (UNITY_SECRET) {
      headers['Authorization'] = `Bearer ${UNITY_SECRET}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args
        }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (response.status === 401) {
      console.log(`  ❌ Authentication failed: Unity MCP requires secret token`);
      console.log(`  Set UNITY_MCP_SECRET environment variable`);
      return;
    }
    
    const data = await response.json();
    
    if (data.error) {
      console.log(`  ❌ Error: ${data.error.message}`);
      return;
    }
    
    if (data.result?.content) {
      const content = data.result.content;
      if (Array.isArray(content) && content.length > 0) {
        console.log(`  ✅ ${content[0].text}`);
      } else {
        console.log('  ✅ Done');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`  ❌ Timeout: Unity MCP server on port ${port} did not respond within 10 seconds`);
    } else {
      console.log(`  ❌ Connection failed: ${err.message}`);
      console.log(`  Make sure Unity MCP server is running on port ${port}`);
    }
  }
}

// List all available Unity MCP tools
async function listUnityTools() {
  const servers = [
    { name: 'Unity Editor', port: UNITY_EDITOR_PORT },
    { name: 'Unity Game', port: UNITY_GAME_PORT }
  ];
  
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
        console.log(`  ❌ ${name} (port ${port}): ${data.error.message}`);
        continue;
      }
      
      const tools = data.result?.tools || [];
      console.log(`  📦 ${name} (port ${port}):`);
      console.log('  ' + '─'.repeat(50));
      
      if (tools.length === 0) {
        console.log('    No tools available');
      } else {
        for (const tool of tools) {
          console.log(`    • ${tool.name}`);
          console.log(`      ${tool.description}`);
          
          // Show parameters if any
          const props = tool.inputSchema?.properties;
          if (props && Object.keys(props).length > 0) {
            const params = Object.keys(props).map(key => {
              const required = tool.inputSchema?.required?.includes(key);
              return required ? `${key}*` : key;
            }).join(', ');
            console.log(`      Parameters: ${params}`);
          }
        }
      }
      console.log('');
    } catch (err) {
      console.log(`  ❌ ${name} (port ${port}): Connection failed`);
      console.log(`     ${err.message}\n`);
    }
  }
}

// Helper function to call Unity MCP and return formatted result
async function callUnityMCPForTool(server, tool, args) {
  const port = server === 'editor' ? UNITY_EDITOR_PORT : UNITY_GAME_PORT;
  const url = `http://localhost:${port}/mcp`;
  
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (UNITY_SECRET) {
      headers['Authorization'] = `Bearer ${UNITY_SECRET}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args
        }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (response.status === 401) {
      return `❌ Authentication failed: Unity MCP requires secret token. Set UNITY_MCP_SECRET environment variable.`;
    }
    
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
      return `❌ Timeout: Unity MCP server on port ${port} did not respond within 10 seconds`;
    }
    return `❌ Connection failed: ${err.message}\nMake sure Unity MCP server is running on port ${port}`;
  }
}

// Helper function to list Unity tools and return as formatted string
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
          
          // Show parameters if any
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
      output += `   ${err.message}\n\n`;
    }
  }
  
  return output;
}

// Interactive CLI
function startInteractiveCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'AIRON> '
  });
  
  readlineInterface = rl; // Store globally for WebSocket handler

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
    const args = parts.slice(1).join(' ');

    switch (command) {
      case 'help':
        console.log('');
        console.log('  Available commands:');
        console.log('  ─────────────────────────────────────────');
        console.log('  status                     - Check Unity and MCP server status');
        console.log('  claude-sessions            - List active Claude Code sessions');
        console.log('  claude-code <description>  - Run Claude Code task (interactive mode)');
        console.log('  claude-continue [input]    - Continue session with input/after timeout');
        console.log('  claude-force               - Approve and force execute with full permissions');
        console.log('  claude-abort               - Abort current running Claude Code task');
        console.log('  unity-editor <tool> [args] - Call Unity Editor MCP tool');
        console.log('  unity-game <tool> [args]   - Call Unity Game MCP tool');
        console.log('  unity-tools                - List all available Unity MCP tools');
        console.log('  help                       - Show this help');
        console.log('  exit                       - Exit AIRON');
        console.log('');
        console.log('  Examples:');
        console.log('  claude-code create a player controller');
        console.log('  claude-continue Focus on WASD movement');
        console.log('  claude-force');
        console.log('  unity-editor play');
        console.log('  unity-editor viewlog lines=[1,100]');
        console.log('  unity-game execute script="return 2+2"');
        console.log('');
        break;

      case 'status':
        console.log('');
        console.log(JSON.stringify(await getStatus(), null, 2));
        console.log('');
        break;

      case 'claude-sessions':
      case 'sessions': // Support old name for backward compatibility
        console.log('');
        if (activeSessions.size === 0) {
          console.log('  No active sessions');
        } else {
          console.log('  Active Claude Code Sessions:');
          console.log('  ─────────────────────────────────────────');
          for (const [id, session] of activeSessions) {
            const current = id === currentSessionId ? ' [CURRENT]' : '';
            console.log(`  ${id}${current}`);
            console.log(`    Status: ${session.status}`);
            console.log(`    Started: ${session.started}`);
            if (session.finished) {
              console.log(`    Finished: ${session.finished}`);
            }
            console.log('');
          }
        }
        console.log('');
        break;

      case 'claude-code':
        if (!args) {
          console.log('\n  ❌ Usage: claude-code <description>');
          console.log('  Example: claude-code enter Unity play mode');
        } else {
          console.log(`\n  🤖 Running Claude Code (interactive): ${args}`);
          await runClaudeCodeInteractive(args);
        }
        break;

      case 'claude-continue':
        if (currentSessionId && activeSessions.has(currentSessionId)) {
          const input = args || '';
          if (input) {
            console.log(`\n  ▶️  Continuing session with input: ${input}`);
          } else {
            console.log(`\n  ▶️  Continuing session...`);
          }
          await continueClaudeSession(currentSessionId, input);
        } else {
          console.log('\n  ⚠️  No active session to continue');
        }
        break;

      case 'claude-force':
      case 'force': // Support short name
        if (currentSessionId && activeSessions.has(currentSessionId)) {
          console.log(`\n  ⚡ Forcing execution of session...`);
          await forceClaudeSession(currentSessionId);
        } else {
          console.log('\n  ⚠️  No active session to force execute');
        }
        break;

      case 'claude-abort':
      case 'abort': // Support old name for backward compatibility
        if (!currentProcess) {
          console.log('\n  ⚠️  No task is currently running');
        } else {
          console.log('\n  🛑 Aborting current task...');
          isAborted = true; // Set flag before killing
          if (platform() === 'win32') {
            spawn('taskkill', ['/pid', currentProcess.pid, '/f', '/t']);
          } else {
            currentProcess.kill('SIGTERM');
          }
        }
        break;
      
      case 'unity-editor':
      case 'unity-game':
        if (!args) {
          console.log(`\n  ❌ Usage: ${command} <tool> [key=value ...]`);
          console.log(`  Example: ${command} play`);
          console.log(`  Example: ${command} execute script="return 2+2"`);
        } else {
          const server = command === 'unity-editor' ? 'editor' : 'game';
          const argParts = args.split(' ');
          const tool = argParts[0];
          const toolArgs = {};
          
          // Parse key=value arguments
          for (let i = 1; i < argParts.length; i++) {
            const match = argParts[i].match(/^(\w+)=(.+)$/);
            if (match) {
              const [, key, value] = match;
              // Remove quotes if present
              toolArgs[key] = value.replace(/^["']|["']$/g, '');
            }
          }
          
          console.log(`\n  🎮 Calling ${server} tool: ${tool}`);
          await callUnityMCP(server, tool, toolArgs);
        }
        break;
      
      case 'unity-tools':
        console.log('\n  🔧 Fetching Unity MCP tools...\n');
        await listUnityTools();
        break;

      case 'exit':
      case 'quit':
        console.log('\n  👋 Goodbye!\n');
        process.exit(0);
        break;

      default:
        console.log(`\n  ❌ Unknown command: ${command}. Type "help" for available commands.`);
        break;
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n  👋 Goodbye!\n');
    process.exit(0);
  });
}

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║     █████╗ ██╗██████╗  ██████╗ ███╗   ██╗    ║
  ║    ██╔══██╗██║██╔══██╗██╔═══██╗████╗  ██║    ║
  ║    ███████║██║██████╔╝██║   ██║██╔██╗ ██║    ║
  ║    ██╔══██║██║██╔══██╗██║   ██║██║╚██╗██║    ║
  ║    ██║  ██║██║██║  ██║╚██████╔╝██║ ╚████║    ║
  ║    ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ║
  ║                                              ║
  ║              AI Remote Operations Node       ║
  ╚══════════════════════════════════════════════╝
  `);

  console.log('  🔗 Connecting to relay...');
  connect(token);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
