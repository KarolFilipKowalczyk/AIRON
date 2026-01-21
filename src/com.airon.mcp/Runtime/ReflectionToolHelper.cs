using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Helper class for reflection-based custom tool handling.
    /// Uses ReflectionCache for improved performance.
    /// </summary>
    public static class ReflectionToolHelper
    {
        /// <summary>
        /// Generates a Tool from a static method using reflection.
        /// </summary>
        /// <param name="toolName">Full method path: Namespace.ClassName.MethodName</param>
        /// <param name="description">Tool description</param>
        /// <returns>Tool or null if method not found</returns>
        public static Tool GenerateToolFromReflection(string toolName, string description)
        {
            var lastDotIndex = toolName.LastIndexOf('.');
            if (lastDotIndex == -1)
            {
                Debug.LogError($"[AIRON] Invalid tool name format: {toolName}. Expected Namespace.ClassName.MethodName");
                return null;
            }

            var cachedMethod = ReflectionCache.GetMethod(toolName);
            if (cachedMethod == null)
            {
                var classPath = toolName.Substring(0, lastDotIndex);
                var methodName = toolName.Substring(lastDotIndex + 1);
                Debug.LogError($"[AIRON] Method not found: {classPath}.{methodName} (ensure it is public and static)");
                return null;
            }

            var properties = new Dictionary<string, object>();
            var required = new List<string>();

            foreach (var param in cachedMethod.Parameters)
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

            return new Tool
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

        /// <summary>
        /// Invokes a custom tool by name using reflection.
        /// </summary>
        /// <param name="toolName">Full method path: Namespace.ClassName.MethodName</param>
        /// <param name="args">JSON arguments</param>
        /// <param name="allowedTools">List of allowed tools for security validation</param>
        /// <param name="mainThreadInvoker">Function to invoke action on main thread</param>
        /// <returns>Result string or null if tool not found/allowed</returns>
        public static string InvokeCustomTool(string toolName, JObject args, List<Tool> allowedTools, Func<Func<string>, string> mainThreadInvoker)
        {
            var allowedTool = allowedTools.FirstOrDefault(t => t.Name == toolName);
            if (allowedTool == null)
                return null;

            var cachedMethod = ReflectionCache.GetMethod(toolName);
            if (cachedMethod == null)
                return null;

            try
            {
                var parameters = cachedMethod.Parameters;
                var paramValues = new object[parameters.Length];

                for (int i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];
                    var argValue = args?[param.Name];

                    if (argValue == null && !param.IsOptional)
                    {
                        return $"Error: Missing required parameter '{param.Name}' (expected {param.ParameterType.Name})";
                    }

                    if (argValue != null)
                    {
                        try
                        {
                            paramValues[i] = argValue.ToObject(param.ParameterType);
                        }
                        catch (Exception conversionEx)
                        {
                            return $"Error: Cannot convert parameter '{param.Name}' to {param.ParameterType.Name}: {conversionEx.Message}";
                        }
                    }
                    else if (param.IsOptional)
                    {
                        paramValues[i] = param.DefaultValue;
                    }
                }

                return mainThreadInvoker(() =>
                {
                    var result = cachedMethod.Method.Invoke(null, paramValues);
                    return result?.ToString() ?? "OK";
                });
            }
            catch (TargetInvocationException tie)
            {
                var innerEx = tie.InnerException ?? tie;
                return $"Error invoking {toolName}: {innerEx.Message}";
            }
            catch (Exception e)
            {
                return $"Error invoking {toolName}: {e.Message}";
            }
        }

        /// <summary>
        /// Preloads tools into the reflection cache.
        /// </summary>
        public static void PreloadTools(IEnumerable<ConfigManager.CustomTool> tools)
        {
            ReflectionCache.Preload(tools);
        }

        /// <summary>
        /// Clears the reflection cache.
        /// </summary>
        public static void ClearCache()
        {
            ReflectionCache.Clear();
        }
    }
}
