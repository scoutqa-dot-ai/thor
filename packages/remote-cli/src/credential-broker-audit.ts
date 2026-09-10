import type { ToolCallLogEntry } from "@thor/common";

const CREDENTIAL_BOUNDARY_TOOLS = new Set(["get_login_metadata", "browser_login"]);

function safeBrokerArgs(args: Record<string, unknown> | undefined): Record<string, string> {
  if (!args) return {};
  const safe: Record<string, string> = {};
  for (const key of ["item_id", "expected_origin", "_thor_session_id"] as const) {
    const value = args[key];
    if (typeof value === "string") safe[key] = value;
  }
  return safe;
}

/** Strip metadata, upstream errors, and any unexpected fields at the worklog boundary. */
export function sanitizeCredentialBrokerToolCallLog(entry: ToolCallLogEntry): ToolCallLogEntry {
  if (!CREDENTIAL_BOUNDARY_TOOLS.has(entry.tool)) return entry;

  const outcome =
    entry.error !== undefined
      ? "failed"
      : entry.result !== undefined
        ? "succeeded"
        : entry.decision;
  return {
    tool: entry.tool,
    decision: entry.decision,
    targetKey: entry.targetKey,
    profile: entry.profile,
    args: safeBrokerArgs(entry.args),
    result: { outcome },
    durationMs: entry.durationMs,
  };
}
