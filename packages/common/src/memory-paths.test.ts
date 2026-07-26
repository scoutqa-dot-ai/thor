import { describe, expect, it } from "vitest";
import {
  MEMORY_DIR,
  isBareMemoryDirectoryPath,
  isMemoryPath,
  normalizeMemoryPath,
} from "./memory-paths.ts";

type StatStub = ((targetPath: string) => { isDirectory: () => boolean }) | undefined;

/** Fail-open path: stat throwing (missing/unreadable) must not report a bare directory. */
const statUnavailable: StatStub = () => {
  throw new Error("missing");
};
const statDirectoryAt =
  (directoryPath: string): StatStub =>
  (targetPath) => ({ isDirectory: () => targetPath === directoryPath });

describe("memory-paths", () => {
  it.each<[string, StatStub, { normalized: string; isMemory: boolean; isBare: boolean }]>([
    // normalization happens before containment / stat checks
    [
      `${MEMORY_DIR}/thor/../thor/.`,
      statDirectoryAt(`${MEMORY_DIR}/thor`),
      { normalized: `${MEMORY_DIR}/thor`, isMemory: true, isBare: true },
    ],
    // the memory root is a bare directory without consulting stat at all
    [MEMORY_DIR, undefined, { normalized: MEMORY_DIR, isMemory: true, isBare: true }],
    // containment stays scoped to the memory root
    [
      `${MEMORY_DIR}/../repos/thor`,
      statUnavailable,
      { normalized: "/workspace/repos/thor", isMemory: false, isBare: false },
    ],
    // stat unavailable -> false (fail open, never suppress)
    [
      `${MEMORY_DIR}/thor/README.md`,
      statUnavailable,
      { normalized: `${MEMORY_DIR}/thor/README.md`, isMemory: true, isBare: false },
    ],
    [
      `${MEMORY_DIR}/thor`,
      statUnavailable,
      { normalized: `${MEMORY_DIR}/thor`, isMemory: true, isBare: false },
    ],
    [
      `${MEMORY_DIR}/my.repo`,
      statUnavailable,
      { normalized: `${MEMORY_DIR}/my.repo`, isMemory: true, isBare: false },
    ],
    // stat reports a directory -> suppressed; a file keeps rendering
    [
      `${MEMORY_DIR}/my.repo`,
      statDirectoryAt(`${MEMORY_DIR}/my.repo`),
      { normalized: `${MEMORY_DIR}/my.repo`, isMemory: true, isBare: true },
    ],
    [
      `${MEMORY_DIR}/thor/README.md`,
      statDirectoryAt(`${MEMORY_DIR}/my.repo`),
      { normalized: `${MEMORY_DIR}/thor/README.md`, isMemory: true, isBare: false },
    ],
  ])("%s (stat %#)", (candidatePath, statSync, expected) => {
    const normalized = normalizeMemoryPath(candidatePath);
    expect(normalized).toBe(expected.normalized);
    expect(isMemoryPath(normalized)).toBe(expected.isMemory);
    expect(isBareMemoryDirectoryPath(candidatePath, statSync ? { statSync } : undefined)).toBe(
      expected.isBare,
    );
  });
});
