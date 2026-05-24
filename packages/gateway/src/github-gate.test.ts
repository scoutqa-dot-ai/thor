import { describe, expect, it, vi } from "vitest";
import { resolvePrChecksTerminalState, verifyThorAuthoredSha } from "./github-gate.js";
import type { InternalExecClient } from "./service.js";

function ok(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("verifyThorAuthoredSha", () => {
  it("accepts an existing sha authored by the expected bot email", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("49699333+thor[bot]@users.noreply.github.com\n"));

    await expect(
      verifyThorAuthoredSha({
        internalExec,
        directory: "/workspace/repos/thor",
        sha: "abc123",
        expectedEmail: "49699333+thor[bot]@users.noreply.github.com",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects missing shas", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce({ stdout: "", stderr: "missing", exitCode: 128 });

    await expect(
      verifyThorAuthoredSha({
        internalExec,
        directory: "/workspace/repos/thor",
        sha: "abc123",
        expectedEmail: "49699333+thor[bot]@users.noreply.github.com",
      }),
    ).resolves.toEqual({ ok: false, reason: "sha_missing" });
  });

  it("rejects commits authored by a different email", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("alice@example.com\n"));

    await expect(
      verifyThorAuthoredSha({
        internalExec,
        directory: "/workspace/repos/thor",
        sha: "abc123",
        expectedEmail: "49699333+thor[bot]@users.noreply.github.com",
      }),
    ).resolves.toEqual({ ok: false, reason: "author_mismatch" });
  });

  it("treats internal exec failures as gate failures", async () => {
    const internalExec = vi.fn<InternalExecClient>().mockRejectedValueOnce(new Error("timeout"));

    await expect(
      verifyThorAuthoredSha({
        internalExec,
        directory: "/workspace/repos/thor",
        sha: "abc123",
        expectedEmail: "49699333+thor[bot]@users.noreply.github.com",
      }),
    ).resolves.toEqual({ ok: false, reason: "exec_failed" });
  });
});

describe("resolvePrChecksTerminalState", () => {
  it("returns aggregate output when all PR checks are terminal", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci" },
            { name: "lint", state: "FAILURE", bucket: "fail", workflow: "ci" },
          ]),
        ),
      )
      .mockResolvedValueOnce({ stdout: "build pass\nlint fail\n", stderr: "", exitCode: 1 });

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toMatchObject({
      ok: true,
      checks: [
        { name: "build", state: "SUCCESS", bucket: "pass" },
        { name: "lint", state: "FAILURE", bucket: "fail" },
      ],
      aggregate: { command: "gh pr checks 42", stdout: "build pass\nlint fail\n", exitCode: 1 },
    });
  });

  it("treats gh bucket cancel as terminal", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "deploy", state: "CANCELLED", bucket: "cancel" }])),
      )
      .mockResolvedValueOnce({ stdout: "deploy cancel\n", stderr: "", exitCode: 1 });

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toMatchObject({
      ok: true,
      checks: [{ name: "deploy", state: "CANCELLED", bucket: "cancel" }],
      aggregate: { command: "gh pr checks 42", stdout: "deploy cancel\n", exitCode: 1 },
    });
    expect(internalExec).toHaveBeenCalledTimes(2);
  });

  it("reports pending checks when any PR check is non-terminal", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "build", state: "IN_PROGRESS", bucket: "pending" }])),
      );

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "pr_checks_pending",
      pending: [{ name: "build", state: "IN_PROGRESS", bucket: "pending" }],
    });
    expect(internalExec).toHaveBeenCalledTimes(1);
  });

  it("treats invalid JSON as lookup failure", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce({ stdout: "not-json", stderr: "bad fields", exitCode: 1 });

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "pr_checks_lookup_failed",
      stderr: "bad fields",
      exitCode: 1,
    });
  });

  it("treats malformed summary rows as lookup failure", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{}]), stderr: "bad row", exitCode: 0 });

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "pr_checks_lookup_failed",
      stderr: "bad row",
      exitCode: 0,
    });
    expect(internalExec).toHaveBeenCalledTimes(1);
  });

  it("returns lookup_failed with error details when internalExec rejects", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockRejectedValueOnce(new Error("remote-cli timeout"));

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "pr_checks_lookup_failed",
      error: "remote-cli timeout",
    });
    expect(internalExec).toHaveBeenCalledTimes(1);
  });

  it("returns lookup_failed when aggregate pr checks call rejects", async () => {
    const internalExec = vi
      .fn<InternalExecClient>()
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "build", state: "SUCCESS", bucket: "pass" }])),
      )
      .mockRejectedValueOnce(new Error("aggregate lookup failed"));

    await expect(
      resolvePrChecksTerminalState({
        internalExec,
        directory: "/workspace/repos/thor",
        prNumber: 42,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "pr_checks_lookup_failed",
      error: "aggregate lookup failed",
    });
    expect(internalExec).toHaveBeenCalledTimes(2);
  });
});
