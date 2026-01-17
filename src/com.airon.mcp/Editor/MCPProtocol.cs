using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AIRON.MCP
{
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
