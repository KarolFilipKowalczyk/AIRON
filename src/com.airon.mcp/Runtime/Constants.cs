namespace AIRON.MCP
{
    /// <summary>
    /// Centralized constants for the AIRON MCP package.
    /// Consolidates magic numbers and configuration defaults.
    /// </summary>
    public static class Constants
    {
        #region Ports

        /// <summary>Default port for Editor MCP server.</summary>
        public const int DefaultEditorPort = 3002;

        /// <summary>Default port for Game MCP server.</summary>
        public const int DefaultGamePort = 3003;

        /// <summary>Minimum valid port number.</summary>
        public const int MinPort = 1024;

        /// <summary>Maximum valid port number.</summary>
        public const int MaxPort = 65535;

        /// <summary>Checks if a port number is valid.</summary>
        public static bool IsValidPort(int port) => port >= MinPort && port <= MaxPort;

        #endregion

        #region GameObject Names

        /// <summary>Name of the Game MCP server GameObject.</summary>
        public const string GameServerObjectName = "[AIRON Game MCP]";

        #endregion

        #region Timeouts

        /// <summary>Default timeout for main thread operations in milliseconds.</summary>
        public const int DefaultTimeoutMs = 5000;

        /// <summary>Timeout for thread join operations in milliseconds.</summary>
        public const int ThreadJoinTimeoutMs = 1000;

        /// <summary>Sleep interval for SSE connection loop in milliseconds.</summary>
        public const int SSELoopSleepMs = 100;

        /// <summary>Interval between SSE keepalive messages in seconds.</summary>
        public const int SSEKeepAliveIntervalSeconds = 15;

        /// <summary>Maximum number of retry attempts when starting server with port conflict.</summary>
        public const int ServerStartMaxRetries = 3;

        /// <summary>Delay between server start retry attempts in milliseconds.</summary>
        public const int ServerStartRetryDelayMs = 1000;

        #endregion

        #region Limits

        /// <summary>Maximum number of log lines to keep in buffer.</summary>
        public const int MaxLogLines = 1000;

        /// <summary>Default number of log lines to show when no range specified.</summary>
        public const int DefaultLastLogLines = 50;

        #endregion

        #region JSON-RPC Error Codes

        /// <summary>JSON-RPC error code for method not found.</summary>
        public const int ErrorMethodNotFound = -32601;

        /// <summary>JSON-RPC error code for invalid parameters.</summary>
        public const int ErrorInvalidParams = -32602;

        /// <summary>JSON-RPC error code for internal error.</summary>
        public const int ErrorInternal = -32603;

        #endregion

        #region MCP Protocol

        /// <summary>Current MCP protocol version.</summary>
        public const string ProtocolVersion = "2024-11-05";

        /// <summary>Current server version.</summary>
        public const string ServerVersion = "1.0.0";

        #endregion
    }

    /// <summary>
    /// Constants for built-in MCP tool names.
    /// </summary>
    public static class ToolNames
    {
        public const string Status = "status";
        public const string ViewLog = "viewlog";
        public const string Play = "play";
        public const string Stop = "stop";
        public const string Pause = "pause";
    }

    /// <summary>
    /// Constants for log filter types.
    /// </summary>
    public static class LogFilterTypes
    {
        public const string All = "all";
        public const string Error = "error";
        public const string Warning = "warning";
        public const string Info = "info";
        public const string Log = "log";
    }
}
