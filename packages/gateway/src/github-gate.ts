import type { InternalExecClient } from "./service.js";

export type CheckSuiteGateFailureReason = "sha_missing" | "author_mismatch" | "exec_failed";

export type CheckSuiteGateResult =
  | { ok: true }
  | { ok: false; reason: CheckSuiteGateFailureReason };

export async function verifyThorAuthoredSha(input: {
  internalExec: InternalExecClient;
  directory: string;
  sha: string;
  expectedEmail: string;
}): Promise<CheckSuiteGateResult> {
  let exists;
  try {
    exists = await input.internalExec({
      bin: "git",
      args: ["cat-file", "-e", input.sha],
      cwd: input.directory,
    });
  } catch {
    return { ok: false, reason: "exec_failed" };
  }

  if (exists.exitCode !== 0) {
    return { ok: false, reason: "sha_missing" };
  }

  let author;
  try {
    author = await input.internalExec({
      bin: "git",
      args: ["log", "-1", "--format=%ae", input.sha],
      cwd: input.directory,
    });
  } catch {
    return { ok: false, reason: "exec_failed" };
  }

  if (author.exitCode !== 0) {
    return { ok: false, reason: "exec_failed" };
  }

  if (author.stdout.trim().toLowerCase() !== input.expectedEmail.trim().toLowerCase()) {
    return { ok: false, reason: "author_mismatch" };
  }

  return { ok: true };
}
