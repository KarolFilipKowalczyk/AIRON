# AIRON

**Artificial Intelligence Remote Operations Node**

Control Unity Editor remotely through Claude.ai or locally through Claude Code.

**Version: 0.2.1-alpha**

## Overview

AIRON enables AI-driven Unity development workflows by connecting Claude to Unity through MCP (Model Context Protocol). All functionality is bundled in a single executable (`airon.exe` or `node airon.js`) with three operating modes:

1. **Node Mode** (default) - Connect to a relay server for remote access via Claude.ai
2. **Relay Mode** (`-m relay`) - Run as the central relay server
3. **Bridge Mode** (`-m bridge`) - Stdio MCP bridge for local Claude Code integration

## Repository Structure

```
airon/
├── README.md
├── LICENSE.txt
├── .gitignore
├── package.json
├── package-lock.json
├── build-sea.js          # Build script for standalone executable
├── src/
│   ├── airon.js          # Main entry point (all modes)
│   ├── airon-relay.js    # Relay server module
│   ├── airon-bridge.js   # Bridge module
│   └── com.airon.mcp/    # Unity package
│       ├── Editor/
│       ├── Runtime/
│       ├── package.json
│       ├── LICENSE.txt
│       └── README.md
└── dist/
    └── airon.exe         # Standalone Windows executable
```

## Quick Start

### Option 1: Local Mode (Claude Code → Unity)

Best for local development with Claude Code CLI.

**1. Install Unity Package**

Copy `src/com.airon.mcp/` to your Unity project's Packages folder.

**2. Add MCP Servers to Claude Code**

```bash
# Direct HTTP connection (recommended)
claude mcp add unity-editor --transport http http://localhost:3002/mcp
claude mcp add unity-game --transport http http://localhost:3003/mcp

# Or use AIRON bridge (alternative - supports auto-retry)
claude mcp add unity-editor airon.exe -- -m bridge --editor
claude mcp add unity-game airon.exe -- -m bridge --game
```

**3. Start Using**

Open Unity, then use Claude Code normally. Tools are available as `mcp__unity-editor__play`, etc.

### Option 2: Remote Mode (Claude.ai → Relay → Unity)

Best for mobile access or Claude.ai web interface.

**1. Deploy Relay Server**

```bash
# Using the executable
airon.exe -m relay

# Or from source
node src/airon.js -m relay
```

