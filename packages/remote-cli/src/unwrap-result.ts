import { z } from "zod";

const TextOnlyResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

export function unwrapResult(result: unknown): string {
  const parsed = TextOnlyResult.safeParse(result);
  if (parsed.success) {
    return parsed.data.content.map((block) => block.text).join("\n");
  }
  return JSON.stringify(result);
}
