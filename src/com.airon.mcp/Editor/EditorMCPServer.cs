using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AIRON.MCP
{
    [InitializeOnLoad]
    public static class EditorMCPServer
    {
        private const int DefaultPort = 3002;
        private static int _port;
        private static HttpListener _listener;
        private static Thread _thread;
        private static bool _running;
        private static readonly Queue<Action> _mainThreadQueue = new();
        private static readonly object _queueLock = new();
        
        // Cache custom tools on main thread
        private static List<MCPTool> _cachedCustomTools = new();
        
        // Cache secret on main thread (EditorPrefs can only be accessed from main thread)
        private static string _cachedSecret = "";
        
        // Track when server started (for detecting recompilation)
        private static readonly DateTime _serverStartTime = DateTime.UtcNow;
        // This timestamp helps detect when Unity last recompiled

        static EditorMCPServer()
        {
            // Load port configuration (default to 3002)
            _port = EditorPrefs.GetInt("AIRON_EditorMCP_Port", DefaultPort);
            
            // Load custom tools on main thread and cache them
            LoadCustomToolsCache();
            
            // Check if auto-start is enabled (default: true)
            bool autoStart = EditorPrefs.GetBool("AIRON_EditorMCP_AutoStart", true);
            
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
            if (_running) return;
            
            // Reload port configuration
            _port = EditorPrefs.GetInt("AIRON_EditorMCP_Port", DefaultPort);
            
            // Cache secret if set (EditorPrefs only accessible from main thread)
            _cachedSecret = EditorPrefs.GetString("AIRON_EditorMCP_Secret", "");

            try
            {
                // Reload custom tools cache before starting
                LoadCustomToolsCache();
                
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://localhost:{_port}/");
                _listener.Start();
                _running = true;

                _thread = new Thread(ListenLoop) { IsBackground = true };
                _thread.Start();

                Debug.Log($"[AIRON] Editor MCP server started on port {_port}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[AIRON] Failed to start Editor MCP server: {e.Message}");
            }
        }
        
        private static void LoadCustomToolsCache()
        {
            _cachedCustomTools.Clear();
            
            try
            {
                bool isInitialized = EditorPrefs.GetBool("AIRON_EditorMCP_CustomTools_Initialized", false);
                var customTools = EditorPrefs.GetString("AIRON_EditorMCP_CustomTools", "");
                
                // If never initialized, load defaults
                if (!isInitialized)
                {
                    var defaultTools = new List<Dictionary<string, string>>
                    {
                        new() { { "toolName", "AIRON.MCP.Examples.ListScenes" }, { "description", "List all scenes in the project" } },
                        new() { { "toolName", "AIRON.MCP.Examples.LoadScene" }, { "description", "Load a scene by name" } }
                    };
                    customTools = JsonConvert.SerializeObject(defaultTools);
                    EditorPrefs.SetString("AIRON_EditorMCP_CustomTools", customTools);
                    EditorPrefs.SetBool("AIRON_EditorMCP_CustomTools_Initialized", true);
                }
                
                if (string.IsNullOrEmpty(customTools))
                {
                    Debug.Log("[AIRON] No custom tools configured");
                    return;
                }
                
                var toolList = JsonConvert.DeserializeObject<List<Dictionary<string, string>>>(customTools);
                
                if (toolList == null)
                {
                    Debug.Log("[AIRON] Custom tools list is null");
                    return;
                }
                
                foreach (var toolDef in toolList)
                {
                    if (!toolDef.TryGetValue("toolName", out var toolName) ||
                        !toolDef.TryGetValue("description", out var description))
                    {
                        Debug.LogWarning("[AIRON] Skipping tool with missing toolName or description");
                        continue;
                    }
                    
                    var tool = GenerateToolFromReflection(toolName, description);
                    if (tool != null)
                    {
                        _cachedCustomTools.Add(tool);
                    }
                    else
                    {
                        Debug.LogWarning($"[AIRON] Failed to load custom tool: {toolName}");
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[AIRON] Error loading custom tools cache: {ex.Message}\n{ex.StackTrace}");
            }
        }

        public static void Stop()
        {
            _running = false;
            _listener?.Stop();
            _listener?.Close();
            _thread?.Join(1000);
            Debug.Log("[AIRON] Editor MCP server stopped");
        }

        public static bool IsRunning()
        {
            return _running;
        }
        
        public static int GetPort()
        {
            return _port;
        }

        private static void ListenLoop()
        {
            while (_running)
            {
                try
                {
                    var context = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
                }
                catch (HttpListenerException) when (!_running) 
                {
                    // Server stopped, exit gracefully
                }
                catch (Exception e)
                {
                    if (_running) Debug.LogError($"[AIRON] Listen error: {e.Message}");
                }
            }
        }

        private static void HandleRequest(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            // No CORS headers - restrict to localhost only for security
            
            if (request.HttpMethod == "OPTIONS")
            {
                response.StatusCode = 200;
                response.Close();
                return;
            }
            
            // Check authentication using cached secret (can't access EditorPrefs from thread pool)
            if (!string.IsNullOrEmpty(_cachedSecret))
            {
                string authHeader = request.Headers["Authorization"];
                string providedSecret = authHeader?.Replace("Bearer ", "").Trim();
                
                if (providedSecret != _cachedSecret)
                {
                    Debug.LogWarning("[AIRON] Authentication failed - invalid or missing secret");
                    response.StatusCode = 401;
                    var errorResponse = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new { error = "Unauthorized: Invalid or missing secret token" }));
                    response.ContentLength64 = errorResponse.Length;
                    response.OutputStream.Write(errorResponse, 0, errorResponse.Length);
                    response.Close();
                    return;
                }
            }

            try
            {
                string responseBody;

                if (request.HttpMethod == "GET" && request.Url.AbsolutePath == "/mcp")
                {
                    // Health check
                    responseBody = JsonConvert.SerializeObject(new { status = "ok", server = "editor" });
                }
                else if (request.HttpMethod == "POST" && request.Url.AbsolutePath == "/mcp")
                {
                    using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
                    var body = reader.ReadToEnd();
                    var mcpRequest = JsonConvert.DeserializeObject<MCPRequest>(body);
                    var mcpResponse = HandleMCPRequest(mcpRequest);
                    responseBody = JsonConvert.SerializeObject(mcpResponse);
                }
                else
                {
                    response.StatusCode = 404;
                    responseBody = "Not found";
                }

                var buffer = Encoding.UTF8.GetBytes(responseBody);
                response.ContentType = "application/json";
                response.ContentLength64 = buffer.Length;
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            catch (Exception e)
            {
                Debug.LogError($"[AIRON] Exception in HandleRequest: {e.Message}\n{e.StackTrace}");
                response.StatusCode = 500;
                var error = Encoding.UTF8.GetBytes(e.Message);
                response.OutputStream.Write(error, 0, error.Length);
            }
            finally
            {
                response.Close();
            }
        }

        private static MCPResponse HandleMCPRequest(MCPRequest request)
        {
            switch (request.Method)
            {
                case "initialize":
                    return MCPProtocol.CreateResult(request.Id, new
                    {
                        protocolVersion = "2024-11-05",
                        capabilities = new { tools = new { } },
                        serverInfo = new { name = "unity-editor", version = "1.0.0" }
                    });

                case "tools/list":
                    return MCPProtocol.CreateResult(request.Id, new { tools = GetTools() });

                case "tools/call":
                    var toolName = request.Params?["name"]?.ToString();
                    var toolArgs = request.Params?["arguments"] as JObject;
                    return HandleToolCall(request.Id, toolName, toolArgs);

                default:
                    return MCPProtocol.CreateError(request.Id, -32601, "Method not found");
            }
        }

        private static List<MCPTool> GetTools()
        {
            var tools = new List<MCPTool>
            {
                new()
                {
                    Name = "status",
                    Description = "Get Unity Editor status (playing, paused, compiling). Note: Unity only compiles when focused/foreground, so 'compiling: false' may mean files changed but Unity hasn't been focused yet.",
                    InputSchema = new { type = "object", properties = new { } }
                },
                new()
                {
                    Name = "play",
                    Description = "Enter Play Mode",
                    InputSchema = new { type = "object", properties = new { } }
                },
                new()
                {
                    Name = "stop",
                    Description = "Exit Play Mode",
                    InputSchema = new { type = "object", properties = new { } }
                },
                new()
                {
                    Name = "pause",
                    Description = "Toggle pause in Play Mode",
                    InputSchema = new { type = "object", properties = new { } }
                },
                new()
                {
                    Name = "viewlog",
                    Description = "View Unity Editor log with optional line range and filtering",
                    InputSchema = new
                    {
                        type = "object",
                        properties = new
                        {
                            lines = new 
                            { 
                                type = "array", 
                                items = new { type = "integer" },
                                description = "[start, end] line numbers (1-indexed, -1 for end of file). If omitted, shows last 50 lines."
                            },
                            filter = new 
                            { 
                                type = "string",
                                @enum = new[] { "all", "error", "warning", "info" },
                                description = "Filter by log type (default: all)"
                            }
                        }
                    }
                }
            };
            
            // Add cached custom tools (loaded on main thread)
            tools.AddRange(_cachedCustomTools);
            
            return tools;
        }
        
        private static MCPTool GenerateToolFromReflection(string toolName, string description)
        {
            // Split by last dot to separate method from class (supports namespaces)
            var lastDotIndex = toolName.LastIndexOf('.');
            if (lastDotIndex == -1)
            {
                Debug.LogError($"[AIRON] Invalid tool name format: {toolName}. Expected ClassName.MethodName or Namespace.ClassName.MethodName");
                return null;
            }
            
            var classPath = toolName.Substring(0, lastDotIndex);
            var methodName = toolName.Substring(lastDotIndex + 1);
            
            // Find the type by full name (includes namespace) or by class name
            var type = AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(a => a.GetExportedTypes())
                .FirstOrDefault(t => t.FullName == classPath || t.Name == classPath);
            
            if (type == null)
            {
                Debug.LogError($"[AIRON] Class not found: {classPath}. Make sure to include namespace if needed (e.g., Namespace.ClassName.MethodName)");
                return null;
            }
            
            // Find the static method
            var method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static);
            
            if (method == null)
            {
                Debug.LogError($"[AIRON] Static method not found: {classPath}.{methodName}");
                return null;
            }
            
            // Build input schema from parameters
            var properties = new Dictionary<string, object>();
            var required = new List<string>();
            
            foreach (var param in method.GetParameters())
            {
                string jsonType = param.ParameterType.Name switch
                {
                    "Int32" => "integer",
                    "Single" => "number",
                    "Double" => "number",
                    "String" => "string",
                    "Boolean" => "boolean",
                    _ => "string"
                };
                
                properties[param.Name] = new
                {
                    type = jsonType,
                    description = $"{param.ParameterType.Name} parameter"
                };
                
                if (!param.IsOptional)
                {
                    required.Add(param.Name);
                }
            }
            
            return new MCPTool
            {
                Name = toolName,
                Description = description,
                InputSchema = new
                {
                    type = "object",
                    properties = properties,
                    required = required.ToArray()
                }
            };
        }

        private static MCPResponse HandleToolCall(object id, string toolName, JObject args)
        {
            string result;

            switch (toolName)
            {
                case "status":
                    result = RunOnMainThread(() => JsonConvert.SerializeObject(new
                    {
                        playing = EditorApplication.isPlaying,
                        paused = EditorApplication.isPaused,
                        compiling = EditorApplication.isCompiling,
                        project = Application.productName,
                        unityVersion = Application.unityVersion,
                        serverStartTime = _serverStartTime.ToString("o") // ISO 8601 format
                    }));
                    break;

                case "play":
                    result = RunOnMainThread(() =>
                    {
                        if (!EditorApplication.isPlaying)
                        {
                            EditorApplication.isPlaying = true;
                            return "Entering Play Mode";
                        }
                        return "Already in Play Mode";
                    });
                    break;

                case "stop":
                    result = RunOnMainThread(() =>
                    {
                        if (EditorApplication.isPlaying)
                            EditorApplication.isPlaying = false;
                        return "Exiting Play Mode";
                    });
                    break;

                case "pause":
                    result = RunOnMainThread(() =>
                    {
                        EditorApplication.isPaused = !EditorApplication.isPaused;
                        return EditorApplication.isPaused ? "Paused" : "Resumed";
                    });
                    break;

                case "viewlog":
                    result = RunOnMainThread(() => HandleViewLog(args));
                    break;

                default:
                    // Try to handle as custom tool
                    result = HandleCustomTool(toolName, args);
                    if (result == null)
                    {
                        return MCPProtocol.CreateError(id, -32602, $"Unknown tool: {toolName}");
                    }
                    break;
            }

            return MCPProtocol.CreateToolResult(id, result);
        }
        
        private static string HandleCustomTool(string toolName, JObject args)
        {
            // SECURITY: Only allow tools that are explicitly configured in the custom tools list
            var allowedTool = _cachedCustomTools.FirstOrDefault(t => t.Name == toolName);
            if (allowedTool == null)
            {
                return null; // Tool not in allowed list
            }
            
            // Split by last dot to separate method from class (supports namespaces)
            var lastDotIndex = toolName.LastIndexOf('.');
            if (lastDotIndex == -1) return null;
            
            var classPath = toolName.Substring(0, lastDotIndex);
            var methodName = toolName.Substring(lastDotIndex + 1);
            
            // Find the type by full name (includes namespace) or by class name
            var type = AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(a => a.GetExportedTypes())
                .FirstOrDefault(t => t.FullName == classPath || t.Name == classPath);
            
            if (type == null) return null;
            
            // Find the static method
            var method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static);
            if (method == null) return null;
            
            try
            {
                // Convert JSON args to method parameters
                var parameters = method.GetParameters();
                var paramValues = new object[parameters.Length];
                
                for (int i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];
                    var argValue = args?[param.Name];
                    
                    if (argValue == null && !param.IsOptional)
                    {
                        return $"Error: Missing required parameter '{param.Name}'";
                    }
                    
                    // Convert JSON to correct type
                    if (argValue != null)
                    {
                        paramValues[i] = argValue.ToObject(param.ParameterType);
                    }
                    else if (param.IsOptional)
                    {
                        paramValues[i] = param.DefaultValue;
                    }
                }
                
                // Invoke the method on main thread
                return RunOnMainThread(() =>
                {
                    var result = method.Invoke(null, paramValues);
                    return result?.ToString() ?? "OK";
                });
            }
            catch (Exception e)
            {
                return $"Error invoking {toolName}: {e.Message}";
            }
        }
        
        private static string HandleViewLog(JObject args)
        {
            try
            {
                // Get Editor.log path
                string logPath;
                if (Application.platform == RuntimePlatform.WindowsEditor)
                {
                    logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Unity", "Editor", "Editor.log");
                }
                else if (Application.platform == RuntimePlatform.OSXEditor)
                {
                    logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), "Library", "Logs", "Unity", "Editor.log");
                }
                else // Linux
                {
                    logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), ".config", "unity3d", "Editor.log");
                }
                
                if (!File.Exists(logPath))
                {
                    return $"Editor.log not found at: {logPath}";
                }
                
                // Read all lines with FileShare.ReadWrite to allow reading while Unity is writing
                string[] allLines;
                using (var fileStream = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var streamReader = new StreamReader(fileStream))
                {
                    var linesList = new System.Collections.Generic.List<string>();
                    string line;
                    while ((line = streamReader.ReadLine()) != null)
                    {
                        linesList.Add(line);
                    }
                    allLines = linesList.ToArray();
                }
                
                // Parse line range parameter
                int startLine = 1;
                int endLine = -1;
                
                if (args?["lines"] != null)
                {
                    var linesArray = args["lines"].ToObject<int[]>();
                    if (linesArray != null && linesArray.Length == 2)
                    {
                        startLine = linesArray[0];
                        endLine = linesArray[1];
                    }
                }
                else
                {
                    // Default: last 50 lines
                    startLine = Math.Max(1, allLines.Length - 49);
                    endLine = -1;
                }
                
                // Convert to 0-indexed and handle -1 for end
                int startIdx = Math.Max(0, startLine - 1);
                int endIdx = endLine == -1 ? allLines.Length - 1 : Math.Min(allLines.Length - 1, endLine - 1);
                
                // Validate range
                if (startIdx > endIdx || startIdx >= allLines.Length)
                {
                    return $"Invalid line range: [{startLine}, {endLine}]";
                }
                
                // Get filter type
                string filter = args?["filter"]?.ToString() ?? "all";
                
                // Build result
                var result = new StringBuilder();
                result.AppendLine($"[Unity Editor Log - Lines {startIdx + 1} to {endIdx + 1}]");
                result.AppendLine(new string('─', 50));
                
                for (int i = startIdx; i <= endIdx; i++)
                {
                    var line = allLines[i];
                    
                    // Apply filter
                    if (filter != "all")
                    {
                        bool includeIt = false;
                        if (filter == "error" && (line.Contains("Error") || line.Contains("Exception")))
                            includeIt = true;
                        else if (filter == "warning" && line.Contains("Warning"))
                            includeIt = true;
                        else if (filter == "info" && !line.Contains("Error") && !line.Contains("Warning") && !line.Contains("Exception"))
                            includeIt = true;
                        
                        if (!includeIt)
                            continue;
                    }
                    
                    result.AppendLine($"{i + 1}: {line}");
                }
                
                result.AppendLine(new string('─', 50));
                return result.ToString();
            }
            catch (Exception e)
            {
                return $"Error reading log: {e.Message}";
            }
        }

        private static string RunOnMainThread(Func<string> action)
        {
            if (Thread.CurrentThread.ManagedThreadId == 1)
                return action();

            string result = null;
            var done = new ManualResetEvent(false);

            lock (_queueLock)
            {
                _mainThreadQueue.Enqueue(() =>
                {
                    result = action();
                    done.Set();
                });
            }

            done.WaitOne(5000);
            return result ?? "Timeout";
        }

        private static void ProcessMainThreadQueue()
        {
            lock (_queueLock)
            {
                while (_mainThreadQueue.Count > 0)
                {
                    var action = _mainThreadQueue.Dequeue();
                    try { action(); }
                    catch (Exception e) { Debug.LogError($"[AIRON] Main thread action failed: {e}"); }
                }
            }
        }
    }
}
