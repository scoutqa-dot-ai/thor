import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = new URL("./rg", import.meta.url).pathname;
const tempRoot = mkdtempSync(path.join(tmpdir(), "rg-wrapper-test-"));
const fakeRg = path.join(tempRoot, "fake-rg.sh");

writeFileSync(
  fakeRg,
  '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then\n  printf \'ripgrep 99.0.0\\n\'\n  exit 0\nfi\nprintf \'fake-rg %s\\n\' "$*"\n',
);
chmodSync(fakeRg, 0o755);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const run = async (args: string[], cwd = process.cwd()) => {
  try {
    const result = await execFileAsync("bash", [wrapper, ...args], {
      cwd,
      env: { ...process.env, THOR_REAL_RG: fakeRg },
    });
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

  it("blocks unsafe absolute --glob with cwd override set to a broad root", async () => {
    const result = await execFileAsync(
      "bash",
      [wrapper, "--files", "--glob", "/workspace/repos/**"],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          THOR_REAL_RG: fakeRg,
          THOR_RG_CWD_OVERRIDE: "/workspace",
        },
      },
    ).catch((error) => {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
    });

    expect(result).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("absolute --glob"),
    });
  });

  it("delegates scoped and ordinary ripgrep invocations", async () => {
    await expect(run(["--glob", "**/*.ts", "--version"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("fake-rg --glob **/*.ts --version"),
    });
    await expect(run(["--version"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ripgrep 99.0.0"),
    });
  });
});
