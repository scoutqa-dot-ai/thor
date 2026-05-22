import type { InternalExecClient } from "./service.js";

export type CheckSuiteGateFailureReason = "sha_missing" | "author_mismatch" | "exec_failed";

export type CheckSuiteGateResult =
  | { ok: true }
  | { ok: false; reason: CheckSuiteGateFailureReason };

export interface PrCheckSummary {
  name?: string;
  state?: string;
  bucket?: string;
  link?: string;
  description?: string;
  workflow?: string;
}

export interface PrChecksAggregateOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type PrChecksTerminalStateResult =
  | { ok: true; checks: PrCheckSummary[]; aggregate: PrChecksAggregateOutput }
  | { ok: false; reason: "pr_checks_pending"; pending: PrCheckSummary[]; checks: PrCheckSummary[] }
  | {
      ok: false;
      reason: "pr_checks_lookup_failed";
      error?: string;
      stderr?: string;
      exitCode?: number;
    };

const TERMINAL_BUCKETS = new Set(["pass", "fail", "skipping", "cancel"]);
const PENDING_STATES = new Set([
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const TERMINAL_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "COMPLETED",
  "ERROR",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "SUCCESS",
  "TIMED_OUT",
]);

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePrCheckSummaries(stdout: string): PrCheckSummary[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((row) => {
    const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      name: normalizeOptionalString(obj.name),
      state: normalizeOptionalString(obj.state),
      bucket: normalizeOptionalString(obj.bucket),
      link: normalizeOptionalString(obj.link),
      description: normalizeOptionalString(obj.description),
      workflow: normalizeOptionalString(obj.workflow),
    };
  });
}

function isTerminalPrCheck(check: PrCheckSummary): boolean {
  const bucket = check.bucket?.trim().toLowerCase();
  if (bucket) return TERMINAL_BUCKETS.has(bucket);

  const state = check.state?.trim().toUpperCase();
  if (!state) return false;
  if (PENDING_STATES.has(state)) return false;
  return TERMINAL_STATES.has(state);
}

export async function resolvePrChecksTerminalState(input: {
  internalExec: InternalExecClient;
  directory: string;
  prNumber: number;
}): Promise<PrChecksTerminalStateResult> {
  const jsonCommand = `gh pr checks ${input.prNumber} --json name,state,bucket,link,description,workflow`;
  let jsonResult;
  try {
    jsonResult = await input.internalExec({
      bin: "gh",
      args: [
        "pr",
        "checks",
        String(input.prNumber),
        "--json",
        "name,state,bucket,link,description,workflow",
      ],
      cwd: input.directory,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "pr_checks_lookup_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const checks = parsePrCheckSummaries(jsonResult.stdout);
  if (!checks) {
    return {
      ok: false,
      reason: "pr_checks_lookup_failed",
      stderr: jsonResult.stderr,
      exitCode: jsonResult.exitCode,
    };
  }

  const pending = checks.filter((check) => !isTerminalPrCheck(check));
  if (pending.length > 0) {
    return { ok: false, reason: "pr_checks_pending", pending, checks };
  }

  const aggregateCommand = `gh pr checks ${input.prNumber}`;
  let aggregate;
  try {
    aggregate = await input.internalExec({
      bin: "gh",
      args: ["pr", "checks", String(input.prNumber)],
      cwd: input.directory,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "pr_checks_lookup_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    checks,
    aggregate: {
      command: aggregateCommand,
      stdout: aggregate.stdout,
      stderr: aggregate.stderr,
      exitCode: aggregate.exitCode,
    },
  };
}

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