See [Relay Server Setup](#relay-server-setup) for production deployment.

**2. Install Unity Package**

Copy `src/com.airon.mcp/` to your Unity project's Packages folder.

**3. Run Node Client**

```bash
# Using the executable
airon.exe https://relay.example.com/mcp -u yourname -s yoursecret

# Or from source
node src/airon.js https://relay.example.com/mcp -u yourname -s yoursecret
```

**4. Configure Claude.ai MCP Connector**

In Claude.ai: Settings → Connectors → Add Custom Connector
- **URL**: `https://relay.example.com/mcp/yourname/yoursecret`

## Command Line Usage

All functionality is accessed through a single executable with different modes.

### Usage

```bash
airon [options] [relay-url]

Modes:
  -m, --mode <mode>          Operating mode: node (default), relay, or bridge

Node Mode (default) - Connect to relay server:
  airon <relay-url> [options]
  -u, --user <username>      Username for authentication
  -s, --secret <secret>      Secret token (min 16 chars)
  -e, --editor-port <port>   Unity Editor MCP port (default: 3002)
  -g, --game-port <port>     Unity Game MCP port (default: 3003)
  -p, --path <directory>     Working directory (default: current)

Relay Mode - Run as relay server:
  airon -m relay
  Environment variables:
    PORT                     Server port (default: 3001)
    AIRON_DATA_DIR           Directory for airon-nodes.json (default: .)
    AIRON_ADMIN_NODE         Initial admin token (username:secret)

Bridge Mode - Stdio MCP bridge for Unity:
  airon -m bridge [--editor|--game|--both]
  --editor                   Bridge to Unity Editor MCP (port 3002, default)
  --game                     Bridge to Unity Game MCP (port 3003)
  --both                     Bridge to both Editor and Game MCP

General:
  -h, --help                 Show help message
```

### Examples

```bash
# Node mode - connect to relay
airon https://relay.example.com/mcp -u myuser -s my-secret-token

# Relay mode - start server
airon -m relay

# Bridge mode - stdio MCP for Claude Code
airon -m bridge --editor
airon -m bridge --both
```

### Interactive Commands

Once connected, use these commands in the terminal:

```
status                     - Check Unity and MCP server status
claude-code <description>  - Run Claude Code task (interactive mode)
claude-continue [input]    - Continue session with input
claude-force               - Execute with full permissions
claude-sessions            - List active Claude Code sessions
claude-abort               - Abort current running task
unity-editor <tool> [args] - Call Unity Editor MCP tool
unity-game <tool> [args]   - Call Unity Game MCP tool
unity-tools                - List all available Unity MCP tools
admin <subcommand>         - Admin commands (if admin node)
help                       - Show help
exit                       - Exit AIRON
```

## Bridge Mode

Alternative to direct HTTP connection. Wraps Unity's HTTP MCP servers as stdio transport.

**When to use:**
- MCP client only supports stdio transport (not HTTP)
- Need auto-retry when Unity restarts during compilation

### Usage

```bash
# Add via Claude Code (alternative to direct HTTP)
claude mcp add unity-editor airon.exe -- -m bridge --editor
claude mcp add unity-game airon.exe -- -m bridge --game
claude mcp add unity airon.exe -- -m bridge --both
```

### Modes

| Mode | Description | Tool Names |
|------|-------------|------------|
| `--editor` | Editor MCP only (default) | `play`, `status`, etc. |
| `--game` | Game MCP only | `status`, `viewlog`, etc. |
| `--both` | Both servers | `editor:play`, `game:status` |

### Features

- **Auto-retry**: Waits 10 seconds and retries if Unity not ready
- **Session tracking**: Maintains MCP session across requests
- **Batch support**: Handles JSON-RPC batch requests

**Note:** For most use cases, direct HTTP connection is simpler and recommended.

## Relay Mode

Central server for remote access. Handles authentication and message routing.

### Quick Start

```bash
# Start relay server locally
airon -m relay

# Or with environment variables
PORT=3001 AIRON_ADMIN_NODE=admin:mysecrettoken airon -m relay
```

### Production Deployment with Docker

**1. Create docker-compose.yml**

```yaml
version: '3.8'

services:
  airon-relay:
    image: node:20-alpine
    container_name: airon-relay
    restart: unless-stopped
    working_dir: /app
    volumes:
      - ./src/airon.js:/app/airon.js
      - ./src/airon-relay.js:/app/airon-relay.js
      - ./node_modules:/app/node_modules
      - ./data:/app/data
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - AIRON_DATA_DIR=/app/data
      - AIRON_ADMIN_NODE=adminuser:youradminsecrethere
    command: node airon.js -m relay
```

**2. Deploy**

```bash
mkdir airon-relay && cd airon-relay
# Copy docker-compose.yml and airon-relay.js

# Install dependencies
docker run --rm -v $(pwd):/app -w /app node:18-alpine npm install ws express

# Start relay
docker-compose up -d
```

**3. Add HTTPS with Caddy (recommended)**

```yaml
# Add to docker-compose.yml
services:
  caddy:
    image: caddy:alpine
    container_name: airon-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - airon-relay

  airon-relay:
    expose:
      - "3001"
    # Remove ports section

volumes:
  caddy_data:
```

Caddyfile:
```
relay.example.com {
    reverse_proxy airon-relay:3001
}
```

### Security Features

- **Token validation**: Minimum 16 character secrets
- **Timing-safe comparison**: Prevents timing attacks
- **Rate limiting**: 100 requests per 15 minutes per IP
- **Connection limits**: Max 10 connections per IP, 1000 total SSE clients
- **Idle timeout**: SSE sessions timeout after 5 minutes
- **Authorized nodes file**: `airon-nodes.json` whitelist

### Admin Commands

Admin nodes can manage users via the interactive CLI:

```bash
admin user-list                         # List all nodes
admin user-add <username> <secret>      # Add node
admin user-add <username> <secret> --admin  # Add admin node
admin user-delete <username> <secret>   # Remove node
```

MCP connector URL format: `https://relay.example.com/mcp/<username>/<secret>`

## Unity Package (com.airon.mcp)

MCP servers for Unity Editor and Game runtime.

### Features

- **Streamable HTTP transport** (MCP spec 2025-03-26)
- **File-based configuration** (`ProjectSettings/AironMcpConfig.json`)
- **SSE notifications** for real-time events
- **Custom tools** via reflection
- **Localhost only** for security

### Default Tools

**Editor MCP (port 3002)**
| Tool | Description |
|------|-------------|
| `play` | Enter Play Mode |
| `stop` | Exit Play Mode |
| `pause` | Toggle pause |
| `status` | Get editor state |
| `viewlog` | View Unity console logs |

**Game MCP (port 3003)**
| Tool | Description |
|------|-------------|
| `status` | Get runtime state |
| `viewlog` | View game logs |

See `src/com.airon.mcp/README.md` for custom tool creation.

## Available Tools (Remote Mode)

**Development**
- `claude-code(description)` - Start AI task (interactive mode)
- `claude-continue(input, sessionId)` - Continue session
- `claude-force(sessionId)` - Execute with full permissions
- `claude-sessions()` - List active sessions
- `claude-abort()` - Cancel task

**Files**
- `view(path, lines)` - View file or directory
- `grep(pattern, path, recursive, ignoreCase)` - Search files
- `str_replace(path, old_str, new_str)` - Edit file
- `file_create(path, file_text)` - Create file
- `file_delete(path)` - Delete file
- `file_move(source, destination)` - Move file
- `mkdir(path)` - Create directory
- `rmdir(path)` - Remove empty directory

**Unity**
- `unity-editor(tool, args)` - Call Editor MCP tool
- `unity-game(tool, args)` - Call Game MCP tool
- `unity-tools()` - List all available tools

**System**
- `status()` - Full system status

## Claude Code Workflow

### Interactive Mode (Remote)

1. `claude-code`: Analyzes task, explains changes needed
2. Review the explanation
3. `claude-continue`: Provide guidance or approval
4. `claude-force`: Execute with `--dangerously-skip-permissions`

### Local Mode

Use standard Claude Code with Unity MCP tools:
```
mcp__unity-editor__play
mcp__unity-editor__status
mcp__unity-editor__viewlog
```

**Important**: Unity only compiles when it's the foreground application. After file operations, focus Unity to trigger compilation.

## Building from Source

```bash
# Install dependencies
npm install

# Run directly
node src/airon.js https://relay.example.com/mcp -u user -s secret
node src/airon.js -m relay
node src/airon.js -m bridge --editor

# Build standalone executable (Windows)
npm run build
# Output: dist/airon.exe
```

## Requirements

- **Node.js**: 20+ (required for SEA build)
- **Unity**: 2021.3+
- **Claude Code**: Latest version (for local mode)
- **Windows**: Standalone executable only (or run via Node.js on other platforms)

## License

MIT - Karol Kowalczyk
