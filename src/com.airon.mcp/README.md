# AIRON Unity MCP Package

**AI Remote Operations Node for Unity Editor**

Control Unity Editor and Game runtime remotely through Model Context Protocol (MCP) servers, enabling AI-driven development workflows with Claude Code and other AI assistants.

## Overview

The AIRON Unity MCP package provides two MCP servers that expose Unity functionality through a standardized protocol:

- **Editor MCP Server** (port 3002) - Controls Unity Editor (Play/Stop, compilation, logs, custom tools)
- **Game MCP Server** (port 3003) - Controls game runtime during Play Mode (scene management, logs, custom tools)

Both servers use **Streamable HTTP transport** (MCP spec 2025-03-26) with a single `/mcp` endpoint supporting:
- **POST** - JSON-RPC requests
- **GET** - SSE stream for server-to-client notifications
- **DELETE** - Session termination

Both servers support **custom tools** via reflection, allowing you to expose any static C# method as an MCP tool.

**Security Note:** Both servers bind to localhost only and do not accept remote connections. This is by design for security.

## Installation

1. Copy `Packages/com.airon.mcp/` to your Unity project's Packages folder
2. Unity will automatically import the package
3. Open the AIRON Control window: **Window -> AIRON Control**

## Claude Code Integration

### Adding MCP Servers to Claude Code

Use the `claude mcp add` command to connect Claude Code to Unity:

**Editor MCP Server (always available):**
```bash
claude mcp add unity-editor --transport http http://localhost:3002/mcp
```

**Game MCP Server (Play Mode only):**
```bash
claude mcp add unity-game --transport http http://localhost:3003/mcp
```

### Using MCP Tools in Claude Code

Once connected, Claude Code can use the Unity MCP tools:

```
# Check Unity Editor status
mcp__unity-editor__status

# Enter Play Mode
mcp__unity-editor__play

# View Unity console logs
mcp__unity-editor__viewlog

# Call custom tools (example)
mcp__unity-editor__AIRON_MCP_Examples_ListScenes
```

### Managing MCP Connections

```bash
# List all configured MCP servers
claude mcp list

# Remove an MCP server
claude mcp remove unity-editor
```

## Configuration File

AIRON MCP uses a file-based configuration system stored in `ProjectSettings/AironMcpConfig.json`. This allows you to:
- **Version control** your MCP tool configurations
- **Share configurations** across your team
- **Edit directly** or use the GUI in AIRON Control window

### Configuration Format

```json
{
  "editorTools": [
    {
      "toolName": "AIRON.MCP.Examples.ListScenes",
      "description": "List all scenes in the project"
    }
  ],
  "gameTools": [
    {
      "toolName": "AIRON.MCP.RuntimeExamples.GetLoadedScenes",
      "description": "Get all loaded scenes"
    }
  ],
  "editorPort": 3002,
  "gamePort": 3003,
  "editorAutoStart": true,
  "gameAutoStart": true
}
```

### Manual Configuration

You can edit the configuration file directly or use these menu items:
- **Window -> AIRON Control -> Open Window** - GUI configuration editor
- **Window -> AIRON Control -> Open Config File** - Open configuration file location
- **Window -> AIRON Control -> Reset to Defaults** - Delete config and restore defaults

## Quick Start

### 1. Start Unity and Open AIRON Control

1. Open your Unity project
2. Go to **Window -> AIRON Control -> Open Window**
3. The Editor MCP server starts automatically by default

### 2. Connect Claude Code

```bash
# Add Editor MCP server
claude mcp add unity-editor --transport http http://localhost:3002/mcp

# Add Game MCP server (optional, for Play Mode control)
claude mcp add unity-game --transport http http://localhost:3003/mcp
```

### 3. Verify Connection

In Claude Code, test the connection:
```
# Should return Unity Editor status
mcp__unity-editor__status
```

## Editor MCP Server (Port 3002)

### Default Tools

