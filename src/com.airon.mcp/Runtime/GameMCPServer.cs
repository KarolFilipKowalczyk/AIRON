using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AIRON.MCP
{
    public class GameMCPServer : MonoBehaviour
    {
        private const int Port = 3003;
        private HttpListener _listener;
        private Thread _thread;
        private bool _running;
        private readonly Queue<Action> _mainThreadQueue = new();
        
        // Cache custom tools on main thread
        private static List<MCPTool> _cachedCustomTools = new();
        
        // Cache secret on main thread (EditorPrefs can only be accessed from main thread)
        private string _cachedSecret = "";
        
        // Log capture buffer (max 1000 lines)
        private static readonly List<string> _logBuffer = new List<string>();
        private static readonly object _logBufferLock = new object();
        private const int MaxLogLines = 1000;
        
        // Track when server started (for detecting Play Mode entry)
        private DateTime _serverStartTime;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void AutoStart()
        {
            // Load custom tools cache
            LoadCustomToolsCache();
            
            // Check if auto-start is enabled (default: true)
            bool autoStart = UnityEditor.EditorPrefs.GetBool("AIRON_GameMCP_AutoStart", true);
            
            if (autoStart)
            {
                var go = new GameObject("[AIRON Game MCP]");
                go.AddComponent<GameMCPServer>();
                DontDestroyOnLoad(go);
            }
            else
            {
                Debug.Log("[AIRON] Game MCP auto-start is disabled");
            }
        }
        
        private static void LoadCustomToolsCache()
        {
            _cachedCustomTools.Clear();
            
            // Only load custom tools in Editor (not in IL2CPP builds)
            #if UNITY_EDITOR
            try
            {
                bool isInitialized = UnityEditor.EditorPrefs.GetBool("AIRON_GameMCP_CustomTools_Initialized", false);
                var customTools = UnityEditor.EditorPrefs.GetString("AIRON_GameMCP_CustomTools", "");
                
                // If never initialized, load defaults
                if (!isInitialized)
                {
                    var defaultTools = new List<Dictionary<string, string>>
                    {
                        new() { { "toolName", "AIRON.MCP.RuntimeExamples.GetLoadedScenes" }, { "description", "Get all loaded scenes" } },
                        new() { { "toolName", "AIRON.MCP.RuntimeExamples.SwitchScene" }, { "description", "Switch to a scene by name" } }
                    };
                    customTools = JsonConvert.SerializeObject(defaultTools);
                    UnityEditor.EditorPrefs.SetString("AIRON_GameMCP_CustomTools", customTools);
                    UnityEditor.EditorPrefs.SetBool("AIRON_GameMCP_CustomTools_Initialized", true);
                }
                
                if (string.IsNullOrEmpty(customTools))
                {
                    return;
                }
                
                var toolList = JsonConvert.DeserializeObject<List<Dictionary<string, string>>>(customTools);
                
                if (toolList == null)
                {
                    return;
                }
                
                foreach (var toolDef in toolList)
                {
                    if (!toolDef.TryGetValue("toolName", out var toolName) ||
                        !toolDef.TryGetValue("description", out var description))
                    {
                        Debug.LogWarning("[AIRON] Skipping game tool with missing toolName or description");
                        continue;
                    }
                    
                    var tool = GenerateToolFromReflection(toolName, description);
                    if (tool != null)
                    {
                        _cachedCustomTools.Add(tool);
                    }
                    else
                    {
                        Debug.LogWarning($"[AIRON] Failed to load custom game tool: {toolName}");
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[AIRON] Error loading Game MCP custom tools cache: {ex.Message}\n{ex.StackTrace}");
            }
            #else
            Debug.Log("[AIRON] Custom tools disabled in IL2CPP builds (Editor only feature)");
            #endif
        }

        private void Start()
        {
            try
            {
                // Start capturing logs
                Application.logMessageReceived += HandleLog;
                
                // Cache secret (EditorPrefs only accessible from main thread)
                #if UNITY_EDITOR
                _cachedSecret = UnityEditor.EditorPrefs.GetString("AIRON_EditorMCP_Secret", "");
                #endif
                
                // Record start time
                _serverStartTime = DateTime.UtcNow;
                
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://localhost:{Port}/");
                _listener.Start();
                _running = true;

                _thread = new Thread(ListenLoop) { IsBackground = true };
                _thread.Start();

                Debug.Log($"[AIRON] Game MCP server started on port {Port}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[AIRON] Failed to start Game MCP server: {e.Message}");
            }
        }
        
        private void HandleLog(string logString, string stackTrace, LogType type)
        {
            lock (_logBufferLock)
            {
                string logEntry = $"[{type}] {logString}";
                _logBuffer.Add(logEntry);
                
                // Keep only last MaxLogLines
                if (_logBuffer.Count > MaxLogLines)
                {
                    _logBuffer.RemoveAt(0);
                }
            }
        }

        private void OnDestroy()
        {
            Application.logMessageReceived -= HandleLog;
            _running = false;
            _listener?.Stop();
            _listener?.Close();
            _thread?.Join(1000);
            Debug.Log("[AIRON] Game MCP server stopped");
        }

        private void Update()
        {
            lock (_mainThreadQueue)
            {
                while (_mainThreadQueue.Count > 0)
                {
                    var action = _mainThreadQueue.Dequeue();
                    try { action(); }
                    catch (Exception e) { Debug.LogError($"[AIRON] Error: {e}"); }
                }
            }
        }

        private void ListenLoop()
        {
            while (_running)
            {
                try
                {
                    var context = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
                }
                catch (HttpListenerException) when (!_running) { }
                catch (Exception e)
                {
                    if (_running) Debug.LogError($"[AIRON] Listen error: {e.Message}");
                }
            }
        }

        private void HandleRequest(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            response.Headers.Add("Access-Control-Allow-Origin", "*");
            response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
                    responseBody = JsonConvert.SerializeObject(new { status = "ok", server = "game" });
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
                // Log to Unity console from thread
                UnityEngine.Debug.LogError($"[AIRON] Game MCP HandleRequest Exception: {e.Message}\n{e.StackTrace}");
                
                response.StatusCode = 500;
                var error = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new { error = e.Message, stackTrace = e.StackTrace }));
                response.ContentType = "application/json";
                response.ContentLength64 = error.Length;
                response.OutputStream.Write(error, 0, error.Length);
            }
            finally
            {
                response.Close();
            }
        }

        private MCPResponse HandleMCPRequest(MCPRequest request)
        {
            switch (request.Method)
            {
                case "initialize":
                    return MCPProtocol.CreateResult(request.Id, new
                    {
                        protocolVersion = "2024-11-05",
                        capabilities = new { tools = new { } },
                        serverInfo = new { name = "unity-game", version = "1.0.0" }
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

        private List<MCPTool> GetTools()
        {
            var tools = new List<MCPTool>
            {
                new()
                {
                    Name = "status",
                    Description = "Get game status",
                    InputSchema = new { type = "object", properties = new { } }
                },
                new()
                {
                    Name = "viewlog",
                    Description = "View runtime game logs with optional line range and filtering",
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
                                @enum = new[] { "all", "error", "warning", "info", "log" },
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

        private MCPResponse HandleToolCall(object id, string toolName, JObject args)
        {
            string result;

            switch (toolName)
            {
                case "status":
                    result = RunOnMainThread(() =>
                    {
                        return JsonConvert.SerializeObject(new
                        {
                            running = true,
                            time = Time.time,
                            frameCount = Time.frameCount,
                            scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                            serverStartTime = _serverStartTime.ToString("o") // ISO 8601 format
                        });
                    });
                    break;
                
                case "viewlog":
                    result = HandleViewLog(args);
                    break;

                default:
                    // Try to handle as custom tool (Editor only)
                    #if UNITY_EDITOR
                    result = HandleCustomTool(toolName, args);
                    if (result == null)
                    {
                        return MCPProtocol.CreateError(id, -32602, $"Unknown tool: {toolName}");
                    }
                    #else
                    return MCPProtocol.CreateError(id, -32602, $"Unknown tool: {toolName}");
                    #endif
                    break;
            }

            return MCPProtocol.CreateToolResult(id, result);
        }
        
        private string HandleViewLog(JObject args)
        {
            lock (_logBufferLock)
            {
                try
                {
                    if (_logBuffer.Count == 0)
                    {
                        return "[No logs captured yet]";
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
                        startLine = Math.Max(1, _logBuffer.Count - 49);
                        endLine = -1;
                    }
                    
                    // Convert to 0-indexed and handle -1 for end
                    int startIdx = Math.Max(0, startLine - 1);
                    int endIdx = endLine == -1 ? _logBuffer.Count - 1 : Math.Min(_logBuffer.Count - 1, endLine - 1);
                    
                    // Validate range
                    if (startIdx > endIdx || startIdx >= _logBuffer.Count)
                    {
                        return $"Invalid line range: [{startLine}, {endLine}]";
                    }
                    
                    // Get filter type
                    string filter = args?["filter"]?.ToString() ?? "all";
                    
                    // Build result
                    var result = new StringBuilder();
                    result.AppendLine($"[Game Runtime Log - Lines {startIdx + 1} to {endIdx + 1}]");
                    result.AppendLine(new string('─', 50));
                    
                    for (int i = startIdx; i <= endIdx; i++)
                    {
                        var line = _logBuffer[i];
                        
                        // Apply filter
                        if (filter != "all")
                        {
                            bool includeIt = false;
                            if (filter == "error" && (line.Contains("[Error]") || line.Contains("[Exception]")))
                                includeIt = true;
                            else if (filter == "warning" && line.Contains("[Warning]"))
                                includeIt = true;
                            else if (filter == "log" && line.Contains("[Log]"))
                                includeIt = true;
                            else if (filter == "info" && !line.Contains("[Error]") && !line.Contains("[Warning]") && !line.Contains("[Exception]"))
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
                    return $"Error reading log buffer: {e.Message}";
                }
            }
        }
        
        #if UNITY_EDITOR
        private string HandleCustomTool(string toolName, JObject args)
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
                    var invokeResult = method.Invoke(null, paramValues);
                    return invokeResult?.ToString() ?? "OK";
                });
            }
            catch (Exception e)
            {
                return $"Error invoking {toolName}: {e.Message}";
            }
        }
        
        private static MCPTool GenerateToolFromReflection(string toolName, string description)
        {
            // Split by last dot to separate method from class (supports namespaces)
            var lastDotIndex = toolName.LastIndexOf('.');
            if (lastDotIndex == -1)
            {
                Debug.LogError($"[AIRON] Invalid tool name format: {toolName}. Expected Namespace.ClassName.MethodName");
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
        #endif

        private string RunOnMainThread(Func<string> action)
        {
            string result = null;
            var done = new ManualResetEvent(false);

            lock (_mainThreadQueue)
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
    }

    // Re-declare MCPProtocol classes for Runtime assembly
    // (Or put them in a shared assembly both reference)
    
    public class MCPRequest
    {
        [JsonProperty("jsonrpc")] public string JsonRpc { get; set; } = "2.0";
        [JsonProperty("id")] public object Id { get; set; }
        [JsonProperty("method")] public string Method { get; set; }
        [JsonProperty("params")] public JObject Params { get; set; }
    }

    public class MCPResponse
    {
        [JsonProperty("jsonrpc")] public string JsonRpc { get; set; } = "2.0";
        [JsonProperty("id")] public object Id { get; set; }
        [JsonProperty("result", NullValueHandling = NullValueHandling.Ignore)] public object Result { get; set; }
        [JsonProperty("error", NullValueHandling = NullValueHandling.Ignore)] public MCPError Error { get; set; }
    }

    public class MCPError
    {
        [JsonProperty("code")] public int Code { get; set; }
        [JsonProperty("message")] public string Message { get; set; }
    }

    public class MCPTool
    {
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("description")] public string Description { get; set; }
        [JsonProperty("inputSchema")] public object InputSchema { get; set; }
    }

    public class MCPToolResult
    {
        [JsonProperty("content")] public List<MCPContent> Content { get; set; } = new();
    }

    public class MCPContent
    {
        [JsonProperty("type")] public string Type { get; set; } = "text";
        [JsonProperty("text")] public string Text { get; set; }
    }

    public static class MCPProtocol
    {
        public static MCPResponse CreateResult(object id, object result)
        {
            return new MCPResponse { Id = id, Result = result };
        }

        public static MCPResponse CreateError(object id, int code, string message)
        {
            return new MCPResponse { Id = id, Error = new MCPError { Code = code, Message = message } };
        }

        public static MCPResponse CreateToolResult(object id, string text)
        {
            return new MCPResponse
            {
                Id = id,
                Result = new MCPToolResult
                {
                    Content = new List<MCPContent> { new() { Text = text } }
                }
            };
        }
    }
}
