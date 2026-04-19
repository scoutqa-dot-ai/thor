import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { execCommand } from "./exec.js";

export interface ExecStreamCallbacks {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

const DAYTONA_DEFAULT_API_URL = "https://app.daytona.io/api";
const DAYTONA_DEFAULT_SNAPSHOT = "thor-sandbox-base";
const DAYTONA_REPO_DIR = "/workspace/repo";
const SANDBOX_SYNC_BUNDLE_PATH = "/tmp/sync.bundle";

export const THOR_MANAGED_LABEL = "thor-managed";
export const THOR_CWD_LABEL = "thor-cwd";
export const THOR_BRANCH_LABEL = "thor-branch";
export const THOR_SHA_LABEL = "thor-sha";

let daytonaSingleton: Daytona | null = null;
const cwdLocks = new Map<string, Promise<void>>();

export function withCwdLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = cwdLocks.get(cwd) ?? Promise.resolve();
  const next = prev.then(() => fn());
  const guard = next.then(
    () => {},
    () => {},
  );
  cwdLocks.set(cwd, guard);
  void guard.finally(() => {
    if (cwdLocks.get(cwd) === guard) cwdLocks.delete(cwd);
  });
  return next;
}

export class SandboxError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly adminDetail: string,
    options?: { cause?: unknown },
  ) {
    super(adminDetail, options);
    this.name = "SandboxError";
  }
}

function getDaytona(): Daytona {
  if (daytonaSingleton) {
    return daytonaSingleton;
  }

  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new SandboxError(
      "Sandbox auth failed, check DAYTONA_API_KEY",
      "DAYTONA_API_KEY is not configured",
    );
  }

  daytonaSingleton = new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL || DAYTONA_DEFAULT_API_URL,
  });
  return daytonaSingleton;
}

export async function createSandbox(
  name: string,
  cwd: string,
  sha: string,
  labels: Record<string, string>,
): Promise<Sandbox> {
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await getDaytona().create({
      name,
      snapshot: process.env.DAYTONA_SNAPSHOT || DAYTONA_DEFAULT_SNAPSHOT,
      ephemeral: true,
      autoStopInterval: 15,
      labels,
    });

    await bundleAndUpload(sandbox, cwd, "HEAD", sha);

    return sandbox;
  } catch (err) {
    if (sandbox) {
      await safeDeleteSandbox(sandbox);
    }
    throw toSandboxError(err, "Failed to initialize code in sandbox");
  }
}

export async function syncSandbox(
  sandboxId: string,
  cwd: string,
  lastSha: string | null,
  currentSha: string,
): Promise<void> {
  if (lastSha === currentSha) {
    return;
  }

  const sandbox = await getSandboxById(sandboxId);

  if (lastSha) {
    try {
      // Try delta bundle (works for forward commits on the same branch)
      await bundleAndUpload(sandbox, cwd, `${lastSha}..HEAD`, currentSha);
    } catch {
      // Fall back to full bundle (handles backward reset, unrelated branch, empty range)
      await bundleAndUpload(sandbox, cwd, "HEAD", currentSha);
    }
  } else {
    await bundleAndUpload(sandbox, cwd, "HEAD", currentSha);
  }

  await sandbox.setLabels({
    ...sandbox.labels,
    [THOR_SHA_LABEL]: currentSha,
  });
}

async function bundleAndUpload(
  sandbox: Sandbox,
  cwd: string,
  bundleRange: string,
  targetSha: string,
): Promise<void> {
  const localBundlePath = join(tmpdir(), `thor-${sandbox.id}-${randomUUID()}.bundle`);

  try {
    const bundleResult = await execCommand(
      "git",
      ["bundle", "create", localBundlePath, bundleRange],
      cwd,
    );

    if ((bundleResult.exitCode ?? 0) !== 0) {
      throw new SandboxError(
        "Failed to prepare code sync",
        `git bundle create failed: ${bundleResult.stderr || bundleResult.stdout}`,
      );
    }

    await sandbox.fs.uploadFile(localBundlePath, SANDBOX_SYNC_BUNDLE_PATH);

    const repoDir = shellQuote(DAYTONA_REPO_DIR);
    const bundlePath = shellQuote(SANDBOX_SYNC_BUNDLE_PATH);
    const resetCmd = [
      "set -e",
      `sudo mkdir -p ${repoDir}`,
      `sudo chown $(whoami) ${repoDir}`,
      `cd ${repoDir}`,
      "if [ ! -d .git ]; then git init; fi",
      `git bundle unbundle ${bundlePath}`,
      `git reset --hard ${shellQuote(targetSha)}`,
      `rm -f ${bundlePath}`,
    ].join(" && ");

    const execResult = await sandbox.process.executeCommand(resetCmd);
    if (execResult.exitCode !== 0) {
      throw new SandboxError(
        "Failed to sync code to sandbox",
        `sandbox unbundle/reset failed: ${execResult.result}`,
      );
    }
  } catch (err) {
    throw toSandboxError(err, "Failed to upload code to sandbox");
  } finally {
    await rm(localBundlePath, { force: true }).catch(() => {});
  }
}

