import * as fs from "node:fs";
import path from "node:path";

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

function normalizeMemoryPath(memoryPath: string): string {
  return path.posix.normalize(memoryPath);
}

function isBareMemoryDirectoryPath(memoryPath: string): boolean {
  const normalizedPath = normalizeMemoryPath(memoryPath);
  if (!isMemoryPath(normalizedPath)) return false;
  if (normalizedPath === MEMORY_DIR) return true;

  try {
    return fs.statSync(normalizedPath).isDirectory();
  } catch {
    const base = path.posix.basename(normalizedPath.replace(/\/+$/, ""));
    return !base.includes(".");
  }
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

export function getMemoryProgressEvents(params: {
  tool: string;
  status: string;
  input: unknown;
}): Extract<ProgressEvent, { type: "memory" }>[] {
  if (params.status !== "completed") return [];

  const action = memoryActionForTool(params.tool);
  if (!action) return [];

  return extractMemoryPaths(params.input)
    .filter((path) => !(action === "read" && isBareMemoryDirectoryPath(path)))
    .map((path) => ({
      type: "memory",
      action,
      path,
      source: "tool",
    }));
}
