/**
 * Policy engine — three-tier classification.
 *
 * Tools are classified as:
 *   - allow:   forwarded immediately
 *   - approve: exposed to agent but gated on human approval
 *   - hidden:  not exposed (agent never sees them)
 */

export type PolicyDecision = "allow" | "approve" | "hidden";

/** Classify a tool based on the allow and approve lists. */
export function classifyTool(allow: string[], approve: string[], toolName: string): PolicyDecision {
  if (allow.includes(toolName)) return "allow";
  if (approve.includes(toolName)) return "approve";
  return "hidden";
}

/** Returns true if the tool name is in the allow list. */
export function isAllowed(allow: string[], toolName: string): boolean {
  return allow.includes(toolName);
}

/** Returns true if the tool name requires approval. */
export function isApprovalRequired(approve: string[], toolName: string): boolean {
  return approve.includes(toolName);
}

/**
 * Validate that every entry in the allow and approve lists matches a real
 * upstream tool. Catches typos and upstream tool-set drift.
 *
 * Also checks that allow and approve lists don't overlap.
 */
export function validatePolicy(allow: string[], approve: string[], tools: string[]): void {
  const toolSet = new Set(tools);

  const allConfigured = [...allow, ...approve];
  const orphans = allConfigured.filter((name) => !toolSet.has(name));
  if (orphans.length > 0) {
    throw new PolicyDriftError(orphans);
  }

  const overlap = allow.filter((name) => approve.includes(name));
  if (overlap.length > 0) {
    throw new PolicyOverlapError(overlap);
  }
}

export class PolicyDriftError extends Error {
  constructor(public readonly orphans: string[]) {
    super(
      `Policy drift: config entries not found in upstream:\n${orphans.map((o) => `  - ${o}`).join("\n")}`,
    );
    this.name = "PolicyDriftError";
  }
}

export class PolicyOverlapError extends Error {
  constructor(public readonly overlap: string[]) {
    super(
      `Policy overlap: tools in both allow and approve:\n${overlap.map((o) => `  - ${o}`).join("\n")}`,
    );
    this.name = "PolicyOverlapError";
  }
}
