import path from "node:path";

const BROAD_ROOTS = new Set(["/", "/workspace"]);
const GREP_TOOL_OUTPUT_ROOT = "/home/thor/.local/share/opencode/tool-output";

const hasGlobMagic = (value) => /[*?{}[\]()!]/.test(value);

const isDescendantOrSelf = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}/`);

const hasTraversal = (value) => value.split("/").includes("..");

const normalizeExplicitPath = (value, directory) => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return path.posix.resolve(
    path.posix.isAbsolute(value) ? value : path.posix.join(directory, value),
  );
};

const fixedDirectoryPrefix = (absoluteGlob) => {
  if (hasTraversal(absoluteGlob)) return undefined;
  const parts = absoluteGlob.split("/").filter(Boolean);
  const fixed = [];
  let firstMagicIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (hasGlobMagic(parts[index])) {
      firstMagicIndex = index;
      break;
    }
    fixed.push(parts[index]);
  }

  if (firstMagicIndex === 0) return undefined;
  if (firstMagicIndex === -1) {
    if (fixed.length === 0) return undefined;
    return fixed.length === 1 ? "/" : `/${fixed.slice(0, -1).join("/")}`;
  }
  return fixed.length === 0 ? undefined : `/${fixed.join("/")}`;
};

export const allowedSearchRoot = (candidate, tool) => {
  const normalized = path.posix.resolve(candidate);
  if (normalized === "/workspace") return false;
  if (normalized.startsWith("/workspace/")) {
    return normalized.split("/").filter(Boolean).length >= 2;
  }
  if (isDescendantOrSelf(normalized, "/tmp/opencode")) return true;
  if (/^\/tmp\/slack-download\.[^/]+(?:\/|$)/.test(normalized)) return true;
  if (tool === "grep" && isDescendantOrSelf(normalized, GREP_TOOL_OUTPUT_ROOT)) return true;
  return false;
};

const searchScopeError = (message) =>
  new Error(
    `${message} Search from a scoped allowed path such as /workspace/<repo-or-run>, /tmp/opencode, or /tmp/slack-download.<id> and use a relative glob/include.`,
  );

const logPolicyEvent = (event, tool, hook, extra = {}) => {
  console.warn({
    service: "opencode-plugin-thor",
    event,
    tool,
    sessionID: hook?.sessionID,
    callID: hook?.callID,
    ...extra,
  });
};

const relativeFromPrefix = (prefix, absoluteGlob) => {
  const rel = path.posix.relative(prefix, absoluteGlob);
  return rel.length === 0 ? "." : rel;
};

export const applySearchScopePolicy = (tool, args, options = {}) => {
  const directory = options.directory ?? "/workspace";
  if (tool !== "glob" && tool !== "grep") return { args, changed: false };

  const scopedField = tool === "glob" ? "pattern" : "include";
  const next = { ...(args ?? {}) };
  const explicitPath = normalizeExplicitPath(next.path, directory);
  const broadPath = explicitPath === undefined || BROAD_ROOTS.has(explicitPath);
  const scopedValue = next[scopedField];

  if (
    explicitPath !== undefined &&
    !BROAD_ROOTS.has(explicitPath) &&
    !allowedSearchRoot(explicitPath, tool)
  ) {
    throw searchScopeError(`Refusing ${tool} with unsafe path ${explicitPath}.`);
  }

  if (typeof scopedValue === "string" && path.posix.isAbsolute(scopedValue)) {
    if (hasTraversal(scopedValue)) {
      throw searchScopeError(`Refusing ${tool} with traversal in absolute ${scopedField}.`);
    }
    if (!broadPath) {
      throw searchScopeError(
        `Refusing ${tool} with both explicit path ${explicitPath} and absolute ${scopedField}.`,
      );
    }

    const prefix = fixedDirectoryPrefix(scopedValue);
    if (!prefix || BROAD_ROOTS.has(prefix) || !allowedSearchRoot(prefix, tool)) {
      throw searchScopeError(`Refusing ${tool} with ambiguous or unsafe absolute ${scopedField}.`);
    }

    next.path = prefix;
    next[scopedField] = relativeFromPrefix(prefix, scopedValue);
    return { args: next, changed: true, event: "search_scope_rewrite", path: prefix };
  }

  if (explicitPath !== undefined) {
    if (BROAD_ROOTS.has(explicitPath)) {
      throw searchScopeError(`Refusing ${tool} with broad path ${explicitPath}.`);
    }
    if (allowedSearchRoot(explicitPath, tool)) {
      return { args: next, changed: false, event: "search_scope_allowed", path: explicitPath };
    }
  }

  return { args: next, changed: false };
};

const SEARCH_GUIDANCE =
  "Thor search scope guardrail: for glob/grep, set path to an allowed scoped root (/workspace/<segment> descendants, /tmp/opencode, or /tmp/slack-download.<id>) and keep glob.pattern/grep.include relative. Grep may also read /home/thor/.local/share/opencode/tool-output. Do not search / or /workspace with absolute globs/includes.";

export const applySearchDefinitionGuidance = (tool, definition) => {
  if (tool !== "glob" && tool !== "grep") return definition;
  const next = { ...(definition ?? {}) };
  const description = typeof next.description === "string" ? next.description : "";
  next.description = description.includes(SEARCH_GUIDANCE)
    ? description
    : [description, SEARCH_GUIDANCE].filter(Boolean).join("\n\n");
  return next;
};

/**
 * Thor OpenCode plugin — injects trusted env vars into every shell execution
 * and scopes built-in search tools away from broad filesystem roots.
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
    "tool.execute.before": async (input, output) => {
      const tool = input?.tool;
      if (tool !== "glob" && tool !== "grep") return;
      const result = applySearchScopePolicy(tool, output.args, { directory: plugin.directory });
      output.args = result.args;
      if (result.event) {
        logPolicyEvent(result.event, tool, input, { path: result.path });
      }
    },
    "tool.definition": async (input, output) => {
      const next = applySearchDefinitionGuidance(input?.toolID, output);
      output.description = next.description;
    },
  };
};

export default {
  id: "thor",
  server: ThorPlugin,
};
