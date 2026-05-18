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

  it("returns false when stat is unavailable", () => {
    const alwaysThrow = () => {
      throw new Error("missing");
    };

    expect(
      isBareMemoryDirectoryPath(`${MEMORY_DIR}/thor/README.md`, { statSync: alwaysThrow }),
    ).toBe(false);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/thor`, { statSync: alwaysThrow })).toBe(false);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/my.repo`, { statSync: alwaysThrow })).toBe(
      false,
    );
  });

  it("treats the memory root as a bare directory without stat", () => {
    expect(isBareMemoryDirectoryPath(MEMORY_DIR)).toBe(true);
  });

  it("suppresses paths when stat reports a directory", () => {
    const fakeStat = (targetPath: string) => ({
      isDirectory: () => targetPath === `${MEMORY_DIR}/my.repo`,
    });

    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/my.repo`, { statSync: fakeStat })).toBe(true);
    expect(isBareMemoryDirectoryPath(`${MEMORY_DIR}/thor/README.md`, { statSync: fakeStat })).toBe(
      false,
    );
  });
});
