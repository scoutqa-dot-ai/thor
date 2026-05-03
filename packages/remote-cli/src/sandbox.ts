import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { rm, unlink, mkdir, stat } from "node:fs/promises";
import { Daytona, type FileUpload, type Sandbox } from "@daytonaio/sdk";
import { execCommand } from "./exec.js";
import { loadDaytonaEnv } from "@thor/common";

export interface ExecStreamCallbacks {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

const DAYTONA_REPO_DIR = "/workspace/sandbox";
const SANDBOX_SYNC_BUNDLE_PATH = "/tmp/sync.bundle";

export const THOR_MANAGED_LABEL = "thor-managed";
export const THOR_CWD_LABEL = "thor-cwd";
export const THOR_SHA_LABEL = "thor-sha";

let daytonaSingleton: Daytona | null = null;
let daytonaEnv: ReturnType<typeof loadDaytonaEnv> | null = null;
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

function getDaytonaEnv(): ReturnType<typeof loadDaytonaEnv> {
  if (daytonaEnv) return daytonaEnv;

  try {
    daytonaEnv = loadDaytonaEnv();
    return daytonaEnv;
  } catch {
    throw new SandboxError(
      "Sandbox auth failed, check DAYTONA_API_KEY",
      "DAYTONA_API_KEY is not configured",
    );
  }
}

function getDaytona(): Daytona {
  if (daytonaSingleton) {
    return daytonaSingleton;
  }

  const config = getDaytonaEnv();
  daytonaSingleton = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
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
    const config = getDaytonaEnv();
    sandbox = await getDaytona().create({
      name,
      snapshot: config.snapshot,
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

export const DIRTY_FILE_LIMIT = 100;
export const FILE_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB

export interface OverlayResult {
  pushed: string[];
  deleted: string[];
}

/**
 * Parse `git status --porcelain -z` (NUL-delimited) output into upload/delete lists.
 * NUL format avoids quoting issues with special characters in filenames.
 * For renames, the old path goes to deletes and the new path to uploads.
 * For copies, only the new path is uploaded.
 */
function parseGitStatus(stdout: string): { uploads: string[]; deletes: string[] } {
  const entries = stdout.split("\0").filter((e) => e.length > 0);
  const uploads: string[] = [];
  const deletes: string[] = [];

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const statusCode = entry.substring(0, 2);
    const filePath = entry.substring(3);
    const isRename = statusCode.includes("R");
    const isCopy = statusCode.includes("C");

    if (statusCode[1] === "D" || (statusCode[0] === "D" && statusCode[1] === " ")) {
      deletes.push(filePath);
    } else if (isRename || isCopy) {
      // In porcelain -z format, the current path is the target/new path and the
      // following NUL-delimited entry is the source/original path.
      uploads.push(filePath);
      i++;
      if (isRename && i < entries.length) {
        deletes.push(entries[i]);
      }
    } else {
      uploads.push(filePath);
    }
    i++;
  }

  return { uploads, deletes };
}

/**
 * Uploads modified/added files and deletes removed files in the sandbox
 * to match the local worktree's uncommitted state. Returns the set of
 * files touched so pullSandboxChanges can skip them.
 */
export async function overlayDirtyFiles(sandboxId: string, cwd: string): Promise<OverlayResult> {
  const gitStatus = await execCommand("git", ["status", "--porcelain", "-uall", "-z"], cwd);
  if ((gitStatus.exitCode ?? 0) !== 0) {
    throw new SandboxError(
      "Failed to inspect worktree state",
      `git status failed: ${gitStatus.stderr || gitStatus.stdout}`,
    );
  }

  const { uploads, deletes } = parseGitStatus(gitStatus.stdout);
  const total = uploads.length + deletes.length;

  if (total === 0) return { pushed: [], deleted: [] };

  if (total > DIRTY_FILE_LIMIT) {
    throw new SandboxError(
      `${total} dirty files exceeds the ${DIRTY_FILE_LIMIT}-file sync limit. ` +
        `Commit or stash your changes (git stash), add unneeded files to .gitignore, ` +
        `or clean up the worktree before running sandbox commands.`,
      `overlay rejected: ${total} dirty files (limit ${DIRTY_FILE_LIMIT})`,
    );
  }

  // Reject files exceeding size limit
  for (const f of uploads) {
    const fileStat = await stat(join(cwd, f)).catch(() => null);
    if (fileStat && fileStat.size > FILE_SIZE_LIMIT) {
      const sizeMB = Math.round(fileStat.size / 1024 / 1024);
      throw new SandboxError(
        `File "${f}" is ${sizeMB} MB, exceeding the 100 MB sync limit. ` +
          `Commit it first (git add "${f}" && git commit), add it to .gitignore, ` +
          `or remove it from the worktree.`,
        `overlay rejected: ${f} is ${fileStat.size} bytes (limit ${FILE_SIZE_LIMIT})`,
      );
    }
  }

  const sandbox = await getSandboxById(sandboxId);

  if (uploads.length > 0) {
    const fileUploads: FileUpload[] = uploads.map((f) => ({
      source: join(cwd, f),
      destination: join(DAYTONA_REPO_DIR, f),
    }));
    await sandbox.fs.uploadFiles(fileUploads);
  }

  for (const filePath of deletes) {
    await sandbox.fs.deleteFile(join(DAYTONA_REPO_DIR, filePath)).catch(() => {});
  }

  return { pushed: uploads, deleted: deletes };
}

/**
 * Pulls changes made inside the sandbox back to the local worktree.
 * Downloads all files that differ from the sandbox's committed HEAD —
 * this includes both overlay files modified by the exec (e.g. prettier
 * reformatting a pushed file) and new files the exec created.
 */
export async function pullSandboxChanges(
  sandboxId: string,
  cwd: string,
): Promise<{ pulled: string[]; deleted: string[] }> {
  const sandbox = await getSandboxById(sandboxId);

  const statusResult = await sandbox.process.executeCommand(
    `cd ${shellQuote(DAYTONA_REPO_DIR)} && git status --porcelain -uall -z`,
  );
  if (statusResult.exitCode !== 0) {
    throw new SandboxError(
      "Failed to read sandbox state after exec. No files were pulled back.",
      `sandbox git status failed: ${statusResult.result || "unknown error"}`,
    );
  }

  const { uploads: downloads, deletes: localDeletes } = parseGitStatus(statusResult.result || "");
  const total = downloads.length + localDeletes.length;

  if (total === 0) return { pulled: [], deleted: [] };

  if (total > DIRTY_FILE_LIMIT) {
    throw new SandboxError(
      `Sandbox has ${total} changed files, exceeding the ${DIRTY_FILE_LIMIT}-file sync limit. ` +
        `Add build artifacts to .gitignore or clean up before the command exits.`,
      `pull rejected: ${total} changed files (limit ${DIRTY_FILE_LIMIT})`,
    );
  }

  // Validate paths — canonical prefix check to prevent traversal
  const resolvedCwd = resolve(cwd);
  const cwdPrefix = resolvedCwd + sep;
  const allPaths = [...downloads, ...localDeletes];
  for (const f of allPaths) {
    if (!resolve(cwd, f).startsWith(cwdPrefix)) {
      throw new SandboxError(
        `Sandbox produced a file path that escapes the worktree ("${f}"). Pull aborted.`,
        `pull rejected: path traversal detected in "${f}"`,
      );
    }
  }

  if (downloads.length > 0) {
    // Check file sizes inside the sandbox before downloading
    const sizeCheck = await sandbox.process.executeCommand(
      `cd ${shellQuote(DAYTONA_REPO_DIR)} && stat -c '%s %n' ${downloads.map((f) => shellQuote(f)).join(" ")} 2>/dev/null`,
    );
    if (sizeCheck.exitCode === 0 && sizeCheck.result) {
      for (const line of sizeCheck.result.split("\n")) {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (match && Number(match[1]) > FILE_SIZE_LIMIT) {
          const sizeMB = Math.round(Number(match[1]) / 1024 / 1024);
          throw new SandboxError(
            `Sandbox file "${match[2]}" is ${sizeMB} MB, exceeding the 100 MB sync limit. ` +
              `Add it to .gitignore or delete it before the command exits.`,
            `pull rejected: ${match[2]} is ${match[1]} bytes (limit ${FILE_SIZE_LIMIT})`,
          );
        }
      }
    }

    const dirs = new Set(downloads.map((f) => dirname(join(cwd, f))));
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true }).catch(() => {});
    }

    await sandbox.fs.downloadFiles(
      downloads.map((f) => ({
        source: join(DAYTONA_REPO_DIR, f),
        destination: join(cwd, f),
      })),
    );
  }

  for (const filePath of localDeletes) {
    await unlink(join(cwd, filePath)).catch(() => {});
  }

  return { pulled: downloads, deleted: localDeletes };
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
      `mkdir -p ${repoDir}`,
      `cd ${repoDir}`,
      "if [ ! -d .git ]; then git init; fi",
      `git bundle unbundle ${bundlePath}`,
      `git reset --hard ${shellQuote(targetSha)}`,
      `git checkout --detach`,
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
  parseGitStatus,
  resetDaytona(): void {
    daytonaSingleton = null;
    daytonaEnv = null;
  },
  resetCwdLocks(): void {
    cwdLocks.clear();
  },
};
