import type { BehaviorAssertion } from "../types.js";

function parseSingleQuotedJson(command: string): {
  upstream: string;
  tool: string;
  payload: unknown;
} | null {
  const match = /^mcp\s+([a-z0-9_-]+)\s+([a-z0-9_-]+)\s+'((?:[^']|'\\''?)*)'$/iu.exec(
    command.trim(),
  );
  if (!match) {
    return null;
  }
  try {
    return {
      upstream: match[1]!,
      tool: match[2]!,
      payload: JSON.parse(match[3]!),
    };
  } catch {
    return null;
  }
}

const assertion: BehaviorAssertion = ({ call }) => {
  const command = call?.arguments.command;
  if (typeof command !== "string") {
    return { pass: false, reason: "bash.command must be a string" };
  }
  const parsed = parseSingleQuotedJson(command);
  if (!parsed) {
    return {
      pass: false,
      reason: "command must be one standalone mcp invocation with a single-quoted JSON payload",
    };
  }
  if (parsed.upstream !== "grafana" || parsed.tool !== "query_loki_logs") {
    return {
      pass: false,
      reason: "command must call mcp grafana query_loki_logs",
    };
  }
  if (
    parsed.payload === null ||
    typeof parsed.payload !== "object" ||
    Array.isArray(parsed.payload)
  ) {
    return { pass: false, reason: "Loki payload must be a JSON object" };
  }
  const payload = parsed.payload as Record<string, unknown>;
  if (typeof payload.datasourceUid !== "string" || typeof payload.logql !== "string") {
    return {
      pass: false,
      reason: "Loki payload requires datasourceUid and logql strings",
    };
  }
  return { pass: true, reason: "single semantic Loki query matched" };
};

export default assertion;