| Tool | Description | Arguments |
|------|-------------|-----------|
| `play` | Enter Play Mode | None |
| `stop` | Exit Play Mode | None |
| `pause` | Toggle pause in Play Mode | None |
| `status` | Get Editor state (playing, paused, compiling) | None |
| `viewlog` | View Unity console logs with filtering | `lines: [start, end]` (optional, default: last 50 lines), `filter: "all"|"error"|"warning"|"info"` (optional) |

### Custom Tools

Add custom Editor tools in the AIRON Control window:

1. Create a static method in any C# class:
```csharp
namespace MyNamespace
{
    public static class EditorTools
    {
        public static string MyCustomTool(string arg1, int arg2)
        {
            // Your logic here
            return "Result";
        }
    }
}
```

2. In AIRON Control window, add tool:
   - **Name**: `MyCustomTool`
   - **Full Path**: `MyNamespace.EditorTools.MyCustomTool`
   - Click **Add Tool**

3. Restart the Editor MCP server

4. Call from Claude: `unity-editor(tool="MyCustomTool", args={"arg1": "value", "arg2": 42})`

## Game MCP Server (Port 3003)

### Default Tools

| Tool | Description | Arguments |
|------|-------------|-----------|
| `status` | Get Game runtime state (includes server start time) | None |
| `viewlog` | View runtime game logs with filtering | `lines: [start, end]` (optional, default: last 50 lines), `filter: "all"|"error"|"warning"|"info"|"log"` (optional) |

### Runtime Example Tools

The package includes example runtime tools:

| Tool | Description | Arguments |
|------|-------------|-----------|
| `AIRON.MCP.RuntimeExamples.GetLoadedScenes` | List currently loaded scenes | None |
| `AIRON.MCP.RuntimeExamples.SwitchScene` | Load a scene by name | `sceneName: "SceneName"` |

### Custom Runtime Tools

Add custom Game runtime tools:

1. Create a static method in any C# class:
```csharp
using UnityEngine;

namespace MyGame
{
    public static class GameTools
    {
        public static string SpawnEnemy(string enemyType, float x, float y, float z)
        {
            Vector3 position = new Vector3(x, y, z);
            // Spawn logic here
            return $"Spawned {enemyType} at {position}";
        }
    }
}
```

2. In AIRON Control window (Game MCP Custom Tools section), add:
   - **Name**: `SpawnEnemy`
   - **Full Path**: `MyGame.GameTools.SpawnEnemy`
   - Click **Add Tool**

3. Enter Play Mode (Game MCP starts automatically)

4. Call from Claude: `unity-game(tool="SpawnEnemy", args={"enemyType": "Goblin", "x": 10, "y": 0, "z": 5})`

## Security

### Localhost Only

Both MCP servers bind exclusively to `localhost` (127.0.0.1) and do not accept connections from remote machines. This ensures:
- Only local applications can connect to the MCP servers
- No network exposure of Unity Editor controls
- Safe for development environments

### Custom Tools Validation

- All custom tools validated against whitelist before execution
- Only explicitly configured methods can be invoked
- Prevents arbitrary code execution via reflection

## Architecture Notes

### Transport Protocol

Both servers use **Streamable HTTP** transport (MCP spec 2025-03-26):
- Single `/mcp` endpoint for all operations
- **POST**: JSON-RPC requests (single or batch)
- **GET**: Opens SSE stream for server-to-client notifications (requires `Accept: text/event-stream` header)
- **DELETE**: Terminates session (requires `Mcp-Session-Id` header)
- Session management via `Mcp-Session-Id` header
- Protocol version: `2024-11-05`

### Threading Model

- **Editor MCP**: Runs on background thread, commands executed on main thread via queued actions
- **Game MCP**: Runs on background thread, commands executed on main thread via queued actions in Update()

### Domain Reload Behavior

Unity's domain reload during compilation:
- Disconnects MCP server connections
- Changes instance IDs
- Claude Code and AIRON node client automatically reconnect

### Play Mode Transitions

- Game MCP server starts automatically when entering Play Mode
- Stops automatically when exiting Play Mode
- Editor MCP continues running throughout

### SSE Notifications

Both servers support Server-Sent Events (SSE) for real-time notifications:
```csharp
// Broadcast custom event from your code
ServerEditor.BroadcastEvent("myEvent", new { data = "value" });

// Broadcast MCP notification
ServerEditor.BroadcastNotification("tools/updated", null);
```

