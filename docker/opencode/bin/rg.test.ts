import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = new URL("./rg", import.meta.url).pathname;

const run = async (args: string[], cwd = process.cwd()) => {
  try {
    const result = await execFileAsync("bash", [wrapper, ...args], { cwd });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

describe("rg wrapper guardrail", () => {
  it("blocks unsafe absolute --glob searches against broad roots", async () => {
    await expect(run(["--glob", "/workspace/repos/**", "/workspace"])).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("absolute --glob"),
    });
    await expect(
      run(["--files", "--glob", "/workspace/repos/**", "/workspace"]),
    ).resolves.toMatchObject({
      code: 2,
    });
    await expect(run(["--glob=/workspace/repos/**", "/"])).resolves.toMatchObject({ code: 2 });
    await expect(run(["-g/workspace/repos/**", "/workspace"])).resolves.toMatchObject({ code: 2 });
  });

  it("blocks unsafe absolute --glob with no positional path while cwd is root", async () => {
    await expect(run(["--glob", "/workspace/repos/**", "needle"], "/")).resolves.toMatchObject({
      code: 2,
    });
  });

  it("blocks unsafe absolute --glob with no positional path while cwd is a broad workspace root", async () => {
    await expect(
      run(["--files", "--glob", "/workspace/repos/**"], "/workspace"),
    ).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("absolute --glob"),
    });
  });

  it("delegates scoped and ordinary ripgrep invocations", async () => {
    await expect(run(["--glob", "**/*.ts", "--version"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ripgrep"),
    });
    await expect(run(["--version"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ripgrep"),
    });
  });
});
