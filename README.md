# AIRON

**Artificial Intelligence Remote Operations Node**

Control Unity Editor remotely through Claude.ai MCP.

## Repository Structure

```
airon/
├── README.md
├── LICENSE.txt
├── .gitignore
├── package.json
├── package-lock.json          # Keep this - locks dependency versions
├── build-sea.js                # Executable builder
├── src/
│   ├── airon.js                # Node client
│   ├── airon-relay.js          # Relay server
│   └── com.airon.mcp/          # Unity package
│       ├── Editor/
│       ├── Runtime/
│       ├── package.json
│       ├── LICENSE.txt
│       └── README.md
└── dist/                       # Releases (gitignored)
```

## Quick Start

### Binary Release (Windows)

Download `airon.exe` from [Releases](https://github.com/KarolFilipKowalczyk/AIRON/releases):

```bash
airon.exe https://relay.example.com/mcp -user yourname -secret yoursecret
```

No Node.js installation required!

### From Source

```bash
npm install
node src/airon.js https://relay.example.com/mcp -user yourname -secret yoursecret
```

## Setup

### 1. Deploy Relay Server (VPS)

Create `docker-compose.yml`:

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
      - AIRON_ADMIN_NODE=your_initial_admin_token_here
    command: node airon-relay.js
```

Deploy:
```bash
# On your VPS (e.g., relay.example.com)
mkdir airon-relay && cd airon-relay
nano docker-compose.yml  # paste config above
nano airon-relay.js      # paste relay server code from src/airon-relay.js

# Install dependencies
docker run --rm -v $(pwd):/app -w /app node:18-alpine npm install ws express

# Start relay
docker-compose up -d

# View logs
docker-compose logs -f
```

**Optional: Add Caddy for HTTPS**

Update `docker-compose.yml`:
```yaml
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
      - caddy_config:/config
    depends_on:
      - airon-relay

  airon-relay:
    # ... (remove ports section, only internal)
    expose:
      - "3001"

volumes:
  caddy_data:
  caddy_config:
```

Create `Caddyfile`:
```
relay.example.com {
    reverse_proxy airon-relay:3001
}
```

### 2. Install Unity Package

Copy `src/com.airon.mcp/` to your Unity project's `Packages/` folder:

```bash
# In your Unity project
cp -r /path/to/airon/src/com.airon.mcp/ Packages/com.airon.mcp/
```

Or use Unity Package Manager → Add package from disk → select `src/com.airon.mcp/package.json`

Open Unity: **Window → AIRON Control** to configure.

### 3. Configure Claude.ai MCP Connector

In Claude.ai settings:

1. Go to **Settings → Connectors**
2. Click **Add Custom Connector**
3. Configure:
   - **Name**: `AIRON` (or your preferred name)
   - **URL**: `https://relay.example.com/mcp/yourname/yoursecret`
   - Replace `relay.example.com` with your relay server domain
   - Replace `yourname` with your username
   - Replace `yoursecret` with your secret token

4. Click **Save**

The connector will authenticate with your relay server and connect to your local AIRON node client.

## Available Tools

**Development:**
- `claude-code(description)` - Start AI task (safe mode)
- `claude-continue(input)` - Execute with permissions
- `claude-sessions()` - List active sessions
- `claude-abort()` - Cancel task

**Files:**
- `file_create`, `str_replace`, `file_delete`, `file_move`
- `view`, `grep`, `mkdir`, `rmdir`

**Unity:**
- `unity-editor(tool)` - Editor control (play, stop, pause, status, viewlog)
- `unity-game(tool)` - Runtime control (status, viewlog, custom tools)
- `unity-tools()` - List all available tools

**System:**
- `status()` - Full system status

## Claude Code Workflow

1. `claude-code`: Analyzes task, explains changes (safe mode)
2. Review the explanation
3. `claude-continue`: Executes with full permissions
4. **Focus Unity window** to trigger compilation

⚠️ Unity only compiles when it's the foreground application!

## Building from Source

```bash
# Install dependencies
npm install

# Build Windows executable (Node.js 20+ required)
npm run build

# Output: dist/airon.exe
```

**Requirements:**
- Node.js 20+ (uses native Single Executable Applications feature)
- No additional tools needed!

## Documentation

See `src/com.airon.mcp/README.md` for:
- Unity MCP server configuration
- Custom tool creation
- Authentication setup
- Troubleshooting

## License

MIT - Karol Kowalczyk
