using System;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

#if UNITY_EDITOR
using UnityEditor;
#endif

namespace AIRON.MCP
{
    #if UNITY_EDITOR
    /// <summary>
    /// Dummy MCP server that runs on the game port when not in Play Mode.
    /// Returns tool list but errors on tool calls (except status which returns "off").
    /// </summary>
    [InitializeOnLoad]
    public static class ServerGameDummy
    {
        private static ServerGameDummyImpl _serverImpl;

        static ServerGameDummy()
        {
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;

            // Start dummy server if not in play mode
            if (!EditorApplication.isPlaying && !EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Start();
            }

            EditorApplication.update += ProcessMainThreadQueue;
            EditorApplication.quitting += Stop;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            switch (state)
            {
                case PlayModeStateChange.ExitingEditMode:
                    // Stop dummy server before entering play mode
                    Stop();
                    break;
                case PlayModeStateChange.EnteredEditMode:
                    // Restart dummy server after exiting play mode
                    // Use delayed start to ensure the real server's port is fully released
                    EditorApplication.delayCall += () =>
                    {
                        // Add small delay for socket TIME_WAIT to clear
                        EditorApplication.delayCall += Start;
                    };
                    break;
            }
        }

        public static void Start()
        {
            if (_serverImpl != null && _serverImpl.IsRunning()) return;

            var config = ConfigManager.LoadConfig();
            int port = config?.gamePort ?? Constants.DefaultGamePort;

            _serverImpl = new ServerGameDummyImpl(port);
            _serverImpl.LoadGameTools(config?.gameTools);
            _serverImpl.Start();
        }

        public static void Stop()
        {
            _serverImpl?.Stop();
            _serverImpl = null;
        }

        private static void ProcessMainThreadQueue()
        {
            _serverImpl?.ProcessQueue();
        }

        /// <summary>
        /// Dummy server implementation that returns tool list but errors on calls.
        /// </summary>
        private class ServerGameDummyImpl : ServerCore
        {
            private readonly Thread _mainThread;

            protected override string ServerName => "unity-game";
            protected override string ServerType => "game";

            public ServerGameDummyImpl(int port)
            {
                _port = port;
                _mainThread = Thread.CurrentThread;
            }

            public void Start() => StartServer();
            public void Stop() => StopServer();
            public void ProcessQueue() => ProcessMainThreadQueue();

            public void LoadGameTools(List<ConfigManager.CustomTool> tools)
            {
                LoadCustomTools(tools);
            }

            protected override bool IsMainThread()
            {
                return Thread.CurrentThread == _mainThread;
            }

            protected override List<Tool> GetBuiltInTools()
            {
                // Return the same tools as the real game server
                return new List<Tool>
                {
                    new Tool
                    {
                        Name = ToolNames.Status,
                        Description = "Get game status",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    CreateViewLogTool("View runtime game logs with optional line range and filtering", includeLogFilter: true)
                };
            }

            protected override string HandleBuiltInTool(string toolName, JObject args)
            {
                // Status returns "off" state
                if (toolName == ToolNames.Status)
                {
                    return JsonConvert.SerializeObject(new
                    {
                        running = false,
                        message = "Not in Play Mode",
                        serverStartTime = _serverStartTime.ToString("o")
                    });
                }

                // All other tools (built-in and custom) return error
                // Return non-null to prevent ServerCore from trying to invoke custom tools
                return "Error: Not in Play Mode. Enter Play Mode to use game tools.";
            }
        }
    }
    #endif

    /// <summary>
    /// MCP server for Unity runtime/game operations.
    /// Runs during Play Mode and provides game-specific tools.
    /// </summary>
    public class ServerGame : MonoBehaviour
    {
        // Server implementation (uses shared base class)
        private ServerGameImpl _serverImpl;

        // Log capture buffer
        private static readonly List<string> _logBuffer = new List<string>();
        private static readonly object _logBufferLock = new object();

        // Static reference for broadcast access
        private static ServerGame _instance;

        /// <summary>
        /// Gets the SSE connection manager for broadcasting events to connected clients.
        /// Returns null if SSE is disabled.
        /// </summary>
        public SSEConnectionManager SSE => _serverImpl?.SSE;

        /// <summary>
        /// Gets the current instance of the Game MCP Server.
        /// </summary>
        public static ServerGame Instance => _instance;

        /// <summary>
        /// Returns true if the server is running.
        /// </summary>
        public bool IsRunning() => _serverImpl?.IsRunning() ?? false;

