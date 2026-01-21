# AIRON

**Artificial Intelligence Remote Operations Node**

Control Unity Editor remotely through Claude.ai or locally through Claude Code.

**Version: 0.2.0-alpha**

## Overview

AIRON enables AI-driven Unity development workflows by connecting Claude to Unity through MCP (Model Context Protocol). It supports two modes:

1. **Local Mode** - Claude Code connects directly to Unity MCP servers via `airon-bridge.js`
2. **Remote Mode** - Claude.ai connects to Unity through a relay server and node client

## Repository Structure

```
airon/
├── README.md
├── LICENSE.txt
├── .gitignore
├── package.json
├── package-lock.json
├── airon.js              # Node client (remote mode)
├── airon-relay.js        # Relay server (remote mode)
├── airon-bridge.js       # Stdio bridge (local mode)
└── Packages/
    └── com.airon.mcp/    # Unity package
        ├── Editor/
        ├── Runtime/
        ├── package.json
        ├── LICENSE.txt
        └── README.md
```

## Quick Start

### Option 1: Local Mode (Claude Code → Unity)

Best for local development with Claude Code CLI.

**1. Install Unity Package**

Copy `Packages/com.airon.mcp/` to your Unity project's Packages folder.

**2. Add MCP Servers to Claude Code**

```bash
# Direct HTTP connection (recommended)
claude mcp add unity-editor --transport http http://localhost:3002/mcp
claude mcp add unity-game --transport http http://localhost:3003/mcp
```

**3. Start Using**

Open Unity, then use Claude Code normally. Tools are available as `mcp__unity-editor__play`, etc.

### Option 2: Remote Mode (Claude.ai → Relay → Unity)

Best for mobile access or Claude.ai web interface.

**1. Deploy Relay Server**

See [Relay Server Setup](#relay-server-setup) below.

**2. Install Unity Package**

Copy `Packages/com.airon.mcp/` to your Unity project's Packages folder.

**3. Run Node Client**

```bash
# Binary release (Windows)
airon.exe https://relay.example.com/mcp -u yourname -s yoursecret

# From source
node airon.js https://relay.example.com/mcp -u yourname -s yoursecret
```

**4. Configure Claude.ai MCP Connector**

In Claude.ai: Settings → Connectors → Add Custom Connector
- **URL**: `https://relay.example.com/mcp/yourname/yoursecret`

## Node Client (airon.js)

Interactive client connecting local Unity to the relay server.

### Usage

```bash
airon <relay-url> [options]

Options:
  -u, --user <username>      Username for authentication
  -s, --secret <secret>      Secret token (min 16 chars)
  -e, --editor-port <port>   Unity Editor MCP port (default: 3002)
  -g, --game-port <port>     Unity Game MCP port (default: 3003)
  -p, --path <directory>     Working directory (default: current)
  -h, --help                 Show help message
```

### Examples

```bash
# Connect with credentials
airon https://dev.airon.games/mcp -u myuser -s mysecrettoken123

# With custom ports
airon https://dev.airon.games/mcp -u myuser -s token -e 4002 -g 4003

# With working directory
airon https://dev.airon.games/mcp -u myuser -s token -p ~/MyProject

# Interactive prompt for credentials
airon https://dev.airon.games/mcp
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

## Stdio Bridge (airon-bridge.js) - Optional

Alternative to direct HTTP connection. Wraps Unity's HTTP MCP servers as stdio transport.

**When to use:**
- MCP client only supports stdio transport (not HTTP)
- Need auto-retry when Unity restarts during compilation

### Usage

```bash
# Add via Claude Code (alternative to direct HTTP)
claude mcp add unity-editor node /path/to/airon-bridge.js -- --editor
claude mcp add unity-game node /path/to/airon-bridge.js -- --game
claude mcp add unity node /path/to/airon-bridge.js -- --both
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

## Relay Server (airon-relay.js)

Central server for remote access. Handles authentication and message routing.

### Relay Server Setup

**1. Create docker-compose.yml**

```yaml
version: '3.8'

services:
  airon-relay:
    image: node:18-alpine
    container_name: airon-relay
    restart: unless-stopped
    working_dir: /app
    volumes:
      - ./airon-relay.js:/app/airon-relay.js
      - ./node_modules:/app/node_modules
      - ./data:/app/data
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - AIRON_DATA_DIR=/app/data
      - AIRON_ADMIN_NODE=adminuser:youradminsecrethere
    command: node airon-relay.js
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

See `Packages/com.airon.mcp/README.md` for custom tool creation.

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
node airon.js https://relay.example.com/mcp -u user -s secret
```

## Requirements

- **Node.js**: 18+ (uses native fetch)
- **Unity**: 2021.3+
- **Claude Code**: Latest version (for local mode)

## License

MIT - Karol Kowalczyk
