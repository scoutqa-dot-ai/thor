/**
 * Low-level primitives shared by the prompt-stream loop
 * (packages/runner/src/prompt-stream.ts) and the trigger-slice viewer rendering
 * (packages/runner/src/index.ts). They live here so the loop can be extracted
 * without a circular import between those two modules.
 */

/** Map of `${providerID}/${modelID}` → context window size, from provider.list. */
export type ModelContextLimits = Map<string, number>;

export function contextLimitKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function safeStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
