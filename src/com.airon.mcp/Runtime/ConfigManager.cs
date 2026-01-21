using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Manages AIRON MCP configuration stored in JSON files.
    /// Can be used from both Runtime and Editor contexts.
    /// Settings are stored in the standard Unity package location:
    /// ProjectSettings/Packages/com.airon.mcp/Settings.json
    /// </summary>
    public static class ConfigManager
    {
        private const string CONFIG_DIRECTORY = "ProjectSettings/Packages/com.airon.mcp";
        private const string CONFIG_FILENAME = "Settings.json";

        private static string ConfigFilePath => Path.Combine(CONFIG_DIRECTORY, CONFIG_FILENAME);

        [Serializable]
        public class AironConfig
        {
            public List<CustomTool> editorTools = new List<CustomTool>();
            public List<CustomTool> gameTools = new List<CustomTool>();
            public int editorPort = 3002;
            public int gamePort = 3003;
            public bool editorAutoStart = true;
            public bool gameAutoStart = true;
        }

        [Serializable]
        public class CustomTool
        {
            public string toolName;
            public string description;

            public CustomTool(string toolName, string description)
            {
                this.toolName = toolName;
                this.description = description;
            }
        }

        /// <summary>
        /// Load configuration from file, with fallback to defaults if file doesn't exist.
        /// </summary>
        public static AironConfig LoadConfig()
        {
            // Try to load from file first
            if (File.Exists(ConfigFilePath))
            {
                try
                {
                    string json = File.ReadAllText(ConfigFilePath);
                    var config = JsonUtility.FromJson<AironConfig>(json);

                    if (config != null)
                        return config;
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[AIRON] Failed to load config file: {e.Message}. Using defaults.");
                }
            }

            return GetDefaultConfig();
        }

        /// <summary>
        /// Save configuration to file.
        /// </summary>
        public static void SaveConfig(AironConfig config)
        {
            try
            {
                // Ensure directory exists
                if (!Directory.Exists(CONFIG_DIRECTORY))
                {
                    Directory.CreateDirectory(CONFIG_DIRECTORY);
                }

                // Serialize and save
                string json = JsonUtility.ToJson(config, true);
                File.WriteAllText(ConfigFilePath, json);

                #if UNITY_EDITOR
                UnityEditor.AssetDatabase.Refresh();
                #endif
            }
            catch (Exception e)
            {
                Debug.LogError($"[AIRON] Failed to save config file: {e.Message}");
            }
        }

        /// <summary>
        /// Get default configuration.
        /// </summary>
        private static AironConfig GetDefaultConfig()
        {
            var config = new AironConfig();

            // Default editor tools
            config.editorTools.Add(new CustomTool("AIRON.MCP.Examples.ListScenes", "List all scenes in the project"));
            config.editorTools.Add(new CustomTool("AIRON.MCP.Examples.LoadScene", "Load a scene by name"));

            // Default game tools
            config.gameTools.Add(new CustomTool("AIRON.MCP.RuntimeExamples.GetLoadedScenes", "Get all loaded scenes"));
            config.gameTools.Add(new CustomTool("AIRON.MCP.RuntimeExamples.SwitchScene", "Switch to a scene by name"));

            return config;
        }

        #if UNITY_EDITOR
        /// <summary>
        /// Delete the configuration file.
        /// </summary>
        public static void DeleteConfigFile()
        {
            if (File.Exists(ConfigFilePath))
            {
                File.Delete(ConfigFilePath);
                UnityEditor.AssetDatabase.Refresh();
            }
        }

        /// <summary>
        /// Get the full path to the configuration file.
        /// </summary>
        public static string GetConfigFilePath()
        {
            return Path.GetFullPath(ConfigFilePath);
        }
        #endif

        /// <summary>
        /// Check if configuration file exists.
        /// </summary>
        public static bool ConfigFileExists()
        {
            return File.Exists(ConfigFilePath);
        }
    }
}
