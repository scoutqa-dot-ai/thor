import { approvalToolRequiresDisclaimer, disclaimerTargetField } from "@thor/common";

export type PolicyDecision = "allow" | "approve" | "hidden";

/** The subset of an upstream MCP tool definition the policy check reads. */
export interface UpstreamTool {
  name: string;
  inputSchema?: unknown;
}

export function classifyTool(allow: string[], approve: string[], toolName: string): PolicyDecision {
  if (allow.includes(toolName)) return "allow";
  if (approve.includes(toolName)) return "approve";
  return "hidden";
}

export function validatePolicy(allow: string[], approve: string[], tools: UpstreamTool[]): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const missing = [...allow, ...approve]
    .filter((name) => !byName.has(name))
    .map((name) => `${name}: not exposed by upstream`);

  // Every approve-gated write must also still expose the field Thor appends the
  // Thor disclaimer to. Name-level drift does not catch a provider renaming or
  // retyping that field, and the consequence is silent: an upstream that ignores
  // unknown properties accepts the write and drops the footer, shipping an
  // artifact with no trace back to the trigger that produced it. Reported
  // together with missing tools so neither kind of drift masks the other.
  const untargetable = approve
    .filter((name) => byName.has(name) && approvalToolRequiresDisclaimer(name))
    .map((name) => ({ name, field: disclaimerTargetField(name)! }))
    .filter(({ name, field }) => !acceptsString(byName.get(name)?.inputSchema, field))
    .map(
      ({ name, field }) =>
        `${name}: upstream has no string property "${field}" to carry the Thor disclaimer`,
    );

  const issues = [...missing, ...untargetable];
  if (issues.length > 0) {
    throw new PolicyDriftError(issues);
  }

  const overlap = allow.filter((name) => approve.includes(name));
  if (overlap.length > 0) {
    throw new PolicyOverlapError(overlap);
  }
}

/**
 * Whether a JSON Schema property can hold a string. Providers legitimately widen
 * a prose field to a union — Jira's `description` is `anyOf: [string, ADF doc]` —
 * so an `anyOf` branch typed `string` counts.
 */
function acceptsString(inputSchema: unknown, field: string): boolean {
  if (!inputSchema || typeof inputSchema !== "object") return false;
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return false;
  const property = (properties as Record<string, unknown>)[field];
  if (!property || typeof property !== "object") return false;
  const { type, anyOf } = property as { type?: unknown; anyOf?: unknown };
  if (type === "string") return true;
  return (
    Array.isArray(anyOf) &&
    anyOf.some((branch) => (branch as { type?: unknown } | null)?.type === "string")
  );
}

export class PolicyDriftError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Policy drift:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
    this.name = "PolicyDriftError";
  }
}

export class PolicyOverlapError extends Error {
  readonly overlap: string[];
  constructor(overlap: string[]) {
    super(
      `Policy overlap: tools in both allow and approve:\n${overlap.map((tool) => `  - ${tool}`).join("\n")}`,
    );
    this.overlap = overlap;
    this.name = "PolicyOverlapError";
  }
}