        /// <summary>
        /// Gets the server port.
        /// </summary>
        public int GetPort() => _serverImpl?.GetPort() ?? Constants.DefaultGamePort;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void AutoStart()
        {
            // Check if auto-start is enabled (default: true)
            var config = ConfigManager.LoadConfig();
            bool autoStart = config?.gameAutoStart ?? true;

            if (autoStart)
            {
                var go = new GameObject(Constants.GameServerObjectName);
                go.AddComponent<ServerGame>();
                DontDestroyOnLoad(go);
            }
            else
            {
                Debug.Log("[AIRON] Game MCP auto-start is disabled");
            }
        }

        private void Start()
        {
            _instance = this;

            // Start capturing logs
            Application.logMessageReceived += HandleLog;

            // Load configuration
            var config = ConfigManager.LoadConfig();
            int port = config?.gamePort ?? Constants.DefaultGamePort;

            // Create and start server implementation
            _serverImpl = new ServerGameImpl(port, GetLogLines);

            // Load custom tools
            #if UNITY_EDITOR
            _serverImpl.LoadGameTools(config?.gameTools);
            #endif

            _serverImpl.Start();
        }

        private void HandleLog(string logString, string stackTrace, LogType type)
        {
            lock (_logBufferLock)
            {
                string logEntry = $"[{type}] {logString}";
                _logBuffer.Add(logEntry);

                // Keep only last MaxLogLines
                if (_logBuffer.Count > Constants.MaxLogLines)
                {
                    _logBuffer.RemoveAt(0);
                }
            }
        }

        private static string[] GetLogLines()
        {
            lock (_logBufferLock)
            {
                return _logBuffer.ToArray();
            }
        }

        private void OnDestroy()
        {
            _instance = null;
            Application.logMessageReceived -= HandleLog;
            _serverImpl?.Stop();
            _serverImpl = null;
        }

        private void Update()
        {
            _serverImpl?.ProcessQueue();
        }

        #region SSE Broadcasting API

        /// <summary>
        /// Broadcasts a custom event to all connected SSE clients.
        /// </summary>
        public void BroadcastEvent(string eventType, object data)
        {
            _serverImpl?.BroadcastEvent(eventType, data);
        }

        /// <summary>
        /// Broadcasts an MCP notification to all connected SSE clients.
        /// </summary>
        public void BroadcastNotification(string method, object @params = null)
        {
            _serverImpl?.BroadcastNotification(method, @params);
        }

        /// <summary>
        /// Gets the number of connected SSE clients.
        /// </summary>
        public int SSEClientCount => _serverImpl?.SSEClientCount ?? 0;

        /// <summary>
        /// Static helper to broadcast from anywhere during Play Mode.
        /// </summary>
        public static void Broadcast(string eventType, object data)
        {
            _instance?.BroadcastEvent(eventType, data);
        }

        #endregion

        /// <summary>
        /// Internal server implementation using shared ServerCore.
        /// </summary>
        private class ServerGameImpl : ServerCore
        {
            private readonly Func<string[]> _getLogLines;
            private readonly Thread _mainThread;

            protected override string ServerName => "unity-game";
            protected override string ServerType => "game";

            public ServerGameImpl(int port, Func<string[]> getLogLines)
            {
                _port = port;
                _getLogLines = getLogLines;
                _mainThread = Thread.CurrentThread;
            }

            public void Start()
            {
                StartServer();
            }

            public void Stop()
            {
                StopServer();
            }

            public void ProcessQueue()
            {
                ProcessMainThreadQueue();
            }

            public void LoadGameTools(List<ConfigManager.CustomTool> tools)
            {
                LoadCustomTools(tools);
            }

            protected override bool IsMainThread()
            {
                return Thread.CurrentThread == _mainThread;
            }

            protected override List<Tool> GetBuiltInTools()
            {
                return new List<Tool>
                {
                    new Tool
                    {
                        Name = ToolNames.Status,
                        Description = "Get game status",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    CreateViewLogTool("View runtime game logs with optional line range and filtering", includeLogFilter: true)
                };
            }

            protected override string HandleBuiltInTool(string toolName, JObject args)
            {
                switch (toolName)
                {
                    case ToolNames.Status:
                        return RunOnMainThread(() =>
                        {
                            return JsonConvert.SerializeObject(new
                            {
                                running = true,
                                time = Time.time,
                                frameCount = Time.frameCount,
                                scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                                serverStartTime = _serverStartTime.ToString("o")
                            });
                        });

                    case ToolNames.ViewLog:
                        return HandleViewLog(args);

                    default:
                        return null;
                }
            }

            private string HandleViewLog(JObject args)
            {
                try
                {
                    var lines = _getLogLines();
                    if (lines == null || lines.Length == 0)
                    {
                        return "[No logs captured yet]";
                    }
                    return FormatViewLogOutput(lines, args, "Game Runtime Log");
                }
                catch (Exception e)
                {
                    return $"Error reading log buffer: {e.Message}";
                }
            }
        }
    }
}