## Troubleshooting

### Server Won't Start

- Check Unity console for error messages
- Verify port 3002/3003 aren't already in use
- Try restarting Unity

### Claude Code Connection Issues

- Verify the MCP server is running (check AIRON Control window)
- Ensure the URL is correct: `http://localhost:3002/mcp` (not just `/`)
- Try removing and re-adding the MCP server:
  ```bash
  claude mcp remove unity-editor
  claude mcp add unity-editor --transport http http://localhost:3002/mcp
  ```

### Custom Tool Not Found

- Verify the full path is correct: `Namespace.ClassName.MethodName`
- Method must be `public static`
- Method must return `string`
- Restart MCP server after adding tools

### Compilation Issues

- Unity only compiles when it's the foreground application
- After file operations, focus Unity window to trigger compilation
- MCP server will reconnect after compilation completes

## API Reference

### Custom Tool Method Signature

```csharp
public static string MethodName(params...)
```

**Requirements:**
- Must be `public static`
- Must return `string`
- Parameters can be: `string`, `int`, `float`, `bool`, `double`, `long`
- Return value is sent back to the MCP client

**Example:**
```csharp
public static string AnalyzeScene(string sceneName, bool includeInactive)
{
    // Your logic
    return JsonUtility.ToJson(result);
}
```

### Logging from Custom Tools

```csharp
public static string MyTool()
{
    Debug.Log("This appears in Unity console");
    Debug.LogWarning("Warning message");
    Debug.LogError("Error message");

    return "Tool result";
}
```

Logs are visible via `viewlog` tool.

## Examples

### Example 1: Query Scene Objects

```csharp
public static class SceneTools
{
    public static string CountObjects(string tag)
    {
        var objects = GameObject.FindGameObjectsWithTag(tag);
        return $"Found {objects.Length} objects with tag '{tag}'";
    }
}
```

Add as custom tool: `MyNamespace.SceneTools.CountObjects`

Call: `unity-game(tool="CountObjects", args={"tag": "Enemy"})`

### Example 2: Modify Game State

```csharp
public static class GameStateTools
{
    public static string SetPlayerHealth(float health)
    {
        var player = GameObject.FindWithTag("Player");
        if (player != null)
        {
            var healthComponent = player.GetComponent<Health>();
            if (healthComponent != null)
            {
                healthComponent.CurrentHealth = health;
                return $"Player health set to {health}";
            }
        }
        return "Player not found";
    }
}
```

### Example 3: Editor Automation

```csharp
#if UNITY_EDITOR
using UnityEditor;

public static class EditorAutomation
{
    public static string CreatePrefab(string name, string path)
    {
        var go = new GameObject(name);
        string prefabPath = $"{path}/{name}.prefab";
        PrefabUtility.SaveAsPrefabAsset(go, prefabPath);
        GameObject.DestroyImmediate(go);
        return $"Created prefab at {prefabPath}";
    }
}
#endif
```

## Integration Options

### Option 1: Claude Code Direct Connection (Recommended)

Connect Claude Code directly to the MCP servers running on your machine:

```bash
claude mcp add unity-editor --transport http http://localhost:3002/mcp
claude mcp add unity-game --transport http http://localhost:3003/mcp
```

This is the simplest setup for local development workflows.

### Option 2: AIRON Remote System (For Remote/Mobile Access)

This Unity package is part of the larger AIRON system for remote access:

- **airon-relay.js** - MCP relay server hosted at dev.airon.games
- **airon.js** - Node client connecting local Unity to Claude.ai
- **com.airon.mcp** - This Unity package (MCP servers)

See the main AIRON documentation for complete remote system setup.

## Version

- **Version**: 0.2.1-alpha
- **Unity Version**: 2021.3+
- **MCP Protocol**: 2024-11-05
- **Transport**: Streamable HTTP (MCP spec 2025-03-26)
- **License**: MIT

## Support

For issues, questions, or contributions, see the main AIRON repository.

---

**Built for AI-driven game development. Control Unity remotely with Claude Code.**
