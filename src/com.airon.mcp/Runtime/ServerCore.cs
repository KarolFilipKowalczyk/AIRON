using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Shared base functionality for MCP servers.
    /// Implements the Streamable HTTP transport (MCP spec 2025-03-26).
    /// Single /mcp endpoint supporting POST (requests) and GET (SSE stream).
    /// </summary>
    public abstract class ServerCore
    {
        // Configuration
        protected int _port;
        protected DateTime _serverStartTime;

        // HTTP infrastructure
        private HttpListener _listener;
        private Thread _listenerThread;
        private volatile bool _running;

        // Main thread execution
        private MainThreadExecutor _executor;

        // Custom tools (thread-safe)
        protected readonly ConcurrentBag<Tool> _customTools = new();

        // SSE Connection Manager (for Streamable HTTP GET connections)
        private SSEConnectionManager _sseManager;

        // Session management
        private readonly ConcurrentDictionary<string, SessionInfo> _sessions = new();

        private class SessionInfo
        {
            public string Id { get; set; }
            public DateTime CreatedAt { get; set; }
            public DateTime LastActivityAt { get; set; }
            public bool Initialized { get; set; }
        }

        #region Abstract Properties

        /// <summary>
        /// Server name for logging and MCP info (e.g., "unity-editor").
        /// </summary>
        protected abstract string ServerName { get; }

        /// <summary>
        /// Server type for health check responses (e.g., "editor").
        /// </summary>
        protected abstract string ServerType { get; }

        #endregion

        #region Public API

        public bool IsRunning() => _running;
        public int GetPort() => _port;
        public SSEConnectionManager SSE => _sseManager;
        public int SSEClientCount => _sseManager?.ClientCount ?? 0;

        /// <summary>
        /// Broadcasts a custom event to all connected SSE clients.
        /// </summary>
        public void BroadcastEvent(string eventType, object data)
        {
            _sseManager?.Broadcast(eventType, data);
        }

        /// <summary>
        /// Broadcasts an MCP notification to all connected SSE clients.
        /// </summary>
        public void BroadcastNotification(string method, object @params = null)
        {
            _sseManager?.BroadcastNotification(method, @params);
        }

        #endregion

        #region Server Lifecycle

        /// <summary>
        /// Starts the MCP server using Streamable HTTP transport.
        /// Single endpoint at /mcp supporting POST and GET (SSE).
        /// Always binds to localhost only for security.
        /// Includes retry logic to handle port conflicts during server switching.
        /// </summary>
        /// <returns>True if server started successfully, false otherwise.</returns>
        protected bool StartServer()
        {
            if (_running) return true;

            _serverStartTime = DateTime.UtcNow;
            _executor = new MainThreadExecutor(ServerName);
            _sseManager = new SSEConnectionManager(ServerName);

            // Retry loop to handle port conflicts when switching between servers
            for (int attempt = 1; attempt <= Constants.ServerStartMaxRetries; attempt++)
            {
                try
                {
                    // Start HTTP listener - single endpoint for Streamable HTTP
                    // Always bind to localhost only for security
                    _listener = new HttpListener();
                    _listener.Prefixes.Add($"http://localhost:{_port}/");
                    _listener.Start();
                    _running = true;

                    _listenerThread = new Thread(ListenLoop) { IsBackground = true };
                    _listenerThread.Start();

                    Logger.LogServerEvent(ServerName, "started", _port, "Streamable HTTP, localhost only");
                    return true; // Success
                }
                catch (Exception e) when (IsAddressInUseException(e))
                {
                    // Address already in use - retry after delay
                    // Clean up failed listener
                    try { _listener?.Close(); } catch { }
                    _listener = null;

                    if (attempt < Constants.ServerStartMaxRetries)
                    {
                        Logger.LogDebug($"{ServerName} port {_port} in use, retrying ({attempt}/{Constants.ServerStartMaxRetries})...");
                        Thread.Sleep(Constants.ServerStartRetryDelayMs);
                    }
                    else
                    {
                        Logger.LogError($"Failed to start {ServerName} MCP server after {Constants.ServerStartMaxRetries} attempts: {e.Message}");
                        _executor = null;
                        _sseManager = null;
                    }
                }
                catch (Exception e)
                {
                    // Non-retryable error
                    try { _listener?.Close(); } catch { }
                    _listener = null;
                    _executor = null;
                    _sseManager = null;
                    Logger.LogError($"Failed to start {ServerName} MCP server: {e.Message}");
                    return false;
                }
            }

            return false; // All retries failed
        }

        /// <summary>
        /// Stops the server and cleans up resources.
        /// </summary>
        protected void StopServer()
        {
            _running = false;

            _sseManager?.Shutdown();
            _sseManager = null;

            // Use Abort() for aggressive shutdown - immediately terminates all operations
            // and releases the port faster than Stop() + Close()
            try { _listener?.Abort(); } catch { }
            _listenerThread?.Join(Constants.ThreadJoinTimeoutMs);

            _sessions.Clear();
            _executor = null;
        }

        /// <summary>
        /// Processes queued main thread actions. Call from Update().
        /// </summary>
        protected void ProcessMainThreadQueue()
        {
            _executor?.ProcessQueue();
        }

        /// <summary>
        /// Loads custom tools from configuration.
        /// </summary>
        protected virtual void LoadCustomTools(List<ConfigManager.CustomTool> toolConfigs)
        {
            while (_customTools.TryTake(out _)) { }

            if (toolConfigs == null || toolConfigs.Count == 0)
            {
                Logger.LogDebug($"No custom {ServerType} tools configured");
                return;
            }

            ReflectionToolHelper.PreloadTools(toolConfigs);

            foreach (var tool in toolConfigs)
            {
                if (string.IsNullOrEmpty(tool.toolName) || string.IsNullOrEmpty(tool.description))
                {
                    Logger.LogWarning($"Skipping {ServerType} tool with missing toolName or description");
                    continue;
                }

                var mcpTool = ReflectionToolHelper.GenerateToolFromReflection(tool.toolName, tool.description);
                if (mcpTool != null)
                {
                    _customTools.Add(mcpTool);
                }
                else
                {
                    Logger.LogWarning($"Failed to load custom {ServerType} tool: {tool.toolName}");
                }
            }
        }

        #endregion

        #region HTTP Handling

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
                    if (_running) Logger.LogError($"{ServerName} listen error: {e.Message}");
                }
            }
        }

        private void HandleRequest(HttpListenerContext context)
        {
            // Early exit if server is shutting down
            if (!_running)
            {
                try { context.Response.Close(); } catch { }
                return;
            }

            var request = context.Request;
            var response = context.Response;

            // Add CORS headers for all responses
            response.Headers.Add("Access-Control-Allow-Origin", "*");
            response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID");
            response.Headers.Add("Access-Control-Expose-Headers", "Mcp-Session-Id");

            if (request.HttpMethod == "OPTIONS")
            {
                response.StatusCode = 200;
                response.Close();
                return;
            }

            try
            {
                // Streamable HTTP: single /mcp endpoint
                if (request.Url.AbsolutePath == "/mcp")
                {
                    HandleMCPEndpoint(context);
                    return;
                }

                // Legacy compatibility: /sse redirects info
                if (request.Url.AbsolutePath == "/sse" || request.Url.AbsolutePath == "/mcp/sse")
                {
                    SendJsonResponse(response, 200, new
                    {
                        error = "Legacy SSE endpoint deprecated",
                        message = "Use Streamable HTTP: GET /mcp with Accept: text/event-stream",
                        endpoint = "/mcp"
                    });
                    return;
                }

                // 404 for unknown paths
                response.StatusCode = 404;
                var errorBody = Encoding.UTF8.GetBytes("Not found. Use /mcp endpoint.");
                response.ContentType = "text/plain";
                response.ContentLength64 = errorBody.Length;
                response.OutputStream.Write(errorBody, 0, errorBody.Length);
            }
            catch (Exception e)
            {
                // Skip logging and response if server is shutting down
                if (!_running) return;

                Logger.LogError($"{ServerName} request error: {e.Message}");
                try { SendJsonResponse(response, 500, new { error = e.Message }); } catch { }
            }
            finally
            {
                try { response.Close(); } catch { }
            }
        }

        /// <summary>
        /// Handles requests to the /mcp endpoint (Streamable HTTP transport).
        /// POST: JSON-RPC requests, responds with JSON or SSE stream
        /// GET: Opens SSE stream for server-to-client notifications
        /// DELETE: Terminates session
        /// </summary>
        private void HandleMCPEndpoint(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            switch (request.HttpMethod)
            {
                case "POST":
                    HandleMCPPost(context);
                    break;

                case "GET":
                    if (AcceptsSSE(request))
                    {
                        HandleMCPGetSSE(context);
                    }
                    else
                    {
                        // GET without SSE Accept header = health check
                        var healthInfo = GetHealthCheckInfo();
                        SendJsonResponse(response, 200, healthInfo);
                    }
                    break;

                case "DELETE":
                    HandleSessionTermination(context);
                    break;

                default:
                    response.StatusCode = 405;
                    response.Headers.Add("Allow", "GET, POST, DELETE, OPTIONS");
                    var errorBody = Encoding.UTF8.GetBytes("Method not allowed");
                    response.ContentType = "text/plain";
                    response.ContentLength64 = errorBody.Length;
                    response.OutputStream.Write(errorBody, 0, errorBody.Length);
                    break;
            }
        }

        /// <summary>
        /// Handles POST /mcp - JSON-RPC requests.
        /// </summary>
        private void HandleMCPPost(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            try
            {
                using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
                var body = reader.ReadToEnd();

                // Check if it's a batch request (array)
                var trimmedBody = body.TrimStart();
                if (trimmedBody.StartsWith("["))
                {
                    // Batch request
                    var requests = JsonConvert.DeserializeObject<List<Request>>(body);
                    var responses = new List<Response>();

                    foreach (var req in requests)
                    {
                        var mcpResponse = HandleMCPRequest(req, context);
                        if (mcpResponse != null)
                        {
                            responses.Add(mcpResponse);

                            // Check if this is an initialize response - add session ID
                            if (req.Method == "initialize" && mcpResponse.Error == null)
                            {
                                AddSessionIdToResponse(response, req);
                            }
                        }
                    }

                    if (responses.Count == 0)
                    {
                        // All were notifications - return 202 Accepted
                        response.StatusCode = 202;
                        response.Close();
                    }
                    else
                    {
                        SendJsonResponse(response, 200, responses);
                    }
                }
                else
                {
                    // Single request
                    var mcpRequest = JsonConvert.DeserializeObject<Request>(body);

                    // Check if it's a notification (no id)
                    if (mcpRequest.Id == null)
                    {
                        HandleMCPRequest(mcpRequest, context);
                        response.StatusCode = 202;
                        response.Close();
                        return;
                    }

                    var mcpResponse = HandleMCPRequest(mcpRequest, context);

                    // Add session ID for initialize responses
                    if (mcpRequest.Method == "initialize" && mcpResponse?.Error == null)
                    {
                        AddSessionIdToResponse(response, mcpRequest);
                    }

                    SendJsonResponse(response, 200, mcpResponse);
                }
            }
            catch (JsonException e)
            {
                SendJsonResponse(response, 400, Protocol.CreateError(null, -32700, $"Parse error: {e.Message}"));
            }
            catch (Exception e)
            {
                Logger.LogError($"{ServerName} POST error: {e.Message}");
                SendJsonResponse(response, 500, Protocol.CreateError(null, Constants.ErrorInternal, e.Message));
            }
        }

        /// <summary>
        /// Handles GET /mcp with Accept: text/event-stream - opens SSE stream.
        /// </summary>
        private void HandleMCPGetSSE(HttpListenerContext context)
        {
            var request = context.Request;

            SSEClient client = null;
            try
            {
                client = _sseManager.CreateClient(context);

                // Send endpoint info as first event
                client.SendJsonEvent("endpoint", new
                {
                    protocol = "streamable-http",
                    version = Constants.ProtocolVersion,
                    capabilities = new { streaming = true }
                });

                // Check for Last-Event-ID header for resumption
                string lastEventId = request.Headers["Last-Event-ID"];
                if (!string.IsNullOrEmpty(lastEventId))
                {
                    Logger.LogDebug($"Client attempting to resume from event: {lastEventId}");
                    // Note: Full resumption would require event history storage
                }

                // Keep connection open for server-to-client notifications
                while (_running && client.IsConnected)
                {
                    Thread.Sleep(Constants.SSELoopSleepMs);
                }
            }
            catch (Exception e)
            {
                Logger.LogError($"{ServerName} SSE error: {e.Message}");
            }
            finally
            {
                if (client != null)
                    _sseManager.RemoveClient(client.Id);
            }
        }

        /// <summary>
        /// Handles DELETE /mcp - session termination.
        /// </summary>
        private void HandleSessionTermination(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            string sessionId = request.Headers["Mcp-Session-Id"];
            if (string.IsNullOrEmpty(sessionId))
            {
                response.StatusCode = 400;
                var errorBody = Encoding.UTF8.GetBytes("Missing Mcp-Session-Id header");
                response.ContentType = "text/plain";
                response.ContentLength64 = errorBody.Length;
                response.OutputStream.Write(errorBody, 0, errorBody.Length);
                return;
            }

            if (_sessions.TryRemove(sessionId, out _))
            {
                Logger.LogDebug($"Session terminated: {sessionId}");
                response.StatusCode = 202;
            }
            else
            {
                response.StatusCode = 404;
                var errorBody = Encoding.UTF8.GetBytes("Session not found");
                response.ContentType = "text/plain";
                response.ContentLength64 = errorBody.Length;
                response.OutputStream.Write(errorBody, 0, errorBody.Length);
            }
        }

        private bool AcceptsSSE(HttpListenerRequest request)
        {
            string acceptHeader = request.Headers["Accept"];
            return acceptHeader != null && acceptHeader.Contains("text/event-stream");
        }

        private void AddSessionIdToResponse(HttpListenerResponse response, Request mcpRequest)
        {
            string sessionId = Guid.NewGuid().ToString("N");
            _sessions[sessionId] = new SessionInfo
            {
                Id = sessionId,
                CreatedAt = DateTime.UtcNow,
                LastActivityAt = DateTime.UtcNow,
                Initialized = true
            };
            response.Headers.Add("Mcp-Session-Id", sessionId);
        }

        private object GetHealthCheckInfo()
        {
            return new
            {
                status = "ok",
                server = ServerType,
                transport = "streamable-http",
                protocolVersion = Constants.ProtocolVersion,
                port = _port,
                sseClients = _sseManager?.ClientCount ?? 0,
                activeSessions = _sessions.Count
            };
        }

        private void SendJsonResponse(HttpListenerResponse response, int statusCode, object data)
        {
            response.StatusCode = statusCode;
            response.ContentType = "application/json";
            var json = JsonConvert.SerializeObject(data);
            var buffer = Encoding.UTF8.GetBytes(json);
            response.ContentLength64 = buffer.Length;
            response.OutputStream.Write(buffer, 0, buffer.Length);
        }

        #endregion

        #region MCP Protocol

        private Response HandleMCPRequest(Request request, HttpListenerContext context = null)
        {
            // Update session activity if session ID provided
            string sessionId = context?.Request.Headers["Mcp-Session-Id"];
            if (!string.IsNullOrEmpty(sessionId) && _sessions.TryGetValue(sessionId, out var session))
            {
                session.LastActivityAt = DateTime.UtcNow;
            }

            switch (request.Method)
            {
                case "initialize":
                    return Protocol.CreateResult(request.Id, new
                    {
                        protocolVersion = Constants.ProtocolVersion,
                        capabilities = new { tools = new { } },
                        serverInfo = new { name = ServerName, version = Constants.ServerVersion }
                    });

                case "initialized":
                    // Notification - no response needed
                    return null;

                case "tools/list":
                    return Protocol.CreateResult(request.Id, new { tools = GetAllTools() });

                case "tools/call":
                    var toolName = request.Params?["name"]?.ToString();
                    var toolArgs = request.Params?["arguments"] as JObject;
                    return HandleToolCall(request.Id, toolName, toolArgs);

                case "ping":
                    return Protocol.CreateResult(request.Id, new { });

                default:
                    return Protocol.CreateError(request.Id, Constants.ErrorMethodNotFound, $"Method not found: {request.Method}");
            }
        }

        private List<Tool> GetAllTools()
        {
            var tools = GetBuiltInTools();
            tools.AddRange(_customTools);
            return tools;
        }

        private Response HandleToolCall(object id, string toolName, JObject args)
        {
            var result = HandleBuiltInTool(toolName, args);

            if (result == null)
            {
                result = ReflectionToolHelper.InvokeCustomTool(
                    toolName, args, new List<Tool>(_customTools), RunOnMainThread);
            }

            if (result == null)
            {
                return Protocol.CreateError(id, Constants.ErrorInvalidParams, $"Unknown tool: {toolName}");
            }

            return Protocol.CreateToolResult(id, result);
        }

        /// <summary>
        /// Returns the list of built-in tools for this server.
        /// </summary>
        protected abstract List<Tool> GetBuiltInTools();

        /// <summary>
        /// Handles built-in tool calls. Returns null if tool not found.
        /// </summary>
        protected abstract string HandleBuiltInTool(string toolName, JObject args);

        #endregion

        #region Main Thread Execution

        /// <summary>
        /// Returns true if the current thread is the main thread.
        /// Derived classes should override this to provide their own thread checking.
        /// </summary>
        protected virtual bool IsMainThread()
        {
            return _executor?.IsMainThread ?? false;
        }

        /// <summary>
        /// Executes an action on the main thread and returns the result.
        /// </summary>
        protected string RunOnMainThread(Func<string> action)
        {
            return _executor?.Execute(action) ?? "Error: Executor not initialized";
        }

        #endregion

        #region Exception Helpers

        /// <summary>
        /// Checks if an exception indicates that the address/port is already in use.
        /// Handles HttpListenerException, SocketException, and their inner exceptions.
        /// </summary>
        private static bool IsAddressInUseException(Exception e)
        {
            // Error codes for "address already in use"
            // 183: Windows ERROR_ALREADY_EXISTS
            // 48: macOS/Linux EADDRINUSE
            // 10048: Windows WSAEADDRINUSE
            // 98: Linux EADDRINUSE
            int[] addressInUseCodes = { 183, 48, 10048, 98 };

            // Check the exception and all inner exceptions
            Exception current = e;
            while (current != null)
            {
                // Check HttpListenerException
                if (current is HttpListenerException httpEx)
                {
                    foreach (int code in addressInUseCodes)
                    {
                        if (httpEx.ErrorCode == code) return true;
                    }
                }

                // Check SocketException
                if (current is System.Net.Sockets.SocketException socketEx)
                {
                    foreach (int code in addressInUseCodes)
                    {
                        if ((int)socketEx.SocketErrorCode == code || socketEx.ErrorCode == code)
                            return true;
                    }
                    // Also check for AddressAlreadyInUse enum value
                    if (socketEx.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse)
                        return true;
                }

                current = current.InnerException;
            }

            return false;
        }

        #endregion

        #region ViewLog Helper

        /// <summary>
        /// Creates the viewlog tool definition.
        /// </summary>
        protected Tool CreateViewLogTool(string description, bool includeLogFilter = false)
        {
            var filterOptions = includeLogFilter
                ? new[] { LogFilterTypes.All, LogFilterTypes.Error, LogFilterTypes.Warning, LogFilterTypes.Info, LogFilterTypes.Log }
                : new[] { LogFilterTypes.All, LogFilterTypes.Error, LogFilterTypes.Warning, LogFilterTypes.Info };

            return new Tool
            {
                Name = ToolNames.ViewLog,
                Description = description,
                InputSchema = new
                {
                    type = "object",
                    properties = new
                    {
                        lines = new
                        {
                            type = "array",
                            items = new { type = "integer" },
                            description = "[start, end] line numbers (1-indexed, -1 for end). Omit for last 50 lines."
                        },
                        filter = new
                        {
                            type = "string",
                            @enum = filterOptions,
                            description = "Filter by log type (default: all)"
                        }
                    }
                }
            };
        }

        /// <summary>
        /// Processes viewlog output with filtering and formatting.
        /// </summary>
        protected string FormatViewLogOutput(string[] lines, JObject args, string logTitle)
        {
            if (lines == null || lines.Length == 0)
                return "[No logs available]";

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
                startLine = Math.Max(1, lines.Length - (Constants.DefaultLastLogLines - 1));
            }

            int startIdx = Math.Max(0, startLine - 1);
            int endIdx = endLine == -1 ? lines.Length - 1 : Math.Min(lines.Length - 1, endLine - 1);

            if (startIdx > endIdx || startIdx >= lines.Length)
                return $"Invalid line range: [{startLine}, {endLine}]";

            string filter = args?["filter"]?.ToString() ?? LogFilterTypes.All;

            var result = new StringBuilder();
            result.AppendLine($"[{logTitle} - Lines {startIdx + 1} to {endIdx + 1}]");
            result.AppendLine(new string('─', 50));

            for (int i = startIdx; i <= endIdx; i++)
            {
                var line = lines[i];

                if (filter != LogFilterTypes.All)
                {
                    bool include = filter switch
                    {
                        LogFilterTypes.Error => line.Contains("[Error]") || line.Contains("Error") || line.Contains("Exception"),
                        LogFilterTypes.Warning => line.Contains("[Warning]") || line.Contains("Warning"),
                        LogFilterTypes.Log => line.Contains("[Log]"),
                        LogFilterTypes.Info => !line.Contains("[Error]") && !line.Contains("[Warning]") && !line.Contains("Error") && !line.Contains("Warning"),
                        _ => true
                    };

                    if (!include) continue;
                }

                result.AppendLine($"{i + 1}: {line}");
            }

            result.AppendLine(new string('─', 50));
            return result.ToString();
        }

        #endregion
    }
}
