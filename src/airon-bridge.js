#!/usr/bin/env node
/**
 * airon-bridge.js - AIRON Bridge (Stdio MCP Wrapper)
 *
 * Copyright (c) 2025 Karol Kowalczyk
 * Licensed under the MIT License
 * See: https://opensource.org/licenses/MIT
 *
 * Stdio wrapper for MCP HTTP servers. Acts as a stdio MCP server
 * that forwards requests to HTTP-based MCP servers (like Unity MCP).
 *
 * Usage:
 *   node airon-bridge.js [port]             # Any MCP server on specified port
 *   node airon-bridge.js --editor [port]    # Unity Editor server (default: 3002)
 *   node airon-bridge.js --game [port]      # Unity Game server (default: 3003)
 *
 * Examples:
 *   node airon-bridge.js 8080               # Generic MCP server on port 8080
 *   node airon-bridge.js --editor           # Unity Editor on port 3002
 *   node airon-bridge.js --editor 4002      # Unity Editor on port 4002
 *   node airon-bridge.js --game 4003        # Unity Game on port 4003
 *
 * Add to Claude Code:
 *   claude mcp add my-server node airon-bridge.js 8080
 *   claude mcp add unity-editor node airon-bridge.js --editor
 *   claude mcp add unity-game node airon-bridge.js --game
 */

import http from 'http';
import readline from 'readline';
import { pathToFileURL } from 'url';

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  editor: {
    port: 3002,
    name: 'unity-editor'
  },
  game: {
    port: 3003,
    name: 'unity-game'
  }
};

// Bridge mode and port
let mode = null;
let customPort = null;

// Server info
const serverInfo = {
  name: 'mcp-bridge',
  version: '1.0.0'
};

// Session tracking
let sessionId = null;

// ============================================================
// Argument Parsing
// ============================================================

function parseBridgeArgs() {
  const args = process.argv.slice(2);
  let selectedMode = null;
  let port = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game') {
      selectedMode = 'game';
      if (args[i + 1] && !args[i + 1].startsWith('--') && !isNaN(parseInt(args[i + 1]))) {
        port = parseInt(args[i + 1]);
        i++;
      }
    } else if (args[i] === '--editor') {
      selectedMode = 'editor';
      if (args[i + 1] && !args[i + 1].startsWith('--') && !isNaN(parseInt(args[i + 1]))) {
        port = parseInt(args[i + 1]);
        i++;
      }
    } else if (!args[i].startsWith('--') && !isNaN(parseInt(args[i]))) {
      port = parseInt(args[i]);
    }
  }

  return { mode: selectedMode, port };
}

// ============================================================
// Helper Functions
// ============================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getActivePort() {
  if (customPort) return customPort;
  if (mode && CONFIG[mode]) return CONFIG[mode].port;
  return customPort || 3002;
}

// ============================================================
// HTTP Request Handling
// ============================================================

function makeRequestAttempt(port, jsonRpcRequest) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonRpcRequest);

    const options = {
      hostname: 'localhost',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      }
    };

    const req = http.request(options, (res) => {
      let body = '';

      if (res.headers['mcp-session-id']) {
        sessionId = res.headers['mcp-session-id'];
      }

      if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404) {
        sessionId = null;
      }

      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', (e) => {
      sessionId = null;
      reject(new Error(`Connection failed to port ${port}: ${e.message}`));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      sessionId = null;
      reject(new Error(`Request timeout to port ${port}`));
    });

    req.write(data);
    req.end();
  });
}

async function makeRequest(port, jsonRpcRequest) {
  try {
    return await makeRequestAttempt(port, jsonRpcRequest);
  } catch (firstError) {
    // Wait 10 seconds and retry once
    await delay(10000);
    try {
      return await makeRequestAttempt(port, jsonRpcRequest);
    } catch (retryError) {
      throw new Error(`${retryError.message}. Is Unity running with MCP enabled?`);
    }
  }
}

// ============================================================
// MCP Protocol Handlers
// ============================================================

async function getToolsFromServer(port, prefix = '') {
  try {
    const response = await makeRequest(port, {
      jsonrpc: '2.0',
      id: 'tools-list',
      method: 'tools/list',
      params: {}
    });

    if (response.result && response.result.tools) {
      return response.result.tools.map(tool => ({
        ...tool,
        name: prefix ? `${prefix}:${tool.name}` : tool.name,
        _originalName: tool.name,
        _port: port
      }));
    }
    return [];
  } catch (e) {
    return [];
  }
}

async function callTool(port, toolName, args) {
  const response = await makeRequest(port, {
    jsonrpc: '2.0',
    id: 'tool-call',
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args || {}
    }
  });

  return response;
}

async function handleInitialize(request) {
  const port = getActivePort();

  try {
    await makeRequest(port, {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: request.params || {}
    });
  } catch (e) {
    // Server might not be running
  }

  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: serverInfo
    }
  };
}

async function handleToolsList(request) {
  const port = getActivePort();
  const tools = await getToolsFromServer(port);

  const cleanTools = tools.map(({ _originalName, _port, ...tool }) => tool);

  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      tools: cleanTools
    }
  };
}

async function handleToolsCall(request) {
  const { name, arguments: args } = request.params || {};

  if (!name) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: 'Missing tool name'
      }
    };
  }

  const port = getActivePort();

  try {
    const response = await callTool(port, name, args);

    if (response.error) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: response.error
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: response.result
    };
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: e.message
      }
    };
  }
}

function handlePing(request) {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {}
  };
}

async function processRequest(request) {
  try {
    switch (request.method) {
      case 'initialize':
        return await handleInitialize(request);

      case 'initialized':
        return null;

      case 'tools/list':
        return await handleToolsList(request);

      case 'tools/call':
        return await handleToolsCall(request);

      case 'ping':
        return handlePing(request);

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`
          }
        };
    }
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: e.message
      }
    };
  }
}

function sendResponse(response) {
  if (response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

// ============================================================
// Main Entry Point
// ============================================================

export async function startBridge(bridgeMode, port) {
  // Set mode and port from args or command line
  if (bridgeMode !== undefined) {
    mode = bridgeMode;
    customPort = port || null;
  } else {
    const parsed = parseBridgeArgs();
    mode = parsed.mode;
    customPort = parsed.port;
  }

  // Set server name based on mode
  if (mode && CONFIG[mode]) {
    serverInfo.name = CONFIG[mode].name;
  } else {
    serverInfo.name = `mcp-bridge-${getActivePort()}`;
  }

  // Set up readline for stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  // Process each line as a JSON-RPC request
  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line);

      // Handle batch requests
      if (Array.isArray(request)) {
        const responses = await Promise.all(
          request.map(req => processRequest(req))
        );
        const validResponses = responses.filter(r => r !== null);
        if (validResponses.length > 0) {
          sendResponse(validResponses);
        }
      } else {
        const response = await processRequest(request);
        sendResponse(response);
      }
    } catch (e) {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${e.message}`
        }
      });
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // Handle process termination
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// Run directly if this is the entry point
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startBridge();
}
