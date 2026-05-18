import path from "node:path";

const BROAD_ROOTS = new Set(["/", "/workspace"]);
const GREP_TOOL_OUTPUT_ROOT = "/home/thor/.local/share/opencode/tool-output";
const GUARDED_DYNAMIC_SHELL_COMMANDS = new Set(["gh", "curl", "slack-post-message"]);

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
    return undefined;
  }
  return fixed.length === 0 ? undefined : `/${fixed.join("/")}`;
};

export const allowedSearchRoot = (candidate, tool) => {
  const normalized = path.posix.resolve(candidate);
  if (normalized === "/workspace") return false;
  if (normalized.startsWith("/workspace/")) {
    return normalized.split("/").filter(Boolean).length >= 2;
  }
  if (isDescendantOrSelf(normalized, "/tmp")) return true;
  if (tool === "grep" && isDescendantOrSelf(normalized, GREP_TOOL_OUTPUT_ROOT)) return true;
  return false;
};

const searchScopeError = (message) =>
  new Error(
    `${message} Search from a scoped allowed path such as /workspace/<repo-or-run> or /tmp and use a relative glob/include.`,
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

const dynamicShellError = (command) =>
  new Error(
    `Refusing bash command: dynamic shell substitution is not allowed with guarded command "${command}". Run the dynamic step separately and pass reviewed literal input, or use an explicit file-based flag such as --body-file when supported.`,
  );

const isEnvAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const executableName = (word) => {
  if (typeof word !== "string" || word.length === 0) return undefined;
  return path.posix.basename(word);
};

export const hasDynamicShellSubstitution = (command) => {
  if (typeof command !== "string" || command.length === 0) return false;
  let single = false;
  let double = false;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = !double;
      continue;
    }
    if (char === "`") return true;
    if (char === "$" && next === "(") return true;
    if (!double && (char === "<" || char === ">") && next === "(") return true;
  }

  return false;
};

const splitTopLevelSegments = (command) => {
  const segments = [];
  let start = 0;
  let single = false;
  let double = false;
  let escaped = false;
  let substitutionDepth = 0;
  let groupDepth = 0;
  let braceDepth = 0;

  const push = (end) => {
    const segment = command.slice(start, end).trim();
    if (segment.length > 0) segments.push(segment);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = !double;
      continue;
    }
    if (!single && char === "$" && command[index + 1] === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (!single && !double && (char === "<" || char === ">") && command[index + 1] === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      continue;
    }
    if (double || substitutionDepth > 0) continue;

    if (char === "(") {
      groupDepth += 1;
      continue;
    }
    if (char === ")" && groupDepth > 0) {
      groupDepth -= 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (groupDepth > 0 || braceDepth > 0) continue;

    if (char === "\n" || char === ";") {
      push(index);
      start = index + 1;
      continue;
    }
    if (char === "|") {
      const separatorLength = command[index + 1] === "|" || command[index + 1] === "&" ? 2 : 1;
      push(index);
      start = index + separatorLength;
      index += separatorLength - 1;
      continue;
    }
    if (char === "&") {
      const separatorLength = command[index + 1] === "&" ? 2 : 1;
      push(index);
      start = index + separatorLength;
      index += separatorLength - 1;
    }
  }
  push(command.length);
  return segments;
};

const envOptionOperandCount = (word) => {
  if (word === "-u" || word === "--unset" || word === "-C" || word === "--chdir") return 1;
  if (word === "-S" || word === "--split-string") return 1;
  if (
    word.startsWith("--unset=") ||
    word.startsWith("--chdir=") ||
    word.startsWith("--split-string=")
  ) {
    return 0;
  }
  if (word.startsWith("-u") || word.startsWith("-C") || word.startsWith("-S")) return 0;
  return 0;
};

const isEnvOption = (word) => word.startsWith("-") && word !== "-";

const REDIRECTION_OPERATOR = String.raw`(?:<<-|<<<|>>|<>|>\||>&|<&|<|>)`;
const redirectionOnlyPattern = new RegExp(String.raw`^\d*${REDIRECTION_OPERATOR}$`);
const redirectionWithTargetPattern = new RegExp(String.raw`^\d*${REDIRECTION_OPERATOR}.+`);

const redirectionOperandCount = (word) => {
  if (redirectionOnlyPattern.test(word)) return 1;
  if (redirectionWithTargetPattern.test(word)) return 0;
  return undefined;
};

const envSplitStringOperand = (word, next) => {
  if (word === "-S" || word === "--split-string") return next;
  if (word.startsWith("--split-string=")) return word.slice("--split-string=".length);
  if (word.startsWith("-S") && word.length > 2) return word.slice(2);
  return undefined;
};

const skipAssignmentsAndRedirections = (words, start) => {
  let index = start;
  while (index < words.length) {
    const redirectOperands = redirectionOperandCount(words[index]);
    if (isEnvAssignment(words[index])) {
      index += 1;
    } else if (redirectOperands !== undefined) {
      index += 1 + redirectOperands;
    } else {
      break;
    }
  }
  return index;
};

const execOptionOperandCount = (word) => {
  if (word === "-a") return 1;
  if (word === "-c" || word === "-l") return 0;
  return undefined;
};

const compoundGroupBody = (segment) => {
  const trimmed = typeof segment === "string" ? segment.trim() : "";
  const opener = trimmed[0];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : undefined;
  if (!closer) return undefined;

  let single = false;
  let double = false;
  let escaped = false;
  let substitutionDepth = 0;
  let groupDepth = 0;
  let braceDepth = 0;

  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = !double;
      continue;
    }
    if (!single && char === "$" && trimmed[index + 1] === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (!single && !double && (char === "<" || char === ">") && trimmed[index + 1] === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      continue;
    }
    if (double || substitutionDepth > 0) continue;

    if (char === "(") {
      groupDepth += 1;
      continue;
    }
    if (char === ")") {
      if (groupDepth > 0) {
        groupDepth -= 1;
        continue;
      }
      if (closer === ")" && braceDepth === 0) return trimmed.slice(1, index);
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }
      if (closer === "}" && groupDepth === 0) return trimmed.slice(1, index);
    }
  }
  return undefined;
};

