using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using System.Linq;

namespace AIRON.MCP
{
    /// <summary>
    /// Example commands for AIRON MCP custom tools.
    /// These are static methods that can be exposed as MCP tools.
    /// </summary>
    public static class Examples
    {
        /// <summary>
        /// List all scenes in the project
        /// Tool: AIRON.MCP.Examples.ListScenes → "List all scenes in the project"
        /// </summary>
        public static string ListScenes()
        {
            var sceneGuids = AssetDatabase.FindAssets("t:Scene");
            
            if (sceneGuids.Length == 0)
            {
                return "No scenes found in project";
            }
            
            var sceneList = sceneGuids
                .Select(guid => AssetDatabase.GUIDToAssetPath(guid))
                .Select(path => System.IO.Path.GetFileNameWithoutExtension(path))
                .ToList();
            
            return "Scenes in project:\n" + string.Join("\n", sceneList.Select((s, i) => $"{i + 1}. {s}"));
        }
        
        /// <summary>
        /// Load a scene by name
        /// Tool: AIRON.MCP.Examples.LoadScene → "Load a scene by name"
        /// </summary>
        public static string LoadScene(string sceneName)
        {
            // Cannot load scenes during Play Mode
            if (EditorApplication.isPlaying)
            {
                return "Cannot load scenes during Play Mode. Exit Play Mode first.";
            }

            // Find the scene asset
            var sceneGuids = AssetDatabase.FindAssets($"t:Scene {sceneName}");

            if (sceneGuids.Length == 0)
            {
                return $"Scene '{sceneName}' not found in project";
            }

            var scenePath = AssetDatabase.GUIDToAssetPath(sceneGuids[0]);

            // Ask to save current scene if modified
            if (EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
            {
                EditorSceneManager.OpenScene(scenePath);
                return $"Loaded scene: {sceneName}";
            }

            return "Scene load cancelled by user";
        }
    }
}
