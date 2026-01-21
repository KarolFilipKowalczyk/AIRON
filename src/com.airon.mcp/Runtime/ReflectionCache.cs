using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Caches reflection lookups for improved performance.
    /// Eliminates repeated assembly scanning on every custom tool call.
    /// Thread-safe using ConcurrentDictionary.
    /// </summary>
    public static class ReflectionCache
    {
        /// <summary>
        /// Cached method info including parameter details.
        /// </summary>
        public class CachedMethodInfo
        {
            public MethodInfo Method { get; set; }
            public ParameterInfo[] Parameters { get; set; }
            public Type DeclaringType { get; set; }
        }

        // Cache for method lookups by full tool name (Namespace.Class.Method)
        private static readonly ConcurrentDictionary<string, CachedMethodInfo> _methodCache = new();

        // Cache for type lookups by class path (Namespace.Class)
        private static readonly ConcurrentDictionary<string, Type> _typeCache = new();

        /// <summary>
        /// Gets a cached method by tool name. Returns null if not found.
        /// </summary>
        /// <param name="toolName">Full method path: Namespace.ClassName.MethodName</param>
        public static CachedMethodInfo GetMethod(string toolName)
        {
            if (string.IsNullOrEmpty(toolName))
                return null;

            // Check cache first
            if (_methodCache.TryGetValue(toolName, out var cached))
                return cached;

            // Parse tool name
            var lastDotIndex = toolName.LastIndexOf('.');
            if (lastDotIndex == -1)
                return null;

            var classPath = toolName.Substring(0, lastDotIndex);
            var methodName = toolName.Substring(lastDotIndex + 1);

            // Get the type
            var type = GetType(classPath);
            if (type == null)
                return null;

            // Get the method
            var method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static);
            if (method == null)
                return null;

            // Create and cache the method info
            var methodInfo = new CachedMethodInfo
            {
                Method = method,
                Parameters = method.GetParameters(),
                DeclaringType = type
            };

            _methodCache[toolName] = methodInfo;
            return methodInfo;
        }

        /// <summary>
        /// Gets a cached type by class path. Returns null if not found.
        /// </summary>
        /// <param name="classPath">Full class path: Namespace.ClassName</param>
        public static Type GetType(string classPath)
        {
            if (string.IsNullOrEmpty(classPath))
                return null;

            // Check cache first
            if (_typeCache.TryGetValue(classPath, out var cached))
                return cached;

            // Search all assemblies for the type
            var type = AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(a =>
                {
                    try
                    {
                        return a.GetExportedTypes();
                    }
                    catch
                    {
                        // Some assemblies may throw on GetExportedTypes
                        return Array.Empty<Type>();
                    }
                })
                .FirstOrDefault(t => t.FullName == classPath || t.Name == classPath);

            if (type != null)
            {
                _typeCache[classPath] = type;
            }

            return type;
        }

        /// <summary>
        /// Preloads method info for a list of tool names.
        /// Call this at startup to warm the cache.
        /// </summary>
        /// <param name="toolNames">Collection of tool names to preload</param>
        public static void Preload(IEnumerable<string> toolNames)
        {
            if (toolNames == null)
                return;

            foreach (var toolName in toolNames)
            {
                if (!string.IsNullOrEmpty(toolName))
                {
                    GetMethod(toolName);
                }
            }
        }

        /// <summary>
        /// Preloads method info from a list of custom tools.
        /// </summary>
        /// <param name="tools">Collection of custom tools to preload</param>
        public static void Preload(IEnumerable<ConfigManager.CustomTool> tools)
        {
            if (tools == null)
                return;

            Preload(tools.Select(t => t.toolName));
        }

        /// <summary>
        /// Clears all cached data.
        /// Call this when assemblies are reloaded.
        /// </summary>
        public static void Clear()
        {
            _methodCache.Clear();
            _typeCache.Clear();
        }
    }
}
