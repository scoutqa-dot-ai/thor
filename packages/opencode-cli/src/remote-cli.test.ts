import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { GH_BODY_STDIN_ERROR, runRemoteCli } from "./remote-cli.ts";

class Capture extends Writable {
  value = "";
  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.value += chunk.toString();
    callback();
  }
}

function stdin(text = "") {
  return Readable.from([text]);
}

async function invoke(args: string[], input = "body\n") {
  const stderr = new Capture();
  const stdout = new Capture();
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
  let code: number | undefined;
  await expect(
    runRemoteCli({
      argv: ["gh", ...args],
      env: { THOR_REMOTE_CLI_URL: "http://remote-cli.test" },
      cwd: "/workspace/worktrees/repo/branch",
      stdin: stdin(input),
      fetchImpl,
      stdout,
      stderr,
      exit: ((exitCode: number) => {
        code = exitCode;
        throw new Error(`exit ${exitCode}`);
      }) as (code: number) => never,
    }),
  ).rejects.toThrow(/exit /);
  return { code, stderr: stderr.value, stdout: stdout.value, fetchImpl };
}

describe("gh body transport guard", () => {
  it.each([
    ["pr create inline body", ["pr", "create", "--title", "T", "--body", "Fix `foo`"]],
    ["pr comment inline body", ["pr", "comment", "119", "--body", "uses $(date)"]],
    ["issue create inline body", ["issue", "create", "--title", "T", "--body", "## What"]],
    ["pr create body file path", ["pr", "create", "--title", "T", "--body-file", "body.md"]],
    ["pr create short body file path", ["pr", "create", "--title", "T", "-F", "body.md"]],
    ["gh api raw body", ["api", "repos/o/r/issues", "-f", "body=hi"]],
    ["gh api raw-field body", ["api", "repos/o/r/issues", "--raw-field", "body=hi"]],
    ["gh api field body", ["api", "repos/o/r/issues", "--field", "body=hi"]],
    ["pr comment short inline body", ["pr", "comment", "119", "-b=uses $(date)"]],
  ])("rejects %s before posting", async (_name, args) => {
    const result = await invoke(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(GH_BODY_STDIN_ERROR);
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it("passes --body-file - through with stdin", async () => {
    const result = await invoke(["pr", "create", "--title", "T", "--body-file", "-"], "hello\n");
    expect(result.code).toBe(0);
    expect(result.fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (result.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({
      args: ["pr", "create", "--title", "T", "--body-file", "-"],
      stdin: "hello\n",
    });
  });

  it("does not block non-prose workflow inputs that happen to use body=...", async () => {
    const result = await invoke(["workflow", "run", "ci.yml", "--field", "body=hi"]);
    expect(result.code).toBe(0);
    expect(result.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
