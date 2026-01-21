using System;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;

namespace AIRON.MCP
{
    /// <summary>
    /// Handles execution of actions on the Unity main thread.
    /// Provides thread-safe queuing and synchronous execution with timeout support.
    /// </summary>
    public class MainThreadExecutor
    {
        private readonly Queue<Action> _queue = new();
        private readonly object _queueLock = new();
        private readonly Thread _mainThread;
        private readonly string _contextName;

        /// <summary>
        /// Returns true if the current thread is the main thread.
        /// </summary>
        public bool IsMainThread => Thread.CurrentThread == _mainThread;

        /// <summary>
        /// Creates a new MainThreadExecutor.
        /// Must be created from the main thread.
        /// </summary>
        /// <param name="contextName">Name for logging context (e.g., "unity-editor")</param>
        public MainThreadExecutor(string contextName = "MCP")
        {
            _mainThread = Thread.CurrentThread;
            _contextName = contextName;
        }

        /// <summary>
        /// Executes an action on the main thread and returns the result.
        /// If already on the main thread, executes immediately.
        /// Otherwise, queues the action and waits for completion.
        /// </summary>
        /// <param name="action">The action to execute</param>
        /// <param name="timeoutMs">Timeout in milliseconds</param>
        /// <returns>The result from the action, or an error message on timeout/failure</returns>
        public string Execute(Func<string> action, int timeoutMs = Constants.DefaultTimeoutMs)
        {
            if (action == null)
                return "Error: Action is null";

            // If already on main thread, execute immediately
            if (IsMainThread)
            {
                try
                {
                    return action();
                }
                catch (Exception e)
                {
                    Debug.LogError($"[AIRON] {_contextName} main thread action failed: {e}");
                    return $"Error: {e.Message}";
                }
            }

            // Queue for main thread execution
            string result = null;
            Exception thrownException = null;
            var done = new ManualResetEvent(false);

            lock (_queueLock)
            {
                _queue.Enqueue(() =>
                {
                    try
                    {
                        result = action();
                    }
                    catch (Exception e)
                    {
                        thrownException = e;
                        Debug.LogError($"[AIRON] {_contextName} main thread action failed: {e}");
                    }
                    finally
                    {
                        done.Set();
                    }
                });
            }

            // Wait for completion with timeout
            if (!done.WaitOne(timeoutMs))
            {
                return $"Timeout: Action did not complete within {timeoutMs}ms";
            }

            // Check for exception
            if (thrownException != null)
            {
                return $"Error: {thrownException.Message}";
            }

            return result ?? "Error: No result";
        }

        /// <summary>
        /// Executes an action on the main thread without returning a result.
        /// If already on the main thread, executes immediately.
        /// Otherwise, queues the action and waits for completion.
        /// </summary>
        /// <param name="action">The action to execute</param>
        /// <param name="timeoutMs">Timeout in milliseconds</param>
        /// <returns>True if successful, false on timeout or error</returns>
        public bool Execute(Action action, int timeoutMs = Constants.DefaultTimeoutMs)
        {
            if (action == null)
                return false;

            var result = Execute(() =>
            {
                action();
                return "OK";
            }, timeoutMs);

            return result == "OK";
        }

        /// <summary>
        /// Processes all queued actions.
        /// Must be called from the main thread (e.g., from Update() or EditorApplication.update).
        /// </summary>
        public void ProcessQueue()
        {
            lock (_queueLock)
            {
                while (_queue.Count > 0)
                {
                    var action = _queue.Dequeue();
                    try
                    {
                        action();
                    }
                    catch (Exception e)
                    {
                        Debug.LogError($"[AIRON] {_contextName} error processing queue: {e}");
                    }
                }
            }
        }

        /// <summary>
        /// Clears all pending actions from the queue.
        /// </summary>
        public void Clear()
        {
            lock (_queueLock)
            {
                _queue.Clear();
            }
        }
    }
}
