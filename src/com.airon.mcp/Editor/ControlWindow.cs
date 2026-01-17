using UnityEditor;
using UnityEngine;

namespace AIRON.MCP
{
    public class ControlWindow : EditorWindow
    {
        private const string EDITOR_AUTOSTART_KEY = "AIRON_EditorMCP_AutoStart";
        private const string GAME_AUTOSTART_KEY = "AIRON_GameMCP_AutoStart";
        private const string EDITOR_CUSTOM_TOOLS_KEY = "AIRON_EditorMCP_CustomTools";
        private const string EDITOR_CUSTOM_TOOLS_INITIALIZED_KEY = "AIRON_EditorMCP_CustomTools_Initialized";
        private const string GAME_CUSTOM_TOOLS_KEY = "AIRON_GameMCP_CustomTools";
        private const string GAME_CUSTOM_TOOLS_INITIALIZED_KEY = "AIRON_GameMCP_CustomTools_Initialized";
        
        private Vector2 scrollPosition;
        private bool showCustomTools = false;
        private bool showGameCustomTools = false;
        
        private static string pendingSecret = null;
        private static double secretChangeTime = 0;
        private const double SECRET_RESTART_DELAY = 1.0; // 1 second delay
        
        [MenuItem("Window/AIRON Control/Open Window")]
        public static void ShowWindow()
        {
            var window = GetWindow<ControlWindow>("AIRON Control");
            window.minSize = new Vector2(400, 300);
        }
        
        [MenuItem("Window/AIRON Control/Reset Editor MCP Custom Tools")]
        public static void ResetEditorCustomTools()
        {
            EditorPrefs.DeleteKey(EDITOR_CUSTOM_TOOLS_KEY);
            EditorPrefs.DeleteKey(EDITOR_CUSTOM_TOOLS_INITIALIZED_KEY);
            
            // Restart server to reload defaults
            if (EditorMCPServer.IsRunning())
            {
                EditorMCPServer.Stop();
                EditorMCPServer.Start();
            }
        }
        
        [MenuItem("Window/AIRON Control/Reset Game MCP Custom Tools")]
        public static void ResetGameCustomTools()
        {
            EditorPrefs.DeleteKey(GAME_CUSTOM_TOOLS_KEY);
            EditorPrefs.DeleteKey(GAME_CUSTOM_TOOLS_INITIALIZED_KEY);
        }

        private void OnGUI()
        {
            scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);
            
            // Header
            GUILayout.Space(10);
            GUILayout.Label("AIRON MCP Server Control", EditorStyles.boldLabel);
            GUILayout.Space(10);
            
            EditorGUILayout.HelpBox(
                "Monitor and configure MCP servers for Claude Code integration. " +
                "These servers enable remote Unity Editor control.",
                MessageType.Info
            );
            
            GUILayout.Space(10);
            
            // Editor MCP Server Section
            DrawEditorMCPSection();
            
            GUILayout.Space(20);
            
            // Game MCP Server Section
            DrawGameMCPSection();
            
            GUILayout.Space(20);
            
            // Authentication section at the bottom
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);
            GUILayout.Label("🔒 Authentication (Optional)", EditorStyles.boldLabel);
            GUILayout.Space(5);
            
            EditorGUILayout.HelpBox(
                "Set a secret token to secure MCP server access.\n" +
                "Leave empty to allow unauthenticated localhost access (suitable for Claude Code).",
                MessageType.Info
            );
            
            string currentSecret = EditorPrefs.GetString("AIRON_EditorMCP_Secret", "");
            string newSecret = EditorGUILayout.PasswordField("Secret Token (optional):", currentSecret);
            
            if (newSecret != currentSecret)
            {
                EditorPrefs.SetString("AIRON_EditorMCP_Secret", newSecret);
                
                // Schedule delayed restart
                pendingSecret = newSecret;
                secretChangeTime = EditorApplication.timeSinceStartup;
            }
            
            if (string.IsNullOrEmpty(currentSecret))
            {
                EditorGUILayout.HelpBox(
                    "ℹ️ Servers running without authentication. Recommended to set a secret for airon.js connections.",
                    MessageType.Info
                );
            }
            
            EditorGUILayout.EndVertical();
            
