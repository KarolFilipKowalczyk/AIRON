using UnityEngine;
using UnityEngine.SceneManagement;

namespace AIRON.MCP
{
    /// <summary>
    /// Example runtime commands for AIRON MCP custom tools.
    /// These are static methods that can be exposed as MCP tools during Play Mode.
    /// </summary>
    public static class RuntimeExamples
    {
        /// <summary>
        /// Get all loaded scenes in Play Mode
        /// Tool: AIRON.MCP.RuntimeExamples.GetLoadedScenes → "Get all loaded scenes"
        /// </summary>
        public static string GetLoadedScenes()
        {
            int sceneCount = SceneManager.sceneCount;
            var activeScene = SceneManager.GetActiveScene();
            
            string[] scenes = new string[sceneCount];
            
            for (int i = 0; i < sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                bool isActive = scene == activeScene;
                scenes[i] = isActive ? $"{scene.name} [ACTIVE]" : scene.name;
            }
            
            return string.Join(", ", scenes);
        }
        
        /// <summary>
        /// Switch to a different scene by name
        /// Tool: AIRON.MCP.RuntimeExamples.SwitchScene → "Switch to a scene by name"
        /// </summary>
        public static string SwitchScene(string sceneName)
        {
            if (string.IsNullOrEmpty(sceneName))
            {
                return "Error: Scene name cannot be empty";
            }
            
            // Check if scene exists in build settings
            bool sceneExists = false;
            for (int i = 0; i < SceneManager.sceneCountInBuildSettings; i++)
            {
                string scenePath = SceneUtility.GetScenePathByBuildIndex(i);
                string sceneNameFromPath = System.IO.Path.GetFileNameWithoutExtension(scenePath);
                
                if (sceneNameFromPath.Equals(sceneName, System.StringComparison.OrdinalIgnoreCase))
                {
                    sceneExists = true;
                    sceneName = sceneNameFromPath; // Use exact case
                    break;
                }
            }
            
            if (!sceneExists)
            {
                return $"Error: Scene '{sceneName}' not found in build settings";
            }
            
            try
            {
                SceneManager.LoadScene(sceneName);
                return $"Loading scene: {sceneName}";
            }
            catch (System.Exception e)
            {
                return $"Error loading scene: {e.Message}";
            }
        }
    }
}
