import type { ProgressBlock, ProgressModel } from "@thor/common";

const CHUNK_LIMIT = 2800;
const MAX_CHUNKS = 64;

/** Final answer formatting/chunking only; rich artifacts stay with explicit tools, reasoning never enters this API. */
export function prepareSlackFinalAnswer(
  text: string,
  model?: ProgressModel,
):
  | { state: "empty" | "rejected" }
  | { state: "ready"; chunks: Array<{ text: string; blocks: ProgressBlock[] }> } {
  if (!text.trim()) return { state: "empty" };
  // Preserve code and existing Slack entities; convert common assistant Markdown outside code.
  const formattedParts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, index) => {
    if (index % 2) return part;
    return part
      .replace(/&(?!amp;|lt;|gt;)/g, "&amp;")
      .replace(/<[^<>\n]*>|[<>]/g, (whole) =>
        /^<(?:https?:\/\/|@[UW][A-Z0-9]+(?:\||>)|#[CG][A-Z0-9]+(?:\||>)|!(?:here|channel|everyone|subteam\^|date\^))/.test(
          whole,
        )
          ? whole
          : whole.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      )
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
      .replace(/\*\*([^\n]+?)\*\*/g, "*$1*")
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  });
  const formatted = formattedParts.join("");
  // Protect actual entities, inline code and fence delimiters, not comparison operators in code.
  // Offsets remain UTF-16 because Slack's block budget and string slicing use those same units.
  const protectedRanges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const [index, part] of formattedParts.entries()) {
    if (index % 2 && part.startsWith("```")) {
      const header = part.match(/^```[^\n`]*(?:\n|$)/)?.[0] ?? "```";
      protectedRanges.push({ start: offset, end: offset + header.length });
      if (part.endsWith("```") && part.length > header.length)
        protectedRanges.push({ start: offset + part.length - 3, end: offset + part.length });
    } else if (index % 2) protectedRanges.push({ start: offset, end: offset + part.length });
    else
      for (const match of part.matchAll(/<[^>\n]*>|&(?:amp|lt|gt);/g))
        protectedRanges.push({
          start: offset + match.index,
          end: offset + match.index + match[0].length,
        });
    offset += part.length;
  }
  const pieces: string[] = [];
  let remaining = formatted;
  let fence: string | undefined;
  let consumed = 0;
  while (remaining) {
    const points = Array.from(remaining);
    let end = 0;
    let units = 0;
    while (end < points.length && units + points[end].length <= CHUNK_LIMIT) {
      units += points[end].length;
      end++;
    }
    if (end < points.length) {
      const candidate = points.slice(0, end).join("");
      const breakAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
      if (breakAt > CHUNK_LIMIT / 2) end = Array.from(candidate.slice(0, breakAt + 1)).length;
      // Move a boundary out of a real protected token; ordinary/code angle chars are splittable.
      const prefix = points.slice(0, end).join("");
      const boundary = consumed + prefix.length;
      const token = protectedRanges.find((range) => range.start < boundary && boundary < range.end);
      if (token) end = Array.from(prefix.slice(0, token.start - consumed)).length;
      if (!end) return { state: "rejected" };
      const tail = points
        .slice(0, end)
        .join("")
        .match(/`{1,2}$/)?.[0];
      if (tail && points[end] === "`") end -= tail.length;
    }
    if (!end) return { state: "rejected" };
    const raw = points.slice(0, end).join("");
    let chunk = (fence === undefined ? "" : `\`\`\`${fence}\n`) + raw;
    for (const match of raw.matchAll(/```([^\n`]*)/g))
      fence = fence === undefined ? match[1] : undefined;
    if (fence !== undefined) chunk += "\n```";
    // Reopened fences count too: an unsupported giant language/header must reject before any send.
    if (chunk.length > 3000) return { state: "rejected" };
    pieces.push(chunk);
    if (pieces.length > MAX_CHUNKS) return { state: "rejected" };
    consumed += raw.length;
    remaining = points.slice(end).join("");
  }
  return {
    state: "ready",
    chunks: pieces.map((piece, index) => ({
      text: piece,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: piece } },
        ...(model && index === pieces.length - 1
          ? [
              {
                type: "context",
                elements: [
                  {
                    type: "plain_text",
                    text: `Model: ${model.modelId} · Thinking: ${model.thinkingLevel}`,
                    emoji: false,
                  },
                ],
              },
            ]
          : []),
      ],
    })),
  };
}
