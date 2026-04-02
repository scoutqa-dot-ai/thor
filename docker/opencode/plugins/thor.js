/**
 * Thor OpenCode plugin — injects trusted env vars into every shell execution.
 *
 * Hooks into `shell.env` so that CLI wrappers (mcp, approval, git, gh) receive
 * THOR_OPENCODE_DIRECTORY and THOR_OPENCODE_SESSION_ID from OpenCode's own
 * context rather than trusting process.cwd() which the LLM can change via `cd`.
 */
export const ThorPlugin = async (plugin) => {
  return {
    "shell.env": async (hook, output) => {
      output.env.THOR_OPENCODE_DIRECTORY = plugin.directory;
      if (hook.sessionID) {
        output.env.THOR_OPENCODE_SESSION_ID = hook.sessionID;
      }
      if (hook.callID) {
        output.env.THOR_OPENCODE_CALL_ID = hook.callID;
      }
    },
  };
};
