import { describe, expect, it } from "vitest";
import {
  MEMORY_DIR,
  isBareMemoryDirectoryPath,
  isMemoryPath,
  normalizeMemoryPath,
} from "./memory-paths.js";

describe("memory-paths", () => {
  it("normalizes memory paths before checks", () => {
    expect(normalizeMemoryPath(`${MEMORY_DIR}/thor/../thor/.`)).toBe(`${MEMORY_DIR}/thor`);
  });

  it("keeps containment checks scoped to memory root", () => {
    expect(isMemoryPath(MEMORY_DIR)).toBe(true);
    expect(isMemoryPath(`${MEMORY_DIR}/thor/README.md`)).toBe(true);
    expect(isMemoryPath(normalizeMemoryPath(`${MEMORY_DIR}/../repos/thor`))).toBe(false);
  });

  it("treats known file extensions as files when stat is unavailable", () => {
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/thor/README.md`)).toBe(false);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/runbooks/investigation-workflow.md`)).toBe(
      false,
    );
  });

  it("suppresses bare directory-like paths including dotted names", () => {
    expect(isBareMemoryDirectoryPath(MEMORY_DIR)).toBe(true);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/.`)).toBe(true);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/thor`)).toBe(true);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/my.repo`)).toBe(true);
  });
});
