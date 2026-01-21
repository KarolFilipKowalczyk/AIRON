using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Represents an active SSE client connection.
    /// </summary>
    public class SSEClient
    {
        public string Id { get; }
        public HttpListenerResponse Response { get; }
        public StreamWriter Writer { get; }
        public DateTime ConnectedAt { get; }
        public bool IsConnected { get; private set; } = true;

        private readonly object _writeLock = new object();

        public SSEClient(string id, HttpListenerResponse response)
        {
            Id = id;
            Response = response;
            ConnectedAt = DateTime.UtcNow;
            Writer = new StreamWriter(response.OutputStream, Encoding.UTF8) { AutoFlush = true };
        }

        /// <summary>
        /// Sends an SSE event to this client.
        /// </summary>
        public bool SendEvent(string eventType, string data, string id = null)
        {
            if (!IsConnected) return false;

            lock (_writeLock)
            {
                try
                {
                    if (!string.IsNullOrEmpty(id))
                        Writer.WriteLine($"id: {id}");
                    if (!string.IsNullOrEmpty(eventType))
                        Writer.WriteLine($"event: {eventType}");

                    var lines = data.Split('\n');
                    foreach (var line in lines)
                    {
                        Writer.WriteLine($"data: {line}");
                    }
                    Writer.WriteLine();
                    return true;
                }
                catch
                {
                    IsConnected = false;
                    return false;
                }
            }
        }

        /// <summary>
        /// Sends a JSON-formatted SSE event.
        /// </summary>
        public bool SendJsonEvent(string eventType, object data, string id = null)
        {
            var json = JsonConvert.SerializeObject(data);
            return SendEvent(eventType, json, id);
        }

        /// <summary>
        /// Sends a keepalive comment to maintain the connection.
        /// </summary>
        public bool SendKeepAlive()
        {
            if (!IsConnected) return false;

            lock (_writeLock)
            {
                try
                {
                    Writer.WriteLine(": keepalive");
                    Writer.WriteLine();
                    return true;
                }
                catch
                {
                    IsConnected = false;
                    return false;
                }
            }
        }

        public void Close()
        {
            IsConnected = false;
            try
            {
                Writer?.Close();
                Response?.Close();
            }
            catch { }
        }
    }

    /// <summary>
    /// Manages SSE client connections and broadcasts.
    /// </summary>
    public class SSEConnectionManager
    {
        private readonly ConcurrentDictionary<string, SSEClient> _clients = new();
        private readonly string _serverName;
        private Timer _keepAliveTimer;
        private int _eventCounter = 0;

        public int ClientCount => _clients.Count;

        public SSEConnectionManager(string serverName)
        {
            _serverName = serverName;
            var interval = TimeSpan.FromSeconds(Constants.SSEKeepAliveIntervalSeconds);
            _keepAliveTimer = new Timer(SendKeepAlives, null, interval, interval);
        }

        /// <summary>
        /// Creates and registers a new SSE client from an HTTP request.
        /// </summary>
        public SSEClient CreateClient(HttpListenerContext context)
        {
            var response = context.Response;

            response.ContentType = "text/event-stream";
            response.Headers.Add("Cache-Control", "no-cache");
            response.Headers.Add("Connection", "keep-alive");
            response.Headers.Add("X-Accel-Buffering", "no");

            var clientId = Guid.NewGuid().ToString("N")[..8];
            var client = new SSEClient(clientId, response);
            _clients[clientId] = client;

            client.SendJsonEvent("connected", new
            {
                clientId = clientId,
                server = _serverName,
                timestamp = DateTime.UtcNow.ToString("o")
            });

            return client;
        }

        /// <summary>
        /// Removes a disconnected client.
        /// </summary>
        public void RemoveClient(string clientId)
        {
            if (_clients.TryRemove(clientId, out var client))
            {
                client.Close();
            }
        }

        /// <summary>
        /// Broadcasts an event to all connected clients.
        /// </summary>
        public void Broadcast(string eventType, object data)
        {
            var eventId = Interlocked.Increment(ref _eventCounter).ToString();
            var json = JsonConvert.SerializeObject(data);
            SendToAllClients(client => client.SendEvent(eventType, json, eventId));
        }

        /// <summary>
        /// Broadcasts an MCP notification to all clients.
        /// </summary>
        public void BroadcastNotification(string method, object @params = null)
        {
            Broadcast("message", new
            {
                jsonrpc = "2.0",
                method = method,
                @params = @params
            });
        }

        private void SendKeepAlives(object state)
        {
            SendToAllClients(client => client.SendKeepAlive());
        }

        /// <summary>
        /// Sends to all clients and removes any that fail.
        /// </summary>
        private void SendToAllClients(Func<SSEClient, bool> sendAction)
        {
            var disconnected = new List<string>();

            foreach (var kvp in _clients)
            {
                if (!sendAction(kvp.Value))
                {
                    disconnected.Add(kvp.Key);
                }
            }

            foreach (var clientId in disconnected)
            {
                RemoveClient(clientId);
            }
        }

        /// <summary>
        /// Closes all connections and stops the keepalive timer.
        /// </summary>
        public void Shutdown()
        {
            _keepAliveTimer?.Dispose();
            _keepAliveTimer = null;

            foreach (var kvp in _clients)
            {
                kvp.Value.Close();
            }
            _clients.Clear();
        }
    }

    /// <summary>
    /// MCP-over-SSE protocol helpers.
    /// </summary>
    public static class OverSSE
    {
        /// <summary>
        /// Formats an MCP request for SSE transmission.
        /// </summary>
        public static string FormatRequest(Request request)
        {
            return JsonConvert.SerializeObject(request);
        }

        /// <summary>
        /// Parses an MCP request from SSE event data.
        /// </summary>
        public static Request ParseRequest(string data)
        {
            return JsonConvert.DeserializeObject<Request>(data);
        }

        /// <summary>
        /// Creates an endpoint event for SSE clients (Streamable HTTP transport).
        /// </summary>
        public static object CreateEndpointInfo(int port)
        {
            return new
            {
                transport = "streamable-http",
                port = port,
                endpoint = "/mcp",
                methods = new[] { "GET", "POST", "DELETE" },
                capabilities = new
                {
                    streaming = true,
                    sessions = true
                }
            };
        }
    }
}
