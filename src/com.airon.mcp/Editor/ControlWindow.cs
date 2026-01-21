using UnityEditor;
using UnityEngine;

namespace AIRON.MCP
{
    public class ControlWindow : EditorWindow
    {
        private Vector2 scrollPosition;
        private bool showCustomTools = false;
        private bool showGameCustomTools = false;

        private ConfigManager.AironConfig config;
        private bool configLoaded = false;
        
        [MenuItem("Window/AIRON Control/Open Window", false, 1)]
        public static void ShowWindow()
        {
            var window = GetWindow<ControlWindow>("AIRON Control");
            window.minSize = new Vector2(400, 300);
        }

        [MenuItem("Window/AIRON Control/Open Config File", false, 2)]
        public static void OpenConfigFile()
        {
            string configPath = ConfigManager.GetConfigFilePath();

            if (!ConfigManager.ConfigFileExists())
            {
                if (EditorUtility.DisplayDialog(
                    "Config File Not Found",
                    "Configuration file doesn't exist yet. Would you like to create it?",
                    "Create", "Cancel"))
                {
                    var config = ConfigManager.LoadConfig();
                    ConfigManager.SaveConfig(config);
                }
                else
                {
                    return;
                }
            }

            EditorUtility.RevealInFinder(configPath);
        }

        [MenuItem("Window/AIRON Control/Reset to Examples", false, 3)]
        public static void ResetToExamples()
        {
            if (!EditorUtility.DisplayDialog(
                "Reset Configuration",
                "This will delete the configuration file and reset all AIRON settings to example defaults.\n\nContinue?",
                "Reset", "Cancel"))
            {
                return;
            }

            ConfigManager.DeleteConfigFile();

            // Restart server to reload defaults
            if (ServerEditor.IsRunning())
            {
                ServerEditor.Stop();
                ServerEditor.Start();
            }

            // Force reload in any open window
            var window = GetWindow<ControlWindow>(false, null, false);
            if (window)
            {
                window.configLoaded = false;
                window.Repaint();
            }

            EditorUtility.DisplayDialog("Reset Complete", "AIRON configuration has been reset to examples.", "OK");
        }

        private void OnGUI()
        {
            // Load config if not loaded
            if (!configLoaded || config == null)
            {
                config = ConfigManager.LoadConfig();
                configLoaded = true;
            }

            scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);

            // Header
            GUILayout.Space(10);
            GUILayout.Label("AIRON MCP Server Control", EditorStyles.boldLabel);
            GUILayout.Space(10);

            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Open README", GUILayout.Height(24)))
            {
                string readmePath = System.IO.Path.GetFullPath("Packages/com.airon.mcp/README.md");
                EditorUtility.RevealInFinder(readmePath);
            }
            if (GUILayout.Button("Open Config", GUILayout.Height(24)))
            {
                OpenConfigFile();
            }
            EditorGUILayout.EndHorizontal();

            GUILayout.Space(10);
            
            // Editor MCP Server Section
            DrawEditorMCPSection();
            
            GUILayout.Space(20);
            
            // Game MCP Server Section
            DrawGameMCPSection();
            
            EditorGUILayout.EndScrollView();
        }

        private void DrawEditorMCPSection()
        {
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);

            bool isRunning = ServerEditor.IsRunning();

            // Title + Status on same line
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Editor MCP Server", EditorStyles.boldLabel);
            var oldColor = UnityEngine.GUI.color;
            UnityEngine.GUI.color = isRunning ? Color.green : Color.red;
            GUILayout.Label(isRunning ? "● Running" : "● Stopped", EditorStyles.boldLabel);
            UnityEngine.GUI.color = oldColor;
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();

            GUILayout.Space(5);

            // Port + Enabled on same line
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Port:", GUILayout.Width(35));
            int newPort = EditorGUILayout.IntField(config.editorPort, GUILayout.Width(60));
            GUILayout.Space(20);
            GUILayout.Label("Enabled:", GUILayout.Width(55));
            bool newAutoStart = EditorGUILayout.Toggle(config.editorAutoStart, GUILayout.Width(20));
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();

            if (newPort != config.editorPort && Constants.IsValidPort(newPort))
            {
                config.editorPort = newPort;
                ConfigManager.SaveConfig(config);

                // Restart server if running
                if (isRunning)
                {
                    ServerEditor.Stop();
                    ServerEditor.Start();
                }
            }

            if (newAutoStart != config.editorAutoStart)
            {
                config.editorAutoStart = newAutoStart;
                ConfigManager.SaveConfig(config);

                if (newAutoStart && !isRunning)
                {
                    ServerEditor.Start();
                }
                else if (!newAutoStart && isRunning)
                {
                    ServerEditor.Stop();
                }
            }

            GUILayout.Space(5);

            EditorGUILayout.HelpBox(
                "Tools: Status, Play, Stop, Pause + custom",
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
            DrawToolsEditor(
                config.editorTools,
                "AIRON.MCP.Examples.ListScenes",
                null, // No additional note for editor tools
                () =>
                {
                    // Restart editor server to pick up changes
                    ServerEditor.Stop();
                    ServerEditor.Start();
                }
            );
        }