            EditorGUILayout.EndScrollView();
        }

        private void DrawEditorMCPSection()
        {
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);
            
            int currentPort = EditorPrefs.GetInt("AIRON_EditorMCP_Port", 3002);
            GUILayout.Label($"Editor MCP Server (Port {currentPort})", EditorStyles.boldLabel);
            GUILayout.Space(5);
            
            bool isRunning = EditorMCPServer.IsRunning();
            
            // Status indicator
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Status:", GUILayout.Width(80));
            
            var oldColor = GUI.color;
            GUI.color = isRunning ? Color.green : Color.red;
            GUILayout.Label(isRunning ? "● Running" : "● Stopped", EditorStyles.boldLabel);
            GUI.color = oldColor;
            
            EditorGUILayout.EndHorizontal();
            
            GUILayout.Space(10);
            
            // Port configuration
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Port:", GUILayout.Width(80));
            int newPort = EditorGUILayout.IntField(currentPort, GUILayout.Width(80));
            EditorGUILayout.EndHorizontal();
            
            if (newPort != currentPort && newPort >= 1024 && newPort <= 65535)
            {
                EditorPrefs.SetInt("AIRON_EditorMCP_Port", newPort);
                
                // Restart server if running
                if (isRunning)
                {
                    EditorMCPServer.Stop();
                    EditorMCPServer.Start();
                }
            }
            
            GUILayout.Space(10);
            
            // Auto-start toggle (now always enabled)
            bool autoStart = EditorPrefs.GetBool(EDITOR_AUTOSTART_KEY, true);
            bool newAutoStart = EditorGUILayout.Toggle("Enable Auto-Start", autoStart);
            
            if (newAutoStart != autoStart)
            {
                EditorPrefs.SetBool(EDITOR_AUTOSTART_KEY, newAutoStart);
                
                if (newAutoStart && !isRunning)
                {
                    EditorMCPServer.Start();
                }
                else if (!newAutoStart && isRunning)
                {
                    EditorMCPServer.Stop();
                }
            }
            
            GUILayout.Space(5);
            
            EditorGUILayout.HelpBox(
                "Editor MCP provides tools for Unity Editor control:\n" +
                "• Play/Stop/Pause control\n" +
                "• AssetDatabase refresh\n" +
                "• Editor status queries",
                MessageType.None
            );
            
            GUILayout.Space(10);
            
            // Custom Tools Section
            showCustomTools = EditorGUILayout.Foldout(showCustomTools, "Custom Tools", true);
            if (showCustomTools)
            {
                DrawCustomToolsEditor();
            }
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawCustomToolsEditor()
        {
            EditorGUI.indentLevel++;
            
            bool isInitialized = EditorPrefs.GetBool(EDITOR_CUSTOM_TOOLS_INITIALIZED_KEY, false);
            var customToolsJson = EditorPrefs.GetString(EDITOR_CUSTOM_TOOLS_KEY, "");
            
            // If never initialized, load defaults
            if (!isInitialized)
            {
                var defaultTools = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>
                {
                    new() { { "toolName", "AIRON.MCP.Examples.ListScenes" }, { "description", "List all scenes in the project" } },
                    new() { { "toolName", "AIRON.MCP.Examples.LoadScene" }, { "description", "Load a scene by name" } }
                };
                customToolsJson = Newtonsoft.Json.JsonConvert.SerializeObject(defaultTools);
                EditorPrefs.SetString(EDITOR_CUSTOM_TOOLS_KEY, customToolsJson);
                EditorPrefs.SetBool(EDITOR_CUSTOM_TOOLS_INITIALIZED_KEY, true);
            }
            
            var toolList = Newtonsoft.Json.JsonConvert.DeserializeObject<System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>>(customToolsJson);
            
            if (toolList == null)
                toolList = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>();
            
            bool modified = false;
            
            // Display and edit existing tools
            for (int i = 0; i < toolList.Count; i++)
            {
                EditorGUILayout.BeginVertical(EditorStyles.helpBox);
                
                var tool = toolList[i];
                var toolName = tool.ContainsKey("toolName") ? tool["toolName"] : "";
                var description = tool.ContainsKey("description") ? tool["description"] : "";
                
                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField($"Tool {i + 1}", EditorStyles.boldLabel, GUILayout.Width(60));
                if (GUILayout.Button("Delete", GUILayout.Width(60)))
                {
                    toolList.RemoveAt(i);
                    modified = true;
                    EditorGUILayout.EndHorizontal();
                    EditorGUILayout.EndVertical();
                    break;
                }
                EditorGUILayout.EndHorizontal();
                
                var newToolName = EditorGUILayout.TextField("Tool Name", toolName);
                var newDescription = EditorGUILayout.TextField("Description", description);
                
                if (newToolName != toolName || newDescription != description)
                {
                    tool["toolName"] = newToolName;
                    tool["description"] = newDescription;
                    modified = true;
                }
                
                EditorGUILayout.EndVertical();
                GUILayout.Space(5);
            }
            
            GUILayout.Space(10);
            
            // Add new tool button
            if (GUILayout.Button("+ Add New Tool", GUILayout.Height(30)))
            {
                var newTool = new System.Collections.Generic.Dictionary<string, string>
                {
                    { "toolName", "" },
                    { "description", "" }
                };
                toolList.Add(newTool);
                modified = true;
            }
            
            GUILayout.Space(5);
            
            EditorGUILayout.HelpBox(
                "Format: Namespace.ClassName.MethodName\n" +
                "Example: AIRON.MCP.Examples.ListScenes\n\n" +
                "The method must be public and static.",
                MessageType.Info
            );
            
            // Save if modified
            if (modified)
            {
                SaveCustomTools(toolList);
                
                // Restart server to pick up changes
                EditorMCPServer.Stop();
                EditorMCPServer.Start();
            }
            
            EditorGUI.indentLevel--;
        }
        
        private void SaveCustomTools(System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>> toolList)
        {
            var json = Newtonsoft.Json.JsonConvert.SerializeObject(toolList);
            EditorPrefs.SetString(EDITOR_CUSTOM_TOOLS_KEY, json);
        }

        private void DrawGameMCPSection()
        {
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);
            
            int currentPort = EditorPrefs.GetInt("AIRON_GameMCP_Port", 3003);
            GUILayout.Label($"Game MCP Server (Port {currentPort})", EditorStyles.boldLabel);
            GUILayout.Space(5);
            
            bool isInPlayMode = EditorApplication.isPlaying;
            bool gameServerExists = FindGameMCPServer();
            bool autoStart = EditorPrefs.GetBool(GAME_AUTOSTART_KEY, true);
            
            // Status indicator
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Status:", GUILayout.Width(80));
            
            var oldColor = GUI.color;
            
            if (!autoStart)
            {
                // Always show disabled if auto-start is off
                GUI.color = Color.red;
                GUILayout.Label("● Disabled", EditorStyles.boldLabel);
            }
            else if (isInPlayMode && gameServerExists)
            {
                GUI.color = Color.green;
                GUILayout.Label("● Running", EditorStyles.boldLabel);
            }
            else if (isInPlayMode && !gameServerExists)
            {
                GUI.color = Color.yellow;
                GUILayout.Label("● Starting...", EditorStyles.boldLabel);
            }
            else
            {
                GUI.color = Color.gray;
                GUILayout.Label("● Waiting for Play Mode", EditorStyles.boldLabel);
            }
            
            GUI.color = oldColor;
            
            EditorGUILayout.EndHorizontal();
            
            GUILayout.Space(10);
            
            // Port configuration
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Port:", GUILayout.Width(80));
            int newPort = EditorGUILayout.IntField(currentPort, GUILayout.Width(80));
            EditorGUILayout.EndHorizontal();
            
            if (newPort != currentPort && newPort >= 1024 && newPort <= 65535)
            {
                EditorPrefs.SetInt("AIRON_GameMCP_Port", newPort);
                
                // Note: Server will use new port on next Play Mode entry
                if (isInPlayMode && gameServerExists)
                {
                    EditorGUILayout.HelpBox(
                        "Port will change on next Play Mode entry. Exit and re-enter Play Mode to apply.",
                        MessageType.Info
                    );
                }
            }
            
            GUILayout.Space(10);
            
            // Auto-start toggle
            bool newAutoStart = EditorGUILayout.Toggle("Enable Auto-Start", autoStart);
            
            if (newAutoStart != autoStart)
            {
                EditorPrefs.SetBool(GAME_AUTOSTART_KEY, newAutoStart);
            }
            
            GUILayout.Space(5);
            
            if (!autoStart)
            {
                EditorGUILayout.HelpBox(
                    "Game MCP Server auto-start is disabled. Enable it to allow Lua script execution in Play Mode.",
                    MessageType.Warning
                );
            }
            else if (!isInPlayMode)
            {
                EditorGUILayout.HelpBox(
                    "Game MCP Server will start automatically when entering Play Mode.",
                    MessageType.Info
                );
            }
            
            GUILayout.Space(5);
            
            EditorGUILayout.HelpBox(
                "Game MCP provides tools for runtime control:\n" +
                "• Lua script execution\n" +
                "• Game status queries\n" +
                "• Scene information",
                MessageType.None
            );
            
            GUILayout.Space(10);
            
            // Custom Tools Section
            showGameCustomTools = EditorGUILayout.Foldout(showGameCustomTools, "Custom Tools", true);
            if (showGameCustomTools)
            {
                DrawGameCustomToolsEditor();
            }
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawGameCustomToolsEditor()
        {
            EditorGUI.indentLevel++;
            
            bool isInitialized = EditorPrefs.GetBool(GAME_CUSTOM_TOOLS_INITIALIZED_KEY, false);
            var customToolsJson = EditorPrefs.GetString(GAME_CUSTOM_TOOLS_KEY, "");
            
            // If never initialized, load defaults
            if (!isInitialized)
            {
                var defaultTools = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>
                {
                    new() { { "toolName", "AIRON.MCP.RuntimeExamples.GetLoadedScenes" }, { "description", "Get all loaded scenes" } },
                    new() { { "toolName", "AIRON.MCP.RuntimeExamples.SwitchScene" }, { "description", "Switch to a scene by name" } }
                };
                customToolsJson = Newtonsoft.Json.JsonConvert.SerializeObject(defaultTools);
                EditorPrefs.SetString(GAME_CUSTOM_TOOLS_KEY, customToolsJson);
                EditorPrefs.SetBool(GAME_CUSTOM_TOOLS_INITIALIZED_KEY, true);
            }
            
            var toolList = Newtonsoft.Json.JsonConvert.DeserializeObject<System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>>(customToolsJson);
            
            if (toolList == null)
                toolList = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>();
            
            bool modified = false;
            
            // Display and edit existing tools
            for (int i = 0; i < toolList.Count; i++)
            {
                EditorGUILayout.BeginVertical(EditorStyles.helpBox);
                
                var tool = toolList[i];
                var toolName = tool.ContainsKey("toolName") ? tool["toolName"] : "";
                var description = tool.ContainsKey("description") ? tool["description"] : "";
                
                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField($"Tool {i + 1}", EditorStyles.boldLabel, GUILayout.Width(60));
                if (GUILayout.Button("Delete", GUILayout.Width(60)))
                {
                    toolList.RemoveAt(i);
                    modified = true;
                    EditorGUILayout.EndHorizontal();
                    EditorGUILayout.EndVertical();
                    break;
                }
                EditorGUILayout.EndHorizontal();
                
                var newToolName = EditorGUILayout.TextField("Tool Name", toolName);
                var newDescription = EditorGUILayout.TextField("Description", description);
                
                if (newToolName != toolName || newDescription != description)
                {
                    tool["toolName"] = newToolName;
                    tool["description"] = newDescription;
                    modified = true;
                }
                
                EditorGUILayout.EndVertical();
                GUILayout.Space(5);
            }
            
            GUILayout.Space(10);
            
            // Add new tool button
            if (GUILayout.Button("+ Add New Tool", GUILayout.Height(30)))
            {
                var newTool = new System.Collections.Generic.Dictionary<string, string>
                {
                    { "toolName", "" },
                    { "description", "" }
                };
                toolList.Add(newTool);
                modified = true;
            }
            
            GUILayout.Space(5);
            
            EditorGUILayout.HelpBox(
                "Format: Namespace.ClassName.MethodName\n" +
                "Example: AIRON.MCP.RuntimeExamples.GetCurrentScene\n\n" +
                "The method must be public and static.\n" +
                "Note: Changes apply when entering Play Mode.",
                MessageType.Info
            );
            
            // Save if modified
            if (modified)
            {
                SaveGameCustomTools(toolList);
            }
            
            EditorGUI.indentLevel--;
        }
        
        private void SaveGameCustomTools(System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>> toolList)
        {
            var json = Newtonsoft.Json.JsonConvert.SerializeObject(toolList);
            EditorPrefs.SetString(GAME_CUSTOM_TOOLS_KEY, json);
        }

        private bool FindGameMCPServer()
        {
            // GameMCPServer is in Runtime assembly, check if it exists by looking for the GameObject
            var gameObject = GameObject.Find("[AIRON Game MCP]");
            return gameObject != null && gameObject.GetComponent<MonoBehaviour>() != null;
        }
        
        private void Update()
        {
            // Trigger auto-start if enabled but server not running
            bool autoStart = EditorPrefs.GetBool(EDITOR_AUTOSTART_KEY, true);
            bool isRunning = EditorMCPServer.IsRunning();
            
            if (autoStart && !isRunning && pendingSecret == null)
            {
                EditorMCPServer.Start();
            }
            
            // Handle delayed server restart after secret change
            if (pendingSecret != null && 
                EditorApplication.timeSinceStartup - secretChangeTime > SECRET_RESTART_DELAY)
            {
                bool wasRunning = EditorMCPServer.IsRunning();
                
                if (wasRunning)
                {
                    EditorMCPServer.Stop();
                }
                
                if (autoStart)
                {
                    EditorMCPServer.Start();
                }
                
                pendingSecret = null;
            }
        }

        private void OnInspectorUpdate()
        {
            // Auto-refresh every frame
            Repaint();
        }
    }
}
