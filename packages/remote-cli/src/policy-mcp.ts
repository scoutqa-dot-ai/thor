export type PolicyDecision = "allow" | "approve" | "hidden";

export function classifyTool(allow: string[], approve: string[], toolName: string): PolicyDecision {
  if (allow.includes(toolName)) return "allow";
  if (approve.includes(toolName)) return "approve";
  return "hidden";
}

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
      `Policy drift: config entries not found in upstream:\n${orphans.map((orphan) => `  - ${orphan}`).join("\n")}`,
    );
    this.name = "PolicyDriftError";
  }
}

export class PolicyOverlapError extends Error {
  constructor(public readonly overlap: string[]) {
    super(
      `Policy overlap: tools in both allow and approve:\n${overlap.map((tool) => `  - ${tool}`).join("\n")}`,
    );
    this.name = "PolicyOverlapError";
  }
}
