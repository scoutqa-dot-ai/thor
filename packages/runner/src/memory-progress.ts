import { isBareMemoryDirectoryPath, isMemoryPath, normalizeMemoryPath } from "@thor/common";
import type { ProgressEvent } from "@thor/common";

const READ_MEMORY_TOOLS = new Set(["read"]);
// `apply_patch` mutates files via a diff payload rather than a `path` field, so
// it is classified as a write here but has its own path extractor below.
const WRITE_MEMORY_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch"]);

const APPLY_PATCH_TOOL = "apply_patch";

function memoryActionForTool(tool: string): "read" | "write" | undefined {
  if (READ_MEMORY_TOOLS.has(tool)) return "read";
  if (WRITE_MEMORY_TOOLS.has(tool)) return "write";
  return undefined;
}

// `apply_patch` file headers, e.g. `*** Add File: /workspace/memory/x.md`,
// `*** Update File: ...`, `*** Delete File: ...`, and the `*** Move to: ...`
// destination of a rename. The touched path is inside the diff text, not a
// `path` field, so `extractMemoryPaths` cannot reach it.
const APPLY_PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/;
const APPLY_PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+?)\s*$/;

function extractApplyPatchMemoryPaths(input: unknown): string[] {
  const patchText = (input as { patchText?: unknown } | null | undefined)?.patchText;
  if (typeof patchText !== "string") return [];

  const found = new Set<string>();
  for (const line of patchText.split("\n")) {
    const match = APPLY_PATCH_FILE_HEADER.exec(line) ?? APPLY_PATCH_MOVE_HEADER.exec(line);
    if (!match) continue;
    const normalizedValue = normalizeMemoryPath(match[1]!);
    if (isMemoryPath(normalizedValue)) found.add(normalizedValue);
  }

  return [...found];
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
      const normalizedValue = normalizeMemoryPath(value);
      if (/path/i.test(key) && isMemoryPath(normalizedValue)) {
        found.add(normalizedValue);
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

type StatLike = { isDirectory(): boolean };
type StatSyncLike = (path: string) => StatLike;

export function getMemoryProgressEvents(params: {
  tool: string;
  status: string;
  input: unknown;
  statSync?: StatSyncLike;
}): Extract<ProgressEvent, { type: "memory" }>[] {
  if (params.status !== "completed") return [];

  const action = memoryActionForTool(params.tool);
  if (!action) return [];

  const paths =
    params.tool === APPLY_PATCH_TOOL
      ? extractApplyPatchMemoryPaths(params.input)
      : extractMemoryPaths(params.input);

  return paths
    .filter(
      (path) =>
        !(action === "read" && isBareMemoryDirectoryPath(path, { statSync: params.statSync })),
    )
    .map((path) => ({
      type: "memory",
      action,
      path,
      source: "tool",
    }));
}
