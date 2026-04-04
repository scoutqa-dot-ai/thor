import { z } from "zod";

/** MCP CallToolResult where every content block is text. */
const TextOnlyResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

/**
 * If the MCP result contains only text content blocks, return the joined text.
 * Otherwise return the full MCP envelope as JSON.
 */
export function unwrapResult(result: unknown): string {
  const parsed = TextOnlyResult.safeParse(result);
  if (parsed.success) {
    return parsed.data.content.map((b) => b.text).join("\n");
  }
  return JSON.stringify(result);
}
