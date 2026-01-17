#!/usr/bin/env node

// src/airon.js
import WebSocket from "ws";
import { platform, homedir } from "os";
import { execSync, spawnSync, spawn } from "child_process";
import { resolve, relative, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { randomUUID } from "crypto";
import readline from "readline";
var WORKING_DIR = process.cwd();
function validatePath(requestedPath) {
  if (requestedPath.startsWith("\\\\") || requestedPath.match(/^[a-zA-Z]:/)) {
    throw new Error("Access denied: Absolute and UNC paths not allowed");
  }
  const absolutePath = resolve(WORKING_DIR, requestedPath);
  const relativePath = relative(WORKING_DIR, absolutePath);
  if (relativePath.startsWith("..")) {
    throw new Error("Access denied: Path must be within working directory");
  }
  try {
    const realPath = realpathSync(absolutePath);
    const realRelative = relative(WORKING_DIR, realPath);
    if (realRelative.startsWith("..")) {
      throw new Error("Access denied: Symlink points outside working directory");
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  return absolutePath;
}
function spawnClaudeCode(args2, sessionId, sessionData) {
  return new Promise((resolve2) => {
    const isWindows = platform() === "win32";
    let proc;
    if (isWindows) {
      proc = spawn("cmd", ["/c", "claude", ...args2], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else {
      proc = spawn("claude", args2, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      });
    }
    proc.stdin.end();
    proc.stdout.on("data", (data) => {
      const text = data.toString();
      console.log("     " + text.replace(/\n/g, "\n     "));
      outputBuffer += text;
    });
    proc.stderr.on("data", (data) => {
      const text = data.toString();
      outputBuffer += text;
      process.stdout.write("     " + text.replace(/\n/g, "\n     "));
    });
    proc.on("close", (code) => {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.status = isAborted ? "aborted" : code === 0 ? "completed" : "failed";
        session.finished = (/* @__PURE__ */ new Date()).toISOString();
        if (sessionData.cleanupAfter) {
          setTimeout(() => {
            activeSessions.delete(sessionId);
            console.log(`  \u{1F9F9} Cleaned up session ${sessionId}`);
          }, 5 * 60 * 1e3);
        }
      }
      const status = isAborted ? "aborted" : code === 0 ? "completed" : "failed";
      currentTask = {
        ...currentTask,
        status,
        finished: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: code,
        output: outputBuffer
      };
      if (isAborted) {
        console.log(`
  \u{1F6D1} Session aborted
`);
      } else {
        const successMsg = sessionData.successMessage || "Session completed";
        const failMsg = sessionData.failMessage || `Session failed (exit ${code})`;
        console.log(code === 0 ? `
  \u2713 ${successMsg}
` : `
  \u274C ${failMsg}
`);
      }
      isAborted = false;
      currentProcess = null;
      if (taskCompletionResolve) {
        const resolver = taskCompletionResolve;
        taskCompletionResolve = null;
        resolver(outputBuffer);
      } else {
        resolve2(outputBuffer);
      }
    });
    proc.on("error", (err) => {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.status = "error";
        session.finished = (/* @__PURE__ */ new Date()).toISOString();
      }
      console.log(`
  \u274C Process error: ${err.message}
`);
      currentProcess = null;
      if (taskCompletionResolve) {
        taskCompletionResolve(`\u274C Error: ${err.message}`);
        taskCompletionResolve = null;
      } else {
        resolve2(`\u274C Error: ${err.message}`);
      }
    });
    currentProcess = proc;
  });
}
function parseArgs() {
  const args2 = process.argv.slice(2);
  const parsed = { relay: args2[0] };
  for (let i = 1; i < args2.length; i++) {
    if (args2[i].startsWith("-")) {
      const key = args2[i].substring(1);
      const value = args2[i + 1];
      if (value && !value.startsWith("-")) {
        parsed[key] = value;
        i++;
      }
    }
  }
  return parsed;
}
async function prompt(question, hidden = false) {
  return new Promise((resolve2) => {
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      let input = "";
      const onData = (char) => {
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve2(input.trim());
        } else if (char === "") {
          process.exit(0);
        } else if (char === "\x7F" || char === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve2(answer.trim());
      });
    }
  });
}
var args = parseArgs();
if (!args.relay) {
  console.error("\n  \u274C Error: Missing relay URL\n");
  console.error("  Usage: airon <relay-url> [-user <username>] [-secret <secret>]\n");
  console.error("  Example: airon https://relay.example.com/mcp -user myusername -secret my-secret-token-here\n");
  console.error("  Or: airon https://relay.example.com/mcp (will prompt for user/secret)\n");
  process.exit(1);
}
if (!args.relay.match(/^https?:\/\//)) {
  console.error("\n  \u274C Error: Invalid relay URL\n");
  console.error("  URL must start with http:// or https://\n");
  console.error(`  You provided: ${args.relay}
`);
  console.error("  Example: https://relay.example.com/mcp\n");
  process.exit(1);
}
if (!args.relay.match(/^https:\/\//) && !args.relay.includes("localhost") && !args.relay.includes("127.0.0.1")) {
  console.error("\n  \u274C Error: HTTPS required for remote connections\n");
  console.error("  Only localhost can use HTTP\n");
  console.error(`  You provided: ${args.relay}
`);
  console.error("  Use: https:// instead of http://\n");
  process.exit(1);
}
if (!args.user) {
  args.user = await prompt("  \u{1F464} Username: ");
}
if (!args.secret) {
  args.secret = await prompt("  \u{1F511} Secret: ", true);
}
if (!args.user || !args.secret) {
  console.error("\n  \u274C Error: User and secret are required\n");
  process.exit(1);
}
if (args.secret.length < 16) {
  console.error("\n  \u274C Error: Secret must be at least 16 characters\n");
  process.exit(1);
}
var RELAY_URL = args.relay.replace(/^https?:\/\//, "wss://").replace(/\/mcp$/, "");
var token = `${args.user}:${args.secret}`;
var MCP_URL = `${args.relay}/${args.user}/${args.secret}`;
var UNITY_SECRET = args.secret;
console.log(`
  \u{1F517} Connecting to: ${RELAY_URL}`);
console.log(`  \u{1F464} User: ${args.user}
`);
function checkClaudeSettings() {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  console.log("\n  \u{1F50D} Checking Claude Code MCP settings...");
  if (!existsSync(claudeDir)) {
    console.log("  \u{1F4C1} Creating .claude directory...");
    try {
      mkdirSync(claudeDir, { recursive: true });
    } catch (err) {
      console.error(`  \u274C Failed to create .claude directory: ${err.message}`);
      return;
    }
  }
  if (!existsSync(settingsPath)) {
    console.log("  \u{1F4DD} Creating settings.json with MCP permissions...");
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
      writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), "utf-8");
      console.log("  \u2705 Created settings.json with Unity MCP permissions");
    } catch (err) {
      console.error(`  \u274C Failed to create settings.json: ${err.message}`);
    }
  } else {
    try {
      const content = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      if (!settings.permissions || !settings.permissions.allow || settings.permissions.allow.length === 0) {
        console.log("  \u26A0\uFE0F  settings.json exists but has no permissions configured");
        console.log("  \u{1F4DD} Please add permissions manually to ~/.claude/settings.json:");
        console.log("");
        console.log("  {");
        console.log('    "permissions": {');
        console.log('      "allow": [');
        console.log("        // Unity MCP Servers");
        console.log('        "mcp__unity-editor__*",');
        console.log('        "mcp__unity-game__*",');
        console.log("        ");
        console.log("        // Claude Code File Operations (working directory only)");
        console.log('        "read_file__**",');
        console.log('        "write_file__**",');
        console.log('        "edit_file__**",');
        console.log('        "create_file__**",');
        console.log('        "list_directory__**"');
        console.log("      ],");
        console.log('      "deny": [');
        console.log("        // Deny execution for safety");
        console.log('        "execute__*",');
        console.log('        "run_terminal_command__*"');
        console.log("      ]");
        console.log("    }");
        console.log("  }");
        console.log("");
        console.log("  \u274C AIRON node cannot start without permissions configured.\n");
        process.exit(1);
      } else {
        const hasUnityEditor = settings.permissions.allow.some((p) => p.includes("unity-editor"));
        const hasUnityGame = settings.permissions.allow.some((p) => p.includes("unity-game"));
        if (hasUnityEditor && hasUnityGame) {
          console.log("  \u2705 Unity MCP permissions are configured");
        } else {
          console.log("  \u26A0\uFE0F  Unity MCP permissions may be incomplete");
          if (!hasUnityEditor)
            console.log("     Missing: mcp__unity-editor__*");
          if (!hasUnityGame)
            console.log("     Missing: mcp__unity-game__*");
        }
      }
    } catch (err) {
      console.error(`  \u274C Failed to read/parse settings.json: ${err.message}`);
    }
  }
  console.log("");
}
checkClaudeSettings();
function checkClaudeCode() {
  try {
    const result = spawnSync("claude", ["--version"], { timeout: 5e3 });
    return result.status === 0 ? "available" : "not found";
  } catch {
    return "not found";
  }
}
function checkProcess(name) {
  try {
    const isWindows = platform() === "win32";
    if (isWindows) {
      const result = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf-8", timeout: 5e3 });
      return result.toLowerCase().includes(name.toLowerCase());
    } else {
      const result = execSync(`pgrep -x "${name}"`, { encoding: "utf-8", timeout: 5e3 });
      return result.trim().length > 0;
    }
  } catch {
    return false;
  }
}
function checkUnityEditor() {
  const isWindows = platform() === "win32";
  const processName = isWindows ? "Unity.exe" : "Unity";
  return checkProcess(processName) ? "running" : "not running";
}
function checkUnityGame() {
  const isWindows = platform() === "win32";
  try {
    if (isWindows) {
      const result = execSync("tasklist /NH", { encoding: "utf-8", timeout: 5e3 });
      if (result.includes("TRTCU.exe") || result.includes("Game.exe")) {
        return "running";
      }
    }
  } catch {
  }
  return "not running";
}
function checkPort(port) {
  try {
    const isWindows = platform() === "win32";
    if (isWindows) {
      const result = execSync(`netstat -an | findstr :${port}`, { encoding: "utf-8", timeout: 5e3 });
      return result.includes("LISTENING");
    } else {
      const result = execSync(`lsof -i :${port} -sTCP:LISTEN`, { encoding: "utf-8", timeout: 5e3 });
      return result.trim().length > 0;
    }
  } catch {
    return false;
  }
}
async function checkUnityEditorMCP() {
  if (!checkPort(3002)) {
    return "not running";
  }
  try {
    const response = await fetch("http://localhost:3002/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "status",
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
  } catch {
  }
  return "running (port 3002)";
}
async function checkUnityGameMCP() {
  if (!checkPort(3003)) {
    return "not running";
  }
  try {
    const response = await fetch("http://localhost:3003/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "status",
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
  } catch {
  }
  return "running (port 3003)";
}
var currentTask = null;
var isAborted = false;
var activeSessions = /* @__PURE__ */ new Map();
var currentSessionId = null;
async function getStatus() {
  let taskInfo = null;
  if (currentTask && currentTask.status === "running") {
    taskInfo = {
      description: currentTask.description,
      started: currentTask.started,
      sessionId: currentTask.sessionId,
      interactive: currentTask.interactive
    };
  }
  const sessions = Array.from(activeSessions.values()).map((s) => ({
    sessionId: s.sessionId,
    status: s.status,
    started: s.started
  }));
  return {
    node: "online",
    claude_code: checkClaudeCode(),
    unity_editor: checkUnityEditor(),
    unity_game: checkUnityGame(),
    unity_editor_mcp: await checkUnityEditorMCP(),
    unity_game_mcp: await checkUnityGameMCP(),
    current_task: taskInfo,
    active_sessions: sessions.length > 0 ? sessions : null
  };
}
var currentProcess = null;
var outputBuffer = "";
var taskCompletionResolve = null;
var readlineInterface = null;
function runClaudeCodeInteractive(description) {
  const sessionId = randomUUID();
  currentSessionId = sessionId;
  currentTask = {
    description,
    started: (/* @__PURE__ */ new Date()).toISOString(),
    status: "running",
    sessionId,
    interactive: true
  };
  outputBuffer = "";
  const sessionOutput = [];
  console.log(`
  \u{1F916} Claude Code session ID: ${sessionId}
`);
  const args2 = ["-p", description];
  activeSessions.set(sessionId, {
    process: null,
    // Will be set below
    status: "running",
    output: sessionOutput,
    sessionId,
    started: currentTask.started,
    description
    // Store original description for force execution
  });
  const promise = spawnClaudeCode(args2, sessionId, {
    cleanupAfter: true,
    successMessage: "Session completed"
  });
  activeSessions.get(sessionId).process = currentProcess;
  return promise;
}
function continueClaudeSession(sessionId, userInput) {
  return new Promise((resolve2) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      resolve2(`\u274C Session ${sessionId} not found. Available sessions: ${Array.from(activeSessions.keys()).join(", ")}`);
      return;
    }
    console.log(`
  \u25B6\uFE0F  Forcing execution of session ${sessionId}`);
    console.log(`  \u26A0\uFE0F  Running with --dangerously-skip-permissions
`);
    outputBuffer = "";
    taskCompletionResolve = resolve2;
    const originalDescription = session.description || "Continue session";
    currentTask = {
      description: `Force execute: ${originalDescription}`,
      started: (/* @__PURE__ */ new Date()).toISOString(),
      status: "running",
      sessionId,
      interactive: false
    };
    const args2 = ["-p", originalDescription, "--dangerously-skip-permissions"];
    currentProcess = spawnClaudeCode(args2, sessionId, {
      cleanupAfter: false,
      successMessage: "Session step completed"
    });
    session.process = currentProcess;
    session.status = "running";
  });
}
async function handleStatus() {
  const status = await getStatus();
  return JSON.stringify(status, null, 2);
}
async function handleClaudeCode(args2) {
  if (!args2?.description) {
    return "\u274C Error: No task description provided";
  }
  if (currentTask?.status === "running") {
    return '\u274C Error: A Claude Code task is already running. Use "claude-abort" to cancel or "claude-continue" to get result.';
  }
  const result = await runClaudeCodeInteractive(args2.description);
  return result;
}
async function handleClaudeContinue(args2) {
  if (args2?.sessionId) {
    const userInput = args2.input || "continue";
    const result = await continueClaudeSession(args2.sessionId, userInput);
    return result;
  }
  if (currentSessionId && activeSessions.has(currentSessionId)) {
    const userInput = args2.input || "continue";
    const result = await continueClaudeSession(currentSessionId, userInput);
    return result;
  }
  return "\u274C No active session to continue. Use claude-sessions to see available sessions.";
}
async function handleClaudeSessions() {
  if (activeSessions.size === 0) {
    return "No active Claude Code sessions";
  }
  const sessions = Array.from(activeSessions.values()).map((s) => ({
    sessionId: s.sessionId,
    status: s.status,
    started: s.started,
    finished: s.finished,
    isCurrent: s.sessionId === currentSessionId
  }));
  return JSON.stringify(sessions, null, 2);
}
async function handleClaudeAbort() {
  if (currentTask?.status === "running" && currentProcess) {
    currentProcess.kill();
    currentTask.status = "aborted";
    currentTask.finished = (/* @__PURE__ */ new Date()).toISOString();
    currentProcess = null;
    return "\u2713 Task aborted";
  }
  return "\u274C No running task to abort";
}
async function handleStrReplace(args2) {
  try {
    const { readFileSync: readFileSync2, writeFileSync: writeFileSync2 } = await import("fs");
    if (!args2?.path || !args2?.old_str) {
      return "\u274C Error: path and old_str are required";
    }
    const absolutePath = validatePath(args2.path);
    const content = readFileSync2(absolutePath, "utf-8");
    const occurrences = content.split(args2.old_str).length - 1;
    if (occurrences === 0)
      return `\u274C Error: old_str not found in ${args2.path}`;
    if (occurrences > 1)
      return `\u274C Error: old_str appears ${occurrences} times in ${args2.path} (must be unique)`;
    const newContent = content.replace(args2.old_str, args2.new_str || "");
    writeFileSync2(absolutePath, newContent, "utf-8");
    return `\u2713 File edited: ${args2.path}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleFileCreate(args2) {
  try {
    const { writeFileSync: writeFileSync2, mkdirSync: mkdirSync2, existsSync: existsSync2 } = await import("fs");
    const { dirname } = await import("path");
    if (!args2?.path || args2?.file_text === void 0) {
      return "\u274C Error: path and file_text are required";
    }
    const absolutePath = validatePath(args2.path);
    const dir = dirname(absolutePath);
    if (!existsSync2(dir))
      mkdirSync2(dir, { recursive: true });
    writeFileSync2(absolutePath, args2.file_text, "utf-8");
    return `\u2713 File created: ${args2.path}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleFileDelete(args2) {
  try {
    const { unlinkSync, existsSync: existsSync2, statSync } = await import("fs");
    if (!args2?.path)
      return "\u274C Error: path is required";
    const absolutePath = validatePath(args2.path);
    if (!existsSync2(absolutePath))
      return `\u274C Error: ${args2.path} does not exist`;
    if (statSync(absolutePath).isDirectory())
      return `\u274C Error: ${args2.path} is a directory. Only files can be deleted.`;
    unlinkSync(absolutePath);
    return `\u2713 File deleted: ${args2.path}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleFileMove(args2) {
  try {
    const { renameSync, existsSync: existsSync2, mkdirSync: mkdirSync2 } = await import("fs");
    const { dirname } = await import("path");
    if (!args2?.source || !args2?.destination)
      return "\u274C Error: source and destination are required";
    const absoluteSource = validatePath(args2.source);
    const absoluteDestination = validatePath(args2.destination);
    if (!existsSync2(absoluteSource))
      return `\u274C Error: ${args2.source} does not exist`;
    if (existsSync2(absoluteDestination))
      return `\u274C Error: ${args2.destination} already exists`;
    const destDir = dirname(absoluteDestination);
    if (!existsSync2(destDir))
      mkdirSync2(destDir, { recursive: true });
    renameSync(absoluteSource, absoluteDestination);
    return `\u2713 Moved: ${args2.source} \u2192 ${args2.destination}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleMkdir(args2) {
  try {
    const { mkdirSync: mkdirSync2, existsSync: existsSync2 } = await import("fs");
    if (!args2?.path)
      return "\u274C Error: path is required";
    const absolutePath = validatePath(args2.path);
    if (existsSync2(absolutePath))
      return `\u274C Error: ${args2.path} already exists`;
    const recursive = args2.recursive !== false;
    mkdirSync2(absolutePath, { recursive });
    return `\u2713 Directory created: ${args2.path}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleRmdir(args2) {
  try {
    const { rmdirSync, existsSync: existsSync2, statSync, readdirSync } = await import("fs");
    if (!args2?.path)
      return "\u274C Error: path is required";
    const absolutePath = validatePath(args2.path);
    if (!existsSync2(absolutePath))
      return `\u274C Error: ${args2.path} does not exist`;
    if (!statSync(absolutePath).isDirectory())
      return `\u274C Error: ${args2.path} is not a directory`;
    const contents = readdirSync(absolutePath);
    if (contents.length > 0)
      return `\u274C Error: ${args2.path} is not empty (contains ${contents.length} items). Only empty directories can be removed.`;
    rmdirSync(absolutePath);
    return `\u2713 Directory removed: ${args2.path}`;
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleView(args2) {
  try {
    const { readFileSync: readFileSync2, readdirSync, statSync, existsSync: existsSync2 } = await import("fs");
    if (!args2?.path)
      return "\u274C Error: path is required";
    const absolutePath = validatePath(args2.path);
    if (!existsSync2(absolutePath))
      return `\u274C Error: ${args2.path} does not exist`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      const entries = readdirSync(absolutePath, { withFileTypes: true });
      const formatted = entries.map((e) => e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`).join("\n");
      return formatted || "(empty directory)";
    } else {
      const content = readFileSync2(absolutePath, "utf-8");
      const lines = content.split("\n");
      if (args2.lines && Array.isArray(args2.lines) && args2.lines.length === 2) {
        let [start, end] = args2.lines;
        start = Math.max(1, start);
        end = end === -1 ? lines.length : Math.min(end, lines.length);
        return lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n");
      }
      return lines.map((line, i) => `${i + 1}: ${line}`).join("\n");
    }
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleGrep(args2) {
  try {
    let searchFile = function(filePath, displayPath) {
      try {
        const content = readFileSync2(filePath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (regex.test(line) && results.length < maxResults) {
            results.push(`${displayPath}:${index + 1}: ${line.trim()}`);
          }
        });
      } catch (err) {
      }
    }, searchDirectory = function(dirPath, displayPrefix = "") {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults)
          break;
        const fullPath = join2(dirPath, entry.name);
        const displayPath = displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && args2.recursive) {
          searchDirectory(fullPath, displayPath);
        } else if (entry.isFile()) {
          if (args2.filePattern) {
            const fileRegex = new RegExp(args2.filePattern);
            if (!fileRegex.test(entry.name))
              continue;
          }
          searchFile(fullPath, displayPath);
        }
      }
    };
    const { readFileSync: readFileSync2, readdirSync, statSync, existsSync: existsSync2 } = await import("fs");
    const { join: join2 } = await import("path");
    if (!args2?.path || !args2?.pattern)
      return "\u274C Error: path and pattern are required";
    const absolutePath = validatePath(args2.path);
    if (!existsSync2(absolutePath))
      return `\u274C Error: ${args2.path} does not exist`;
    const flags = args2.ignoreCase ? "gi" : "g";
    const regex = new RegExp(args2.pattern, flags);
    const results = [];
    const maxResults = args2.maxResults || 100;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      searchDirectory(absolutePath, args2.path);
    } else {
      searchFile(absolutePath, args2.path);
    }
    return results.length > 0 ? results.join("\n") : "No matches found";
  } catch (err) {
    return `\u274C Error: ${err.message}`;
  }
}
async function handleToolCall(name, args2) {
  const handlers = {
    "status": handleStatus,
    "claude-code": handleClaudeCode,
    "claude-continue": handleClaudeContinue,
    "claude-sessions": handleClaudeSessions,
    "claude-abort": handleClaudeAbort,
    "str_replace": handleStrReplace,
    "file_create": handleFileCreate,
    "file_delete": handleFileDelete,
    "file_move": handleFileMove,
    "mkdir": handleMkdir,
    "rmdir": handleRmdir,
    "view": handleView,
    "grep": handleGrep
  };
  if (handlers[name]) {
    return await handlers[name](args2);
  }
  if (name === "unity-editor") {
    if (!args2?.tool) {
      return "\u274C Error: tool parameter is required";
    }
    const result = await callUnityMCPForTool("editor", args2.tool, args2.args || {});
    if (args2.tool === "play" && result.includes("Entering Play Mode")) {
      await new Promise((resolve2) => setTimeout(resolve2, 2e3));
      return result + " (waiting for Game MCP to start...)";
    }
    return result;
  }
  if (name === "unity-game") {
    if (!args2?.tool) {
      return "\u274C Error: tool parameter is required";
    }
    return await callUnityMCPForTool("game", args2.tool, args2.args || {});
  }
  if (name === "unity-tools") {
    return await listUnityToolsFormatted();
  }
  if (name === "view") {
    try {
      const { readFileSync: readFileSync2, readdirSync, statSync, existsSync: existsSync2 } = await import("fs");
      const { join: join2 } = await import("path");
      if (!args2?.path) {
        return "\u274C Error: path is required";
      }
      const absolutePath = validatePath(args2.path);
      if (!existsSync2(absolutePath)) {
        return `\u274C Error: ${args2.path} does not exist`;
      }
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        const entries = readdirSync(absolutePath, { withFileTypes: true });
        const listing = entries.map((entry) => {
          const type = entry.isDirectory() ? "[DIR]" : "[FILE]";
          return `${type} ${entry.name}`;
        }).join("\n");
        return listing || "(empty directory)";
      }
      const content = readFileSync2(absolutePath, "utf-8");
      if (args2?.lines && Array.isArray(args2.lines) && args2.lines.length === 2) {
        const [start, end] = args2.lines;
        const lines2 = content.split("\n");
        const selectedLines = lines2.slice(start - 1, end === -1 ? void 0 : end);
        return selectedLines.map((line, idx) => `${start + idx}: ${line}`).join("\n");
      }
      const lines = content.split("\n");
      return lines.map((line, idx) => `${idx + 1}: ${line}`).join("\n");
    } catch (err) {
      return `\u274C Error: ${err.message}`;
    }
  }
  if (name === "grep") {
    try {
      let searchFile = function(filePath, relativePath) {
        try {
          const content = readFileSync2(filePath, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, index) => {
            const lineTestStart = Date.now();
            try {
              if (regex.test(line) && Date.now() - lineTestStart < 100) {
                results.push(`${relativePath}:${index + 1}: ${line.trim()}`);
              }
            } catch (err) {
            }
          });
        } catch (err) {
        }
      }, searchDirectory = function(dirPath, basePath) {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join2(dirPath, entry.name);
          const relativePath = join2(basePath, entry.name);
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "Library" || entry.name === "Temp") {
            continue;
          }
          if (entry.isDirectory() && args2.recursive) {
            searchDirectory(fullPath, relativePath);
          } else if (entry.isFile()) {
            if (args2.filePattern) {
              try {
                const extRegex = new RegExp(args2.filePattern);
                const testStart = Date.now();
                extRegex.test("");
                if (Date.now() - testStart > 100) {
                  continue;
                }
                if (!extRegex.test(entry.name)) {
                  continue;
                }
              } catch {
                continue;
              }
            }
            searchFile(fullPath, relativePath);
          }
        }
      };
      const { readFileSync: readFileSync2, readdirSync, statSync, existsSync: existsSync2 } = await import("fs");
      const { join: join2 } = await import("path");
      if (!args2?.pattern || !args2?.path) {
        return "\u274C Error: pattern and path are required";
      }
      const absolutePath = validatePath(args2.path);
      if (!existsSync2(absolutePath)) {
        return `\u274C Error: ${args2.path} does not exist`;
      }
      const stats = statSync(absolutePath);
      const results = [];
      let regex;
      try {
        regex = new RegExp(args2.pattern, args2.ignoreCase ? "gi" : "g");
        const testStart = Date.now();
        regex.test("");
        if (Date.now() - testStart > 100) {
          return "\u274C Error: Invalid regex pattern (too complex)";
        }
      } catch (err) {
        return `\u274C Error: Invalid regex pattern: ${err.message}`;
      }
      if (stats.isDirectory()) {
        if (!args2.recursive) {
          return "\u274C Error: path is a directory. Use recursive=true to search directories";
        }
        searchDirectory(absolutePath, args2.path);
      } else {
        searchFile(absolutePath, args2.path);
      }
      if (results.length === 0) {
        return `No matches found for pattern: ${args2.pattern}`;
      }
      const maxResults = args2.maxResults || 100;
      if (results.length > maxResults) {
        return results.slice(0, maxResults).join("\n") + `
... (${results.length - maxResults} more matches, increase maxResults to see more)`;
      }
      return results.join("\n");
    } catch (err) {
      return `\u274C Error: ${err.message}`;
    }
  }
  return `\u26A0\uFE0F Unknown tool: ${name}`;
}
function connect(token2) {
  const ws = new WebSocket(RELAY_URL, {
    headers: {
      "Authorization": `Bearer ${token2}`
    }
  });
  ws.on("open", () => {
    console.log("  \u2713 Connected to relay. Waiting for tasks...\n");
    console.log("  " + "\u2500".repeat(50) + "\n");
    startInteractiveCLI();
  });
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.error) {
        console.error("\n  \u274C ERROR FROM RELAY:");
        console.error("     " + msg.message);
        return;
      }
      if (msg.method === "tools/call") {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments || {};
        const formattedArgs = {};
        for (const [key, val] of Object.entries(toolArgs)) {
          if (typeof val === "string" && val.includes("\n")) {
            formattedArgs[key] = val;
          } else {
            formattedArgs[key] = val;
          }
        }
        console.log(`
  \u{1F4DE} Call: ${toolName}`);
        if (Object.keys(formattedArgs).length > 0) {
          console.log("  Arguments:");
          for (const [key, val] of Object.entries(formattedArgs)) {
            if (typeof val === "string" && val.includes("\n")) {
              console.log(`    ${key}:`);
              val.split("\n").forEach((line) => console.log(`      ${line}`));
            } else {
              console.log(`    ${key}: ${JSON.stringify(val)}`);
            }
          }
        }
        const result = await handleToolCall(toolName, toolArgs);
        if (toolName === "task" && currentTask && currentTask.status !== "running") {
          console.log(`
  \u{1F4E4} Response:
`);
          const formatted = result.replace(/\\n/g, "\n");
          console.log("  " + formatted.replace(/\n/g, "\n  "));
          console.log("");
        } else {
          console.log(`
  \u{1F4E4} Response:`);
          const formatted = result.replace(/\\n/g, "\n");
          formatted.split("\n").forEach((line) => console.log(`  ${line}`));
          console.log("");
        }
        ws.send(JSON.stringify({
          id: msg.id,
          result: { content: [{ type: "text", text: result }] }
        }));
        if (readlineInterface) {
          readlineInterface.prompt();
        }
      }
    } catch (e) {
      console.error("  \u274C Error:", e.message);
    }
  });
  ws.on("close", (code, reason) => {
    const reasonText = reason?.toString() || "";
    if (code === 1008) {
      console.log("\n  \u274C AUTHENTICATION FAILED: " + reasonText);
      console.log("  Check your token.\n");
      process.exit(1);
    } else {
      console.log("\n  \u26A0\uFE0F Disconnected" + (reasonText ? ": " + reasonText : "") + ". Reconnecting in 5s...");
      setTimeout(() => connect(token2), 5e3);
    }
  });
  ws.on("error", (err) => {
    console.error("  \u274C Connection error:", err.message);
  });
}
async function callUnityMCP(server, tool, args2) {
  const port = server === "editor" ? 3002 : 3003;
  const url = `http://localhost:${port}/mcp`;
  try {
    const headers = { "Content-Type": "application/json" };
    if (UNITY_SECRET) {
      headers["Authorization"] = `Bearer ${UNITY_SECRET}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1e4);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: tool,
          arguments: args2
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.status === 401) {
      console.log(`  \u274C Authentication failed: Unity MCP requires secret token`);
      console.log(`  Set UNITY_MCP_SECRET environment variable`);
      return;
    }
    const data = await response.json();
    if (data.error) {
      console.log(`  \u274C Error: ${data.error.message}`);
      return;
    }
    if (data.result?.content) {
      const content = data.result.content;
      if (Array.isArray(content) && content.length > 0) {
        console.log(`  \u2705 ${content[0].text}`);
      } else {
        console.log("  \u2705 Done");
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.log(`  \u274C Timeout: Unity MCP server on port ${port} did not respond within 10 seconds`);
    } else {
      console.log(`  \u274C Connection failed: ${err.message}`);
      console.log(`  Make sure Unity MCP server is running on port ${port}`);
    }
  }
}
async function listUnityTools() {
  const servers = [
    { name: "Unity Editor", port: 3002 },
    { name: "Unity Game", port: 3003 }
  ];
  for (const { name, port } of servers) {
    try {
      const response = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/list"
        })
      });
      const data = await response.json();
      if (data.error) {
        console.log(`  \u274C ${name} (port ${port}): ${data.error.message}`);
        continue;
      }
      const tools = data.result?.tools || [];
      console.log(`  \u{1F4E6} ${name} (port ${port}):`);
      console.log("  " + "\u2500".repeat(50));
      if (tools.length === 0) {
        console.log("    No tools available");
      } else {
        for (const tool of tools) {
          console.log(`    \u2022 ${tool.name}`);
          console.log(`      ${tool.description}`);
          const props = tool.inputSchema?.properties;
          if (props && Object.keys(props).length > 0) {
            const params = Object.keys(props).map((key) => {
              const required = tool.inputSchema?.required?.includes(key);
              return required ? `${key}*` : key;
            }).join(", ");
            console.log(`      Parameters: ${params}`);
          }
        }
      }
      console.log("");
    } catch (err) {
      console.log(`  \u274C ${name} (port ${port}): Connection failed`);
      console.log(`     ${err.message}
`);
    }
  }
}
async function callUnityMCPForTool(server, tool, args2) {
  const port = server === "editor" ? 3002 : 3003;
  const url = `http://localhost:${port}/mcp`;
  try {
    const headers = { "Content-Type": "application/json" };
    if (UNITY_SECRET) {
      headers["Authorization"] = `Bearer ${UNITY_SECRET}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1e4);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: tool,
          arguments: args2
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.status === 401) {
      return `\u274C Authentication failed: Unity MCP requires secret token. Set UNITY_MCP_SECRET environment variable.`;
    }
    const data = await response.json();
    if (data.error) {
      return `\u274C Error: ${data.error.message}`;
    }
    if (data.result?.content) {
      const content = data.result.content;
      if (Array.isArray(content) && content.length > 0) {
        return content[0].text;
      }
      return "Done";
    }
    return "Done";
  } catch (err) {
    if (err.name === "AbortError") {
      return `\u274C Timeout: Unity MCP server on port ${port} did not respond within 10 seconds`;
    }
    return `\u274C Connection failed: ${err.message}
Make sure Unity MCP server is running on port ${port}`;
  }
}
async function listUnityToolsFormatted() {
  const servers = [
    { name: "Unity Editor", port: 3002 },
    { name: "Unity Game", port: 3003 }
  ];
  let output = "";
  for (const { name, port } of servers) {
    try {
      const response = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/list"
        })
      });
      const data = await response.json();
      if (data.error) {
        output += `\u274C ${name} (port ${port}): ${data.error.message}
`;
        continue;
      }
      const tools = data.result?.tools || [];
      output += `
\u{1F4E6} ${name} (port ${port}):
`;
      output += "\u2500".repeat(50) + "\n";
      if (tools.length === 0) {
        output += "  No tools available\n";
      } else {
        for (const tool of tools) {
          output += `  \u2022 ${tool.name}
`;
          output += `    ${tool.description}
`;
          const props = tool.inputSchema?.properties;
          if (props && Object.keys(props).length > 0) {
            const params = Object.keys(props).map((key) => {
              const required = tool.inputSchema?.required?.includes(key);
              return required ? `${key}*` : key;
            }).join(", ");
            output += `    Parameters: ${params}
`;
          }
        }
      }
      output += "\n";
    } catch (err) {
      output += `\u274C ${name} (port ${port}): Connection failed
`;
      output += `   ${err.message}

`;
    }
  }
  return output;
}
function startInteractiveCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "AIRON> "
  });
  readlineInterface = rl;
  console.log('  \u{1F4AC} Interactive mode enabled. Type "help" for commands.\n');
  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    const parts = input.split(" ");
    const command = parts[0].toLowerCase();
    const args2 = parts.slice(1).join(" ");
    switch (command) {
      case "help":
        console.log("");
        console.log("  Available commands:");
        console.log("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        console.log("  status                     - Check Unity and MCP server status");
        console.log("  claude-sessions            - List active Claude Code sessions");
        console.log("  claude-code <description>  - Run Claude Code task (interactive by default)");
        console.log("  claude-continue [input]    - Continue most recent session with optional input");
        console.log("  claude-abort               - Abort current running Claude Code task");
        console.log("  unity-editor <tool> [args] - Call Unity Editor MCP tool");
        console.log("  unity-game <tool> [args]   - Call Unity Game MCP tool");
        console.log("  unity-tools                - List all available Unity MCP tools");
        console.log("  help                       - Show this help");
        console.log("  exit                       - Exit AIRON");
        console.log("");
        console.log("  Examples:");
        console.log("  claude-code enter Unity play mode");
        console.log("  claude-continue approved");
        console.log("  unity-editor play");
        console.log("  unity-editor viewlog lines=[1,100]");
        console.log('  unity-game execute script="return 2+2"');
        console.log("");
        break;
      case "status":
        console.log("");
        console.log(JSON.stringify(await getStatus(), null, 2));
        console.log("");
        break;
      case "claude-sessions":
      case "sessions":
        console.log("");
        if (activeSessions.size === 0) {
          console.log("  No active sessions");
        } else {
          console.log("  Active Claude Code Sessions:");
          console.log("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
          for (const [id, session] of activeSessions) {
            const current = id === currentSessionId ? " [CURRENT]" : "";
            console.log(`  ${id}${current}`);
            console.log(`    Status: ${session.status}`);
            console.log(`    Started: ${session.started}`);
            if (session.finished) {
              console.log(`    Finished: ${session.finished}`);
            }
            console.log("");
          }
        }
        console.log("");
        break;
      case "claude-code":
        if (!args2) {
          console.log("\n  \u274C Usage: claude-code <description>");
          console.log("  Example: claude-code enter Unity play mode");
        } else {
          console.log(`
  \u{1F916} Running Claude Code (interactive): ${args2}`);
          await runClaudeCodeInteractive(args2);
        }
        break;
      case "claude-continue":
        if (currentSessionId && activeSessions.has(currentSessionId)) {
          const input2 = args2 || "continue";
          console.log(`
  \u25B6\uFE0F  Continuing session with: ${input2}`);
          await continueClaudeSession(currentSessionId, input2);
        } else {
          console.log("\n  \u26A0\uFE0F  No active session to continue");
        }
        break;
      case "claude-abort":
      case "abort":
        if (!currentProcess) {
          console.log("\n  \u26A0\uFE0F  No task is currently running");
        } else {
          console.log("\n  \u{1F6D1} Aborting current task...");
          isAborted = true;
          if (platform() === "win32") {
            spawn("taskkill", ["/pid", currentProcess.pid, "/f", "/t"]);
          } else {
            currentProcess.kill("SIGTERM");
          }
        }
        break;
      case "unity-editor":
      case "unity-game":
        if (!args2) {
          console.log(`
  \u274C Usage: ${command} <tool> [key=value ...]`);
          console.log(`  Example: ${command} play`);
          console.log(`  Example: ${command} execute script="return 2+2"`);
        } else {
          const server = command === "unity-editor" ? "editor" : "game";
          const argParts = args2.split(" ");
          const tool = argParts[0];
          const toolArgs = {};
          for (let i = 1; i < argParts.length; i++) {
            const match = argParts[i].match(/^(\w+)=(.+)$/);
            if (match) {
              const [, key, value] = match;
              toolArgs[key] = value.replace(/^["']|["']$/g, "");
            }
          }
          console.log(`
  \u{1F3AE} Calling ${server} tool: ${tool}`);
          await callUnityMCP(server, tool, toolArgs);
        }
        break;
      case "unity-tools":
        console.log("\n  \u{1F527} Fetching Unity MCP tools...\n");
        await listUnityTools();
        break;
      case "exit":
      case "quit":
        console.log("\n  \u{1F44B} Goodbye!\n");
        process.exit(0);
        break;
      default:
        console.log(`
  \u274C Unknown command: ${command}. Type "help" for available commands.`);
        break;
    }
    rl.prompt();
  });
  rl.on("close", () => {
    console.log("\n  \u{1F44B} Goodbye!\n");
    process.exit(0);
  });
}
function main() {
  console.log(`
  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
  \u2551     \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2557   \u2588\u2588\u2557    \u2551
  \u2551    \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551    \u2551
  \u2551    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551    \u2551
  \u2551    \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551    \u2551
  \u2551    \u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551    \u2551
  \u2551    \u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D    \u2551
  \u2551                                              \u2551
  \u2551              AI Remote Operations Node       \u2551
  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
  `);
  console.log("  \u{1F517} Connecting to relay...");
  connect(token);
}
main();
