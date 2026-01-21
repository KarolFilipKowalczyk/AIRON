#!/usr/bin/env node
/**
 * AIRON Bridge - Stdio wrapper for Unity MCP HTTP servers
 *
 * This script acts as a stdio MCP server that forwards requests to Unity's
 * HTTP-based MCP servers (Editor on port 3002, Game on port 3003).
 *
 * Usage:
 *   node airon-bridge.js [--editor|--game|--both]
 *
 * Add to Claude Code:
 *   claude mcp add unity-editor node airon-bridge.js --editor
 *   claude mcp add unity-game node airon-bridge.js --game
 *   claude mcp add unity node airon-bridge.js --both
 */

import http from 'http';
import readline from 'readline';

// Configuration
const CONFIG = {
    editor: {
        port: 3002,
        name: 'unity-editor',
        description: 'Unity Editor MCP Server - Controls Play/Stop, compilation, and editor tools'
    },
    game: {
        port: 3003,
        name: 'unity-game',
        description: 'Unity Game MCP Server - Controls runtime during Play Mode'
    }
};

// Bridge mode - can be set via parameter or command line
let mode = 'editor'; // default

function parseBridgeArgs() {
    const args = process.argv.slice(2);
    if (args.includes('--game')) {
        return 'game';
    } else if (args.includes('--both')) {
        return 'both';
    } else if (args.includes('--editor')) {
        return 'editor';
    }
    return 'editor';
}

// Server info based on mode
const serverInfo = {
    name: mode === 'both' ? 'airon-bridge' : CONFIG[mode].name,
    version: '1.0.0'
};

// Session tracking
let sessionId = null;

/**
 * Delay helper
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make single HTTP request attempt to Unity MCP server
 */
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

            // Capture session ID from response
            if (res.headers['mcp-session-id']) {
                sessionId = res.headers['mcp-session-id'];
            }

            // Clear session on session-related HTTP errors (Unity may have restarted)
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
            // Clear session on connection error - Unity may have restarted
            sessionId = null;
            reject(new Error(`Connection failed to port ${port}: ${e.message}`));
        });

        req.setTimeout(30000, () => {
            req.destroy();
            // Clear session on timeout - Unity may have restarted
            sessionId = null;
            reject(new Error(`Request timeout to port ${port}`));
        });

        req.write(data);
        req.end();
    });
}

/**
 * Make HTTP request to Unity MCP server with retry
 */
async function makeRequest(port, jsonRpcRequest) {
    try {
        return await makeRequestAttempt(port, jsonRpcRequest);
    } catch (firstError) {
        // Wait 10 seconds and retry once before failing
        await delay(10000);
        try {
            return await makeRequestAttempt(port, jsonRpcRequest);
        } catch (retryError) {
            throw new Error(`${retryError.message}. Is Unity running with MCP enabled?`);
        }
    }
}

/**
 * Get tools from a Unity MCP server
 */
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
        // Server not available, return empty
        return [];
    }
}

/**
 * Call a tool on Unity MCP server
 */
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

/**
 * Handle initialize request
 */
async function handleInitialize(request) {
    // Try to initialize Unity servers
    const ports = mode === 'both'
        ? [CONFIG.editor.port, CONFIG.game.port]
        : [CONFIG[mode].port];

    for (const port of ports) {
        try {
            await makeRequest(port, {
                jsonrpc: '2.0',
                id: 'init',
                method: 'initialize',
                params: request.params || {}
            });
        } catch (e) {
            // Server might not be running, that's OK
        }
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

/**
 * Handle tools/list request
 */
async function handleToolsList(request) {
    let tools = [];

    if (mode === 'editor' || mode === 'both') {
        const editorTools = await getToolsFromServer(
            CONFIG.editor.port,
            mode === 'both' ? 'editor' : ''
        );
        tools = tools.concat(editorTools);
    }

    if (mode === 'game' || mode === 'both') {
        const gameTools = await getToolsFromServer(
            CONFIG.game.port,
            mode === 'both' ? 'game' : ''
        );
        tools = tools.concat(gameTools);
    }

    // Clean up internal properties for response
    const cleanTools = tools.map(({ _originalName, _port, ...tool }) => tool);

    return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
            tools: cleanTools
        }
    };
}

/**
 * Handle tools/call request
 */
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

    let port;
    let toolName = name;

    if (mode === 'both') {
        // Parse prefix (editor:play or game:status)
        if (name.startsWith('editor:')) {
            port = CONFIG.editor.port;
            toolName = name.substring(7);
        } else if (name.startsWith('game:')) {
            port = CONFIG.game.port;
            toolName = name.substring(5);
        } else {
            // Default to editor
            port = CONFIG.editor.port;
        }
    } else {
        port = CONFIG[mode].port;
    }

    try {
        const response = await callTool(port, toolName, args);

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

/**
 * Handle ping request
 */
function handlePing(request) {
    return {
        jsonrpc: '2.0',
        id: request.id,
        result: {}
    };
}

/**
 * Process incoming JSON-RPC request
 */
async function processRequest(request) {
    try {
        switch (request.method) {
            case 'initialize':
                return await handleInitialize(request);

            case 'initialized':
                // Notification, no response needed
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

/**
 * Write response to stdout
 */
function sendResponse(response) {
    if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
    }
}

/**
 * Main entry point - exported for use from airon.js
 * @param {string} bridgeMode - 'editor', 'game', or 'both'
 */
export async function startBridge(bridgeMode) {
    // Set mode and update serverInfo
    mode = bridgeMode || parseBridgeArgs();
    serverInfo.name = mode === 'both' ? 'airon-bridge' : CONFIG[mode].name;

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
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
    startBridge();
}
