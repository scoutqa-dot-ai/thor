/**
 * Thor OpenCode plugin — injects trusted env vars into every shell execution.
 *
 * Hooks into `shell.env` so that CLI wrappers (mcp, approval, git, gh) receive
 * THOR_DIRECTORY and THOR_SESSION_ID from OpenCode's own context rather than
 * trusting process.cwd() which the LLM can change via `cd`.
 */
export const ThorPlugin = async (plugin) => {
  return {
    "shell.env": async (hook, output) => {
      output.env.THOR_DIRECTORY = plugin.directory;
      output.env.THOR_SESSION_ID = hook.sessionID;
      if (hook.callID) {
        output.env.THOR_CALL_ID = hook.callID;
      }
    },
  };
};
