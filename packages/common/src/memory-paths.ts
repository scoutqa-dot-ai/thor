import * as fs from "node:fs";
import path from "node:path";

export const MEMORY_DIR = "/workspace/memory";

type StatLike = { isDirectory(): boolean };
type StatSyncLike = (path: string) => StatLike;

const KNOWN_MEMORY_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
]);

export function normalizeMemoryPath(memoryPath: string): string {
  return path.posix.normalize(memoryPath);
}

export function isMemoryPath(candidatePath: string): boolean {
  return candidatePath === MEMORY_DIR || candidatePath.startsWith(`${MEMORY_DIR}/`);
}

export function isBareMemoryDirectoryPath(
  memoryPath: string,
  options?: { statSync?: StatSyncLike },
): boolean {
  const normalizedPath = normalizeMemoryPath(memoryPath);
  if (!isMemoryPath(normalizedPath)) return false;
  if (normalizedPath === MEMORY_DIR) return true;

  try {
    const statSync = options?.statSync ?? fs.statSync;
    return statSync(normalizedPath).isDirectory();
  } catch {
    const extension = path.posix.extname(normalizedPath);
    return !KNOWN_MEMORY_FILE_EXTENSIONS.has(extension.toLowerCase());
  }
}