        /// <summary>
        /// Generic method to draw a custom tools editor UI.
        /// </summary>
        /// <param name="tools">The list of tools to edit</param>
        /// <param name="exampleToolName">Example tool name to show in help box</param>
        /// <param name="additionalNote">Additional note to append to help text (optional)</param>
        /// <param name="onModified">Action to call when tools are modified (optional)</param>
        private void DrawToolsEditor(
            System.Collections.Generic.List<ConfigManager.CustomTool> tools,
            string exampleToolName,
            string additionalNote,
            System.Action onModified)
        {
            EditorGUI.indentLevel++;

            bool modified = false;

            // Display and edit existing tools
            for (int i = 0; i < tools.Count; i++)
            {
                EditorGUILayout.BeginVertical(EditorStyles.helpBox);

                var tool = tools[i];

                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField($"Tool {i + 1}", EditorStyles.boldLabel, GUILayout.Width(60));
                if (GUILayout.Button("Delete", GUILayout.Width(60)))
                {
                    tools.RemoveAt(i);
                    modified = true;
                    EditorGUILayout.EndHorizontal();
                    EditorGUILayout.EndVertical();
                    break;
                }
                EditorGUILayout.EndHorizontal();

                var newToolName = EditorGUILayout.TextField("Tool Name", tool.toolName);
                var newDescription = EditorGUILayout.TextField("Description", tool.description);

                if (newToolName != tool.toolName || newDescription != tool.description)
                {
                    tool.toolName = newToolName;
                    tool.description = newDescription;
                    modified = true;
                }

                EditorGUILayout.EndVertical();
                GUILayout.Space(5);
            }

            GUILayout.Space(10);

            // Add new tool button
            if (GUILayout.Button("+ Add New Tool", GUILayout.Height(30)))
            {
                tools.Add(new ConfigManager.CustomTool("", ""));
                modified = true;
            }

            GUILayout.Space(5);

            // Build help text
            string helpText = $"Format: Namespace.ClassName.MethodName\n" +
                              $"Example: {exampleToolName}\n\n" +
                              "The method must be public and static.";

            if (!string.IsNullOrEmpty(additionalNote))
            {
                helpText += $"\n{additionalNote}";
            }

            EditorGUILayout.HelpBox(helpText, MessageType.Info);

            // Save if modified
            if (modified)
            {
                ConfigManager.SaveConfig(config);
                onModified?.Invoke();
            }

            EditorGUI.indentLevel--;
        }

        private void DrawGameMCPSection()
        {
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);

            bool isInPlayMode = EditorApplication.isPlaying;
            bool gameServerExists = FindGameMCPServer();

            // Title + Status on same line
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Game MCP Server", EditorStyles.boldLabel);

            var oldColor = UnityEngine.GUI.color;
            if (!config.gameAutoStart)
            {
                UnityEngine.GUI.color = Color.red;
                GUILayout.Label("● Disabled", EditorStyles.boldLabel);
            }
            else if (isInPlayMode && gameServerExists)
            {
                UnityEngine.GUI.color = Color.green;
                GUILayout.Label("● Running", EditorStyles.boldLabel);
            }
            else if (isInPlayMode && !gameServerExists)
            {
                UnityEngine.GUI.color = Color.yellow;
                GUILayout.Label("● Starting...", EditorStyles.boldLabel);
            }
            else
            {
                UnityEngine.GUI.color = Color.gray;
                GUILayout.Label("● Standby", EditorStyles.boldLabel);
            }
            UnityEngine.GUI.color = oldColor;
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();

            GUILayout.Space(5);

            // Port + Enabled on same line
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Port:", GUILayout.Width(35));
            int newPort = EditorGUILayout.IntField(config.gamePort, GUILayout.Width(60));
            GUILayout.Space(20);
            GUILayout.Label("Enabled:", GUILayout.Width(55));
            bool newAutoStart = EditorGUILayout.Toggle(config.gameAutoStart, GUILayout.Width(20));
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();

            if (newPort != config.gamePort && Constants.IsValidPort(newPort))
            {
                config.gamePort = newPort;
                ConfigManager.SaveConfig(config);
            }

            if (newAutoStart != config.gameAutoStart)
            {
                config.gameAutoStart = newAutoStart;
                ConfigManager.SaveConfig(config);
            }

            GUILayout.Space(5);

            EditorGUILayout.HelpBox(
                "Tools: Status, ViewLog + custom",
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
            DrawToolsEditor(
                config.gameTools,
                "AIRON.MCP.RuntimeExamples.GetCurrentScene",
                "Note: Changes apply when entering Play Mode.",
                null // No server restart needed for game tools
            );
        }

        private bool FindGameMCPServer()
        {
            // GameMCPServer is in Runtime assembly, check if it exists by looking for the GameObject
            var gameObject = GameObject.Find(Constants.GameServerObjectName);
            return gameObject != null && gameObject.GetComponent<MonoBehaviour>() != null;
        }
        
        private void Update()
        {
            // Reload config if not loaded
            if (!configLoaded || config == null)
            {
                config = ConfigManager.LoadConfig();
                configLoaded = true;
            }

            // Trigger auto-start if enabled but server not running
            bool isRunning = ServerEditor.IsRunning();

            if (config.editorAutoStart && !isRunning)
            {
                ServerEditor.Start();
            }
        }

        private void OnInspectorUpdate()
        {
            // Auto-refresh every frame
            Repaint();
        }
    }
}
