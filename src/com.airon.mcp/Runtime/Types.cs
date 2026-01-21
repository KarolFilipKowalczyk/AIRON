using System.Collections.Generic;
using Newtonsoft.Json;

namespace AIRON.MCP
{
    /// <summary>
    /// MCP JSON-RPC request.
    /// </summary>
    public class Request
    {
        [JsonProperty("jsonrpc")] public string JsonRpc { get; set; } = "2.0";
        [JsonProperty("id")] public object Id { get; set; }
        [JsonProperty("method")] public string Method { get; set; }
        [JsonProperty("params")] public Newtonsoft.Json.Linq.JObject Params { get; set; }
    }

    /// <summary>
    /// MCP JSON-RPC response.
    /// </summary>
    public class Response
    {
        [JsonProperty("jsonrpc")] public string JsonRpc { get; set; } = "2.0";
        [JsonProperty("id")] public object Id { get; set; }
        [JsonProperty("result", NullValueHandling = NullValueHandling.Ignore)] public object Result { get; set; }
        [JsonProperty("error", NullValueHandling = NullValueHandling.Ignore)] public Error Error { get; set; }
    }

    /// <summary>
    /// MCP JSON-RPC error.
    /// </summary>
    public class Error
    {
        [JsonProperty("code")] public int Code { get; set; }
        [JsonProperty("message")] public string Message { get; set; }
    }

    /// <summary>
    /// MCP tool definition.
    /// </summary>
    public class Tool
    {
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("description")] public string Description { get; set; }
        [JsonProperty("inputSchema")] public object InputSchema { get; set; }
    }

    /// <summary>
    /// MCP tool result wrapper.
    /// </summary>
    public class ToolResult
    {
        [JsonProperty("content")] public List<Content> Content { get; set; } = new();
    }

    /// <summary>
    /// MCP content item.
    /// </summary>
    public class Content
    {
        [JsonProperty("type")] public string Type { get; set; } = "text";
        [JsonProperty("text")] public string Text { get; set; }
    }

    /// <summary>
    /// MCP protocol helper methods.
    /// </summary>
    public static class Protocol
    {
        public static Response CreateResult(object id, object result)
        {
            return new Response { Id = id, Result = result };
        }

        public static Response CreateError(object id, int code, string message)
        {
            return new Response { Id = id, Error = new Error { Code = code, Message = message } };
        }

        public static Response CreateToolResult(object id, string text)
        {
            return new Response
            {
                Id = id,
                Result = new ToolResult
                {
                    Content = new List<Content> { new() { Text = text } }
                }
            };
        }
    }
}
