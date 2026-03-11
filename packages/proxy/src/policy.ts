/**
 * Policy engine — exact-match allow-list.
 * Only tools whose names appear in the allow list are exposed.
 */

/** Returns true if the tool name is in the allow list. */
export function isAllowed(allow: string[], toolName: string): boolean {
  return allow.includes(toolName);
}

/**
 * Validate that every entry in the allow list matches a real upstream tool.
 * Catches typos and upstream tool-set drift (renamed/removed tools).
 *
 * Tools NOT in the allow list are intentionally hidden — that is not an error.
 */
export function validatePolicy(allow: string[], tools: string[]): void {
  const toolSet = new Set(tools);
  const orphans = allow.filter((name) => !toolSet.has(name));

  if (orphans.length > 0) {
    throw new PolicyDriftError(orphans);
  }
}

export class PolicyDriftError extends Error {
  constructor(public readonly orphans: string[]) {
    super(
      `Policy drift: allow-list entries not found in upstream:\n${orphans.map((o) => `  - ${o}`).join("\n")}`,
    );
    this.name = "PolicyDriftError";
  }
}
