import type { ProgressEvent } from "@thor/common";

const MEMORY_DIR = "/workspace/memory";

const READ_MEMORY_TOOLS = new Set(["read"]);
const WRITE_MEMORY_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit"]);

function memoryActionForTool(tool: string): "read" | "write" | undefined {
  if (READ_MEMORY_TOOLS.has(tool)) return "read";
  if (WRITE_MEMORY_TOOLS.has(tool)) return "write";
  return undefined;
}

function isMemoryPath(path: string): boolean {
  return path === MEMORY_DIR || path.startsWith(`${MEMORY_DIR}/`);
}

function extractMemoryPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];

  const found = new Set<string>();
  const queue: Array<{ value: unknown; key: string }> = [{ value: input, key: "" }];
  let visited = 0;

  while (queue.length > 0 && visited < 200) {
    visited++;
    const item = queue.shift();
    if (!item) continue;

    const { value, key } = item;
    if (typeof value === "string") {
      if (/path/i.test(key) && isMemoryPath(value)) {
        found.add(value);
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        queue.push({ value: child, key });
      }
      continue;
    }

    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        queue.push({ value: childValue, key: childKey });
      }
    }
  }

  return [...found];
}

export function getMemoryProgressEvents(params: {
  tool: string;
  status: string;
  input: unknown;
}): Extract<ProgressEvent, { type: "memory" }>[] {
  if (params.status !== "completed") return [];

  const action = memoryActionForTool(params.tool);
  if (!action) return [];

  return extractMemoryPaths(params.input).map((path) => ({
    type: "memory",
    action,
    path,
    source: "tool",
  }));
}
