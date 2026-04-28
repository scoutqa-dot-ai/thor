import { describe, expect, it, vi } from "vitest";
import { verifyThorAuthoredSha } from "./github-gate.js";
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
