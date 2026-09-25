import type { ToolCallLogEntry } from "@thor/common";

const CREDENTIAL_BOUNDARY_TOOLS = new Set([
  "_resolve_login_plan",
  "find_login_items",
  "browser_open_authenticated",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_navigate",
  "browser_close",
]);
const ONEPASSWORD_ID_PATTERN = /^[a-z0-9]{26}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THOR_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function safeHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function safeBrokerArgs(args: Record<string, unknown> | undefined): Record<string, string> {
  if (!args) return {};
  const safe: Record<string, string> = {};
  if (typeof args.item_id === "string" && ONEPASSWORD_ID_PATTERN.test(args.item_id)) {
    safe.item_id = args.item_id;
  }
  if (typeof args.browser_session_id === "string" && UUID_PATTERN.test(args.browser_session_id)) {
    safe.browser_session_id = args.browser_session_id;
  }
  if (typeof args.snapshot_id === "string" && UUID_PATTERN.test(args.snapshot_id)) {
    safe.snapshot_id = args.snapshot_id;
  }
  if (
    typeof args._thor_session_id === "string" &&
    THOR_SESSION_ID_PATTERN.test(args._thor_session_id)
  ) {
    safe._thor_session_id = args._thor_session_id;
  }
  const origin = safeHttpsOrigin(args.url);
  if (origin) safe.origin = origin;
  return safe;
}

/**
 * Strip login-plan IDs, typed text, item titles, page content, full URLs,
 * upstream errors, and unexpected fields from every credential-browser worklog entry.
 */
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
    args: safeBrokerArgs(entry.args),
    result: { outcome },
    durationMs: entry.durationMs,
  };
}
