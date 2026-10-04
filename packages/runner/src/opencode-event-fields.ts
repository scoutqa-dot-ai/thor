/** Narrow raw OpenCode fields without accepting arrays or null as records. */
export function isOpencodeObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read a nonempty OpenCode string field; whitespace is preserved for historical rendering. */
export function readOpencodeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Token breakdown shared by legacy context progress and historical cost rendering. */
export type OpencodeTokenCounts = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
};

/** Read OpenCode token counts without treating cache writes as context input. */
export function extractOpencodeTokenCounts(tokens: unknown): OpencodeTokenCounts | undefined {
  if (!isOpencodeObject(tokens)) return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = isOpencodeObject(tokens.cache) ? tokens.cache : undefined;
  const counts: OpencodeTokenCounts = {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: cache ? num(cache.read) : 0,
  };
  if (counts.input + counts.output + counts.reasoning + counts.cacheRead === 0) {
    return undefined;
  }
  return counts;
}
