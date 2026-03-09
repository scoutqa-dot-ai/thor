/**
 * Structured JSON logger for the proxy.
 * All tool calls, policy decisions, and errors are logged here.
 */

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logToolCall(
  upstream: string,
  toolName: string,
  decision: string,
  durationMs?: number,
  error?: string,
): void {
  emit({
    timestamp: new Date().toISOString(),
    level: error ? "error" : "info",
    event: "tool_call",
    upstream,
    tool: toolName,
    decision,
    durationMs,
    ...(error ? { error } : {}),
  });
}

export function logInfo(event: string, data?: Record<string, unknown>): void {
  emit({
    timestamp: new Date().toISOString(),
    level: "info",
    event,
    ...data,
  });
}

export function logError(event: string, error: unknown, data?: Record<string, unknown>): void {
  emit({
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    error: error instanceof Error ? error.message : String(error),
    ...data,
  });
}
