using System;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Log levels for structured logging.
    /// </summary>
    public enum LogLevel
    {
        Debug = 0,
        Info = 1,
        Warning = 2,
        Error = 3
    }

    /// <summary>
    /// Structured logging for AIRON MCP package.
    /// Provides consistent log formatting and level filtering.
    /// </summary>
    public static class Logger
    {
        private const string LogPrefix = "[AIRON]";

        /// <summary>
        /// Minimum log level to output. Messages below this level are ignored.
        /// Default is Info in release builds, Debug in development.
        /// </summary>
        public static LogLevel MinLevel { get; set; } =
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            LogLevel.Debug;
#else
            LogLevel.Info;
#endif

        /// <summary>
        /// Whether to include timestamps in log messages.
        /// </summary>
        public static bool IncludeTimestamp { get; set; } = false;

        /// <summary>
        /// Logs a message at the specified level.
        /// </summary>
        /// <param name="level">The log level</param>
        /// <param name="message">The message to log</param>
        /// <param name="context">Optional Unity context object</param>
        public static void Log(LogLevel level, string message, UnityEngine.Object context = null)
        {
            if (level < MinLevel)
                return;

            string formattedMessage = FormatMessage(level, message);

            switch (level)
            {
                case LogLevel.Debug:
                case LogLevel.Info:
                    if (context != null)
                        Debug.Log(formattedMessage, context);
                    else
                        Debug.Log(formattedMessage);
                    break;

                case LogLevel.Warning:
                    if (context != null)
                        Debug.LogWarning(formattedMessage, context);
                    else
                        Debug.LogWarning(formattedMessage);
                    break;

                case LogLevel.Error:
                    if (context != null)
                        Debug.LogError(formattedMessage, context);
                    else
                        Debug.LogError(formattedMessage);
                    break;
            }
        }

        /// <summary>
        /// Logs a debug message.
        /// </summary>
        public static void LogDebug(string message, UnityEngine.Object context = null)
        {
            Log(LogLevel.Debug, message, context);
        }

        /// <summary>
        /// Logs an info message.
        /// </summary>
        public static void LogInfo(string message, UnityEngine.Object context = null)
        {
            Log(LogLevel.Info, message, context);
        }

        /// <summary>
        /// Logs a warning message.
        /// </summary>
        public static void LogWarning(string message, UnityEngine.Object context = null)
        {
            Log(LogLevel.Warning, message, context);
        }

        /// <summary>
        /// Logs an error message.
        /// </summary>
        public static void LogError(string message, UnityEngine.Object context = null)
        {
            Log(LogLevel.Error, message, context);
        }

        /// <summary>
        /// Logs an exception with optional context message.
        /// </summary>
        public static void LogException(Exception exception, string contextMessage = null, UnityEngine.Object context = null)
        {
            string message = string.IsNullOrEmpty(contextMessage)
                ? $"Exception: {exception.Message}"
                : $"{contextMessage}: {exception.Message}";

            Log(LogLevel.Error, message, context);

            // Also log the full exception for stack trace
            if (exception != null)
            {
                Debug.LogException(exception, context);
            }
        }

        /// <summary>
        /// Logs a message with the server context.
        /// </summary>
        public static void LogServer(LogLevel level, string serverName, string message)
        {
            Log(level, $"{serverName} {message}");
        }

        /// <summary>
        /// Logs a tool invocation.
        /// </summary>
        public static void LogToolInvocation(string serverName, string toolName, bool success, string details = null)
        {
            string status = success ? "OK" : "FAILED";
            string message = string.IsNullOrEmpty(details)
                ? $"{serverName} tool '{toolName}' - {status}"
                : $"{serverName} tool '{toolName}' - {status}: {details}";

            Log(success ? LogLevel.Debug : LogLevel.Warning, message);
        }

        /// <summary>
        /// Logs a connection event.
        /// </summary>
        public static void LogConnection(string serverName, string clientId, bool connected, int totalClients)
        {
            string action = connected ? "connected" : "disconnected";
            string countInfo = connected ? $"total: {totalClients}" : $"remaining: {totalClients}";
            Log(LogLevel.Info, $"{serverName} SSE client {action}: {clientId} ({countInfo})");
        }

        /// <summary>
        /// Logs a server lifecycle event.
        /// </summary>
        public static void LogServerEvent(string serverName, string eventType, int port = 0, string protocol = null)
        {
            string message = eventType switch
            {
                "started" => $"{serverName} MCP server started on port {port}" +
                            (string.IsNullOrEmpty(protocol) ? "" : $" ({protocol})"),
                "stopped" => $"{serverName} MCP server stopped",
                "error" => $"Failed to start {serverName} MCP server",
                _ => $"{serverName} {eventType}"
            };

            Log(eventType == "error" ? LogLevel.Error : LogLevel.Info, message);
        }

        /// <summary>
        /// Formats a log message with prefix and optional timestamp.
        /// </summary>
        private static string FormatMessage(LogLevel level, string message)
        {
            if (IncludeTimestamp)
            {
                string timestamp = DateTime.Now.ToString("HH:mm:ss.fff");
                return $"{LogPrefix} [{timestamp}] {message}";
            }

            return $"{LogPrefix} {message}";
        }

        /// <summary>
        /// Creates a scoped logger for a specific server context.
        /// </summary>
        public static ScopedLogger CreateScoped(string serverName)
        {
            return new ScopedLogger(serverName);
        }
    }

    /// <summary>
    /// Scoped logger for a specific server context.
    /// Provides convenience methods that automatically include the server name.
    /// </summary>
    public class ScopedLogger
    {
        private readonly string _serverName;

        public ScopedLogger(string serverName)
        {
            _serverName = serverName;
        }

        public void Debug(string message) => Logger.LogServer(LogLevel.Debug, _serverName, message);
        public void Info(string message) => Logger.LogServer(LogLevel.Info, _serverName, message);
        public void Warning(string message) => Logger.LogServer(LogLevel.Warning, _serverName, message);
        public void Error(string message) => Logger.LogServer(LogLevel.Error, _serverName, message);

        public void ToolInvocation(string toolName, bool success, string details = null)
            => Logger.LogToolInvocation(_serverName, toolName, success, details);

        public void Connection(string clientId, bool connected, int totalClients)
            => Logger.LogConnection(_serverName, clientId, connected, totalClients);

        public void ServerStarted(int port, string protocol)
            => Logger.LogServerEvent(_serverName, "started", port, protocol);

        public void ServerStopped()
            => Logger.LogServerEvent(_serverName, "stopped");

        public void ServerError(string details)
            => Logger.Log(LogLevel.Error, $"Failed to start {_serverName} MCP server: {details}");
    }
}
