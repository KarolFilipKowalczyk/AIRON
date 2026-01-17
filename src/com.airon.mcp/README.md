# AIRON Unity MCP Package

**AI Remote Operations Node for Unity Editor**

Control Unity Editor and Game runtime remotely through Model Context Protocol (MCP) servers, enabling AI-driven development workflows with Claude.ai and other AI assistants.

## Overview

The AIRON Unity MCP package provides two MCP servers that expose Unity functionality through a standardized protocol:

- **Editor MCP Server** (port 3002) - Controls Unity Editor (Play/Stop, compilation, logs, custom tools)
- **Game MCP Server** (port 3003) - Controls game runtime during Play Mode (scene management, logs, custom tools)

Both servers support **custom tools** via reflection, allowing you to expose any static C# method as an MCP tool.

## Installation

1. Copy `Packages/com.airon.mcp/` to your Unity project's Packages folder
2. Unity will automatically import the package
3. Open the AIRON Control window: **Window → AIRON Control**

## Quick Start

### 1. Configure Authentication (Optional)

The MCP servers can run with or without authentication:

- **Without auth**: Leave secret field empty (suitable for localhost-only access)
- **With auth**: Set a 16+ character secret in the AIRON Control window

### 2. Start MCP Servers

In the AIRON Control window:
- Enable **Auto-start on Play** (recommended)
- Or click **Start Server** manually

The Editor MCP server runs continuously. The Game MCP server only runs during Play Mode.

### 3. Connect from Claude.ai

Use the AIRON node client (`airon.js`) to connect your local Unity to Claude.ai's MCP connector system. See the main AIRON documentation for setup instructions.

## Editor MCP Server (Port 3002)

### Default Tools

| Tool | Description | Arguments |
|------|-------------|-----------|
| `play` | Enter Play Mode | None |
| `stop` | Exit Play Mode | None |
| `pause` | Pause/unpause Play Mode | None |
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

### Authentication

- Optional secret token authentication (16+ characters recommended)
- Secrets cached in EditorPrefs (Editor: `AIRON_EditorMCP_Secret`, Game: `AIRON_GameMCP_Secret`)
- If no secret configured, servers accept all connections (localhost-only recommended)

### Custom Tools Validation

- All custom tools validated against whitelist before execution
- Only explicitly configured methods can be invoked
- Prevents arbitrary code execution via reflection

### Network Exposure

- Both servers bind to `localhost` (127.0.0.1) only
- Not accessible from network by default
- Use AIRON relay server for remote access

## Architecture Notes

### Threading Model

- **Editor MCP**: Runs on background thread, commands executed on main thread via queued actions
- **Game MCP**: Runs on background thread, commands executed on main thread via queued actions in Update()

### Domain Reload Behavior

Unity's domain reload during compilation:
- Disconnects MCP server connections
- Changes instance IDs
- AIRON node client automatically reconnects and handles this

### Play Mode Transitions

- Game MCP server starts automatically when entering Play Mode
- Stops automatically when exiting Play Mode
- Editor MCP continues running throughout

## Troubleshooting

### Server Won't Start

- Check Unity console for error messages
- Verify port 3002/3003 aren't already in use
- Try restarting Unity

### Custom Tool Not Found

- Verify the full path is correct: `Namespace.ClassName.MethodName`
- Method must be `public static`
- Method must return `string`
- Restart MCP server after adding tools

### Authentication Failures

- Verify secret matches on both client and server
- Secret must be 16+ characters if used
- Check Unity console logs for auth errors

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

## Integration with AIRON System

This Unity package is part of the larger AIRON system:

- **airon-relay.js** - MCP relay server hosted at dev.airon.games
- **airon.js** - Node client connecting local Unity to Claude.ai
- **com.airon.mcp** - This Unity package (MCP servers)

See the main AIRON documentation for complete system setup.

## Version

**Version**: 0.1.0-alpha  
**Unity Version**: 2021.3+  
**License**: MIT

## Support

For issues, questions, or contributions, see the main AIRON repository.

---

**Built for AI-driven game development. Control Unity remotely, develop collaboratively with AI. 🚀**