export async function execInSandboxStream(
  sandboxId: string,
  command: string,
  callbacks: ExecStreamCallbacks,
): Promise<number> {
  const sandbox = await getSandboxById(sandboxId);
  const sessionId = `thor-exec-${randomUUID()}`;

  try {
    await sandbox.process.createSession(sessionId);

    const response = await sandbox.process.executeSessionCommand(sessionId, {
      command: `cd ${shellQuote(DAYTONA_REPO_DIR)} && ${command}`,
      runAsync: true,
    });

    const cmdId = response.cmdId;

    // Stream logs until the command completes
    await sandbox.process.getSessionCommandLogs(
      sessionId,
      cmdId,
      callbacks.onStdout,
      callbacks.onStderr,
    );

    // Retrieve exit code after streaming finishes
    const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
    return cmd.exitCode ?? 1;
  } finally {
    await sandbox.process.deleteSession(sessionId).catch(() => {});
  }
}

export async function deleteSandbox(sandboxId: string): Promise<void> {
  try {
    const sandbox = await getDaytona().get(sandboxId);
    await sandbox.delete();
  } catch (err) {
    if (isNotFoundError(err)) {
      return;
    }
    throw toSandboxError(err, "Sandbox service error");
  }
}

export async function findSandboxForCwd(cwd: string): Promise<Sandbox | null> {
  const sandboxes = await listSandboxesByLabels({
    [THOR_MANAGED_LABEL]: "true",
    [THOR_CWD_LABEL]: cwd,
  });

  return sandboxes[0] || null;
}

export async function listSandboxes(): Promise<Sandbox[]> {
  return listSandboxesByLabels({ [THOR_MANAGED_LABEL]: "true" });
}

export function getLastSyncedSha(sandbox: Sandbox): string | null {
  const sha = sandbox.labels?.[THOR_SHA_LABEL];
  return sha || null;
}

async function listSandboxesByLabels(labels: Record<string, string>): Promise<Sandbox[]> {
  try {
    const page = await getDaytona().list(labels, 1, 100);
    return page.items || [];
  } catch (err) {
    throw toSandboxError(err, "Sandbox service unavailable");
  }
}

async function getSandboxById(sandboxId: string): Promise<Sandbox> {
  try {
    return await getDaytona().get(sandboxId);
  } catch (err) {
    throw toSandboxError(err, "Sandbox service unavailable");
  }
}

async function safeDeleteSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.delete();
  } catch {
    // Best effort cleanup
  }
}

function toSandboxError(err: unknown, fallbackUserMessage: string): SandboxError {
  if (err instanceof SandboxError) {
    return err;
  }

  const adminDetail = err instanceof Error ? err.message : String(err);
  const lower = adminDetail.toLowerCase();

  if (lower.includes("auth") || lower.includes("401") || lower.includes("403")) {
    return new SandboxError(
      "Sandbox auth failed, check DAYTONA_API_KEY",
      adminDetail,
      err instanceof Error ? { cause: err } : undefined,
    );
  }

  if (lower.includes("timeout")) {
    return new SandboxError(
      "Sandbox creation timed out",
      adminDetail,
      err instanceof Error ? { cause: err } : undefined,
    );
  }

  return new SandboxError(
    fallbackUserMessage,
    adminDetail,
    err instanceof Error ? { cause: err } : undefined,
  );
}

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("not found") || message.includes("404");
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export const _testing = {
  resetDaytona(): void {
    daytonaSingleton = null;
  },
  resetCwdLocks(): void {
    cwdLocks.clear();
  },
};
