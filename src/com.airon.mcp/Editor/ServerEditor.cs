using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AIRON.MCP
{
    /// <summary>
    /// MCP server for Unity Editor operations.
    /// Provides tools for controlling Play Mode, viewing logs, and custom editor tools.
    /// </summary>
    [InitializeOnLoad]
    public static class ServerEditor
    {

        // Server implementation (uses shared base class)
        private static ServerEditorImpl _serverImpl;

        /// <summary>
        /// Gets the SSE connection manager for broadcasting events to connected clients.
        /// Returns null if SSE is disabled.
        /// </summary>
        public static SSEConnectionManager SSE => _serverImpl?.SSE;

        /// <summary>
        /// Returns true if the server is running.
        /// </summary>
        public static bool IsRunning() => _serverImpl?.IsRunning() ?? false;

        /// <summary>
        /// Gets the server port.
        /// </summary>
        public static int GetPort() => _serverImpl?.GetPort() ?? Constants.DefaultEditorPort;

        static ServerEditor()
        {
            // Load configuration
            var config = ConfigManager.LoadConfig();

            // Check if auto-start is enabled (default: true)
            bool autoStart = config?.editorAutoStart ?? true;

            if (autoStart)
            {
                Start();
            }
            else
            {
                Debug.Log("[AIRON] Editor MCP auto-start is disabled");
            }

            EditorApplication.update += ProcessMainThreadQueue;
            EditorApplication.quitting += Stop;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
        }

        public static void Start()
        {
            if (_serverImpl != null && _serverImpl.IsRunning()) return;

            // Load configuration
            var config = ConfigManager.LoadConfig();
            int port = config?.editorPort ?? Constants.DefaultEditorPort;

            // Create and start server implementation
            _serverImpl = new ServerEditorImpl(port);

            // Load custom tools
            _serverImpl.LoadEditorTools(config?.editorTools);

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

        #region SSE Broadcasting API

        /// <summary>
        /// Broadcasts a custom event to all connected SSE clients.
        /// </summary>
        public static void BroadcastEvent(string eventType, object data)
        {
            _serverImpl?.BroadcastEvent(eventType, data);
        }

        /// <summary>
        /// Broadcasts an MCP notification to all connected SSE clients.
        /// </summary>
        public static void BroadcastNotification(string method, object @params = null)
        {
            _serverImpl?.BroadcastNotification(method, @params);
        }

        /// <summary>
        /// Gets the number of connected SSE clients.
        /// </summary>
        public static int SSEClientCount => _serverImpl?.SSEClientCount ?? 0;

        #endregion

        /// <summary>
        /// Internal server implementation using shared ServerCore.
        /// </summary>
        private class ServerEditorImpl : ServerCore
        {
            private readonly Thread _mainThread;

            protected override string ServerName => "unity-editor";
            protected override string ServerType => "editor";

            public ServerEditorImpl(int port)
            {
                _port = port;
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

            public void LoadEditorTools(List<ConfigManager.CustomTool> tools)
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
                        Description = "Get Unity Editor status (playing, paused, compiling). Note: Unity only compiles when focused/foreground, so 'compiling: false' may mean files changed but Unity hasn't been focused yet.",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    new Tool
                    {
                        Name = ToolNames.Play,
                        Description = "Enter Play Mode",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    new Tool
                    {
                        Name = ToolNames.Stop,
                        Description = "Exit Play Mode",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    new Tool
                    {
                        Name = ToolNames.Pause,
                        Description = "Toggle pause in Play Mode",
                        InputSchema = new { type = "object", properties = new { } }
                    },
                    CreateViewLogTool("View Unity Editor log with optional line range and filtering", includeLogFilter: false)
                };
            }

            protected override string HandleBuiltInTool(string toolName, JObject args)
            {
                switch (toolName)
                {
                    case ToolNames.Status:
                        return RunOnMainThread(() => JsonConvert.SerializeObject(new
                        {
                            playing = EditorApplication.isPlaying,
                            paused = EditorApplication.isPaused,
                            compiling = EditorApplication.isCompiling,
                            project = Application.productName,
                            unityVersion = Application.unityVersion,
                            serverStartTime = _serverStartTime.ToString("o")
                        }));

                    case ToolNames.Play:
                        return RunOnMainThread(() =>
                        {
                            if (!EditorApplication.isPlaying)
                            {
                                EditorApplication.isPlaying = true;
                                return "Entering Play Mode";
                            }
                            return "Already in Play Mode";
                        });

                    case ToolNames.Stop:
                        return RunOnMainThread(() =>
                        {
                            if (EditorApplication.isPlaying)
                                EditorApplication.isPlaying = false;
                            return "Exiting Play Mode";
                        });

                    case ToolNames.Pause:
                        return RunOnMainThread(() =>
                        {
                            EditorApplication.isPaused = !EditorApplication.isPaused;
                            return EditorApplication.isPaused ? "Paused" : "Resumed";
                        });

                    case ToolNames.ViewLog:
                        return RunOnMainThread(() => HandleViewLog(args));

                    default:
                        return null;
                }
            }

            private string HandleViewLog(JObject args)
            {
                try
                {
                    // Get Editor.log path
                    string logPath = GetEditorLogPath();

                    if (!File.Exists(logPath))
                    {
                        return $"Editor.log not found at: {logPath}";
                    }

                    // Read all lines with FileShare.ReadWrite to allow reading while Unity is writing
                    string[] allLines;
                    using (var fileStream = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var streamReader = new StreamReader(fileStream))
                    {
                        var linesList = new List<string>();
                        string line;
                        while ((line = streamReader.ReadLine()) != null)
                        {
                            linesList.Add(line);
                        }
                        allLines = linesList.ToArray();
                    }

                    return FormatViewLogOutput(allLines, args, "Unity Editor Log");
                }
                catch (Exception e)
                {
                    return $"Error reading log: {e.Message}";
                }
            }

            private static string GetEditorLogPath()
            {
                if (Application.platform == RuntimePlatform.WindowsEditor)
                {
                    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Unity", "Editor", "Editor.log");
                }
                else if (Application.platform == RuntimePlatform.OSXEditor)
                {
                    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal),
                        "Library", "Logs", "Unity", "Editor.log");
                }
                else // Linux
                {
                    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal),
                        ".config", "unity3d", "Editor.log");
                }
            }
        }
    }
}
