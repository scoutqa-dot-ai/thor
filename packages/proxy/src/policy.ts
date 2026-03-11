/**
 * Policy engine — pattern-match tool names against an allow-list.
 * Everything not explicitly allowed is blocked.
 */

function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*") && pattern.endsWith("*")) {
    return toolName.includes(pattern.slice(1, -1));
  }
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return toolName.endsWith(pattern.slice(1));
  return pattern === toolName;
}

/** Returns true if the tool is allowed by at least one pattern. */
export function isAllowed(allow: string[], toolName: string): boolean {
  return allow.some((pattern) => matchPattern(pattern, toolName));
}

/**
 * Validate that every discovered tool is covered by at least one allow pattern,
 * and every pattern matches at least one tool. Throws on drift.
 */
export function validatePolicy(allow: string[], tools: string[]): void {
  const uncovered = tools.filter((t) => !allow.some((p) => matchPattern(p, t)));
  const orphans = allow.filter((p) => !tools.some((t) => matchPattern(p, t)));

  const parts: string[] = [];
  if (uncovered.length > 0) {
    parts.push(`Tools without policy coverage:\n${uncovered.map((t) => `  - ${t}`).join("\n")}`);
  }
  if (orphans.length > 0) {
    parts.push(`Allow patterns matching no tools:\n${orphans.map((p) => `  - ${p}`).join("\n")}`);
  }
  if (parts.length > 0) {
    throw new Error(`Policy validation failed.\n${parts.join("\n")}`);
  }
}