const shellWords = (segment) => {
  const words = [];
  let current = "";
  let single = false;
  let double = false;
  let escaped = false;
  let substitutionDepth = 0;

  const push = () => {
    if (current.length > 0) {
      words.push(current);
      current = "";
    }
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (single) {
      if (char === "'") single = false;
      else current += char;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = !double;
      continue;
    }
    if (!single && char === "$" && segment[index + 1] === "(") {
      substitutionDepth += 1;
      current += "$(";
      index += 1;
      continue;
    }
    if (!single && !double && (char === "<" || char === ">") && segment[index + 1] === "(") {
      substitutionDepth += 1;
      current += `${char}(`;
      index += 1;
      continue;
    }
    if (substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      current += char;
      continue;
    }
    if (!double && substitutionDepth === 0 && /\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  push();
  return words;
};

const firstExecutableWord = (segment) => {
  const words = shellWords(segment);
  let index = skipAssignmentsAndRedirections(words, 0);
  let name = executableName(words[index]);

  while (true) {
    if (name === "command") {
      index += 1;
      while (index < words.length && words[index].startsWith("-")) index += 1;
      index = skipAssignmentsAndRedirections(words, index);
      name = executableName(words[index]);
      continue;
    }

    if (name === "exec") {
      index += 1;
      while (index < words.length) {
        const operandCount = execOptionOperandCount(words[index]);
        if (operandCount === undefined) break;
        index += 1 + operandCount;
      }
      index = skipAssignmentsAndRedirections(words, index);
      name = executableName(words[index]);
      continue;
    }

    if (name === "time") {
      index += 1;
      if (words[index] === "-p" || words[index] === "--") index += 1;
      index = skipAssignmentsAndRedirections(words, index);
      name = executableName(words[index]);
      continue;
    }

    if (name === "env") {
      index += 1;
      while (index < words.length) {
        const redirectOperands = redirectionOperandCount(words[index]);
        if (isEnvAssignment(words[index])) {
          index += 1;
          continue;
        }
        if (redirectOperands !== undefined) {
          index += 1 + redirectOperands;
          continue;
        }
        if (words[index] === "--") {
          index += 1;
          break;
        }
        if (!isEnvOption(words[index])) break;
        const splitString = envSplitStringOperand(words[index], words[index + 1]);
        if (hasDynamicShellSubstitution(splitString)) {
          const splitStringName = firstExecutableWord(splitString);
          if (GUARDED_DYNAMIC_SHELL_COMMANDS.has(splitStringName)) return splitStringName;
        }
        index += 1 + envOptionOperandCount(words[index]);
      }
      index = skipAssignmentsAndRedirections(words, index);
      name = executableName(words[index]);
      continue;
    }

    break;
  }
  return name;
};

export const findGuardedDynamicShellCommand = (command) => {
  if (typeof command !== "string") return undefined;
  for (const segment of splitTopLevelSegments(command)) {
    if (!hasDynamicShellSubstitution(segment)) continue;
    const groupBody = compoundGroupBody(segment);
    if (groupBody !== undefined) {
      const groupedCommand = findGuardedDynamicShellCommand(groupBody);
      if (groupedCommand) return groupedCommand;
      continue;
    }
    const commandName = firstExecutableWord(segment);
    if (GUARDED_DYNAMIC_SHELL_COMMANDS.has(commandName)) return commandName;
  }
  return undefined;
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

  if (typeof scopedValue === "string" && hasTraversal(scopedValue)) {
    throw searchScopeError(`Refusing ${tool} with traversal in ${scopedField}.`);
  }

  if (
    explicitPath !== undefined &&
    !BROAD_ROOTS.has(explicitPath) &&
    !allowedSearchRoot(explicitPath, tool)
  ) {
    throw searchScopeError(`Refusing ${tool} with unsafe path ${explicitPath}.`);
  }

  if (typeof scopedValue === "string" && path.posix.isAbsolute(scopedValue)) {
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
      return { args: next, changed: false, path: explicitPath };
    }
  }

  return { args: next, changed: false };
};

const SEARCH_GUIDANCE =
  "Thor search scope guardrail: for glob/grep, set path to an allowed scoped root (/workspace/<segment> descendants or /tmp) and keep glob.pattern/grep.include relative. Grep may also read /home/thor/.local/share/opencode/tool-output. In this runtime, rg is wrapped to block unsafe absolute --glob scans against broad roots such as /, /workspace, /home, or /tmp; use a scoped path plus relative glob/include instead.";

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
      if (tool === "bash") {
        const guardedCommand = findGuardedDynamicShellCommand(output?.args?.command);
        if (guardedCommand) {
          logPolicyEvent("dynamic_shell_substitution_block", tool, input, {
            command: guardedCommand,
          });
          throw dynamicShellError(guardedCommand);
        }
        return;
      }
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
