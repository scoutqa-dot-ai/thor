/**
 * Source sync — transfer worktree state to/from Daytona sandboxes.
 *
 * syncIn:  worktree → sandbox (tar upload, git-diff partial on repeat)
 * syncOut: sandbox → worktree (download changed files, handle deletes)
 *
 * See plan decisions D3 (tar, no git creds), D14 (fail loud), D15 (git-diff partial).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-sync");

const SANDBOX_WORKDIR = "/home/daytona/workspace";

/** Track which sandboxes have had their first sync (for git-diff partial). */
const syncedSandboxes = new Set<string>();

// ── syncIn ──────────────────────────────────────────────────────────────────

export async function syncIn(
  provider: SandboxProvider,
  sandboxId: string,
  worktreePath: string,
): Promise<void> {
  const isRepeat = syncedSandboxes.has(sandboxId);

  if (isRepeat) {
    await syncInPartial(provider, sandboxId, worktreePath);
  } else {
    await syncInFull(provider, sandboxId, worktreePath);
    syncedSandboxes.add(sandboxId);
  }
}

/** Full tar sync — used on first call for a sandbox. */
async function syncInFull(
  provider: SandboxProvider,
  sandboxId: string,
  worktreePath: string,
): Promise<void> {
  logInfo(log, "sync_in_full", { sandboxId, worktreePath });

  // Handle empty worktree: check if there are any files
  const tarball = await createTarball(worktreePath, []);
  if (tarball.length === 0) {
    logInfo(log, "sync_in_empty_worktree", { sandboxId });
    return;
  }

  await provider.uploadFile(sandboxId, `${SANDBOX_WORKDIR}/source.tar.gz`, tarball);
  const { exitCode: extractExit } = await provider.executeCommand(
    sandboxId,
    `mkdir -p ${SANDBOX_WORKDIR}/src && tar -xzf ${SANDBOX_WORKDIR}/source.tar.gz -C ${SANDBOX_WORKDIR}/src && rm ${SANDBOX_WORKDIR}/source.tar.gz`,
  );
  if (extractExit !== 0) {
    throw new Error(
      `syncIn full extract failed in sandbox ${sandboxId} with exit code ${extractExit}`,
    );
  }

  logInfo(log, "sync_in_full_done", { sandboxId, bytes: tarball.length });
}

/** Git-diff partial sync — only changed/new files since last sync (D15). */
async function syncInPartial(
  provider: SandboxProvider,
  sandboxId: string,
  worktreePath: string,
): Promise<void> {
  logInfo(log, "sync_in_partial", { sandboxId, worktreePath });

  // Get changed tracked files + untracked files
  const changedFiles = await getChangedFiles(worktreePath);
  if (changedFiles.length === 0) {
    logInfo(log, "sync_in_partial_no_changes", { sandboxId });
    return;
  }

  const tarball = await createTarball(worktreePath, changedFiles);
  await provider.uploadFile(sandboxId, `${SANDBOX_WORKDIR}/patch.tar.gz`, tarball);
  const { exitCode: patchExit } = await provider.executeCommand(
    sandboxId,
    `tar -xzf ${SANDBOX_WORKDIR}/patch.tar.gz -C ${SANDBOX_WORKDIR}/src && rm ${SANDBOX_WORKDIR}/patch.tar.gz`,
  );
  if (patchExit !== 0) {
    throw new Error(
      `syncIn partial extract failed in sandbox ${sandboxId} with exit code ${patchExit}`,
    );
  }

  logInfo(log, "sync_in_partial_done", { sandboxId, files: changedFiles.length });
}

// ── syncOut ─────────────────────────────────────────────────────────────────

export interface SyncOutResult {
  filesChanged: number;
  filesDeleted: number;
}

export async function syncOut(
  provider: SandboxProvider,
  sandboxId: string,
  worktreePath: string,
): Promise<SyncOutResult> {
  logInfo(log, "sync_out", { sandboxId, worktreePath });

  // Get list of changed files in sandbox
  const { exitCode: diffExit, result: diffOutput } = await provider.executeCommand(
    sandboxId,
    "git diff --name-only HEAD",
    `${SANDBOX_WORKDIR}/src`,
  );

  if (diffExit !== 0) {
    throw new Error(`git diff failed in sandbox ${sandboxId} with exit code ${diffExit}`);
  }

  // Get untracked files
  const { exitCode: untrackedExit, result: untrackedOutput } = await provider.executeCommand(
    sandboxId,
    "git ls-files --others --exclude-standard",
    `${SANDBOX_WORKDIR}/src`,
  );
  if (untrackedExit !== 0) {
    throw new Error(`git ls-files failed in sandbox ${sandboxId} with exit code ${untrackedExit}`);
  }

  // Get deleted files
  const { exitCode: statusExit, result: statusOutput } = await provider.executeCommand(
    sandboxId,
    "git status --porcelain",
    `${SANDBOX_WORKDIR}/src`,
  );
  if (statusExit !== 0) {
    throw new Error(`git status failed in sandbox ${sandboxId} with exit code ${statusExit}`);
  }

  const changedFiles = parseFileList(diffOutput).concat(parseFileList(untrackedOutput));
  const deletedFiles = parseDeletedFiles(statusOutput);

  // Download changed files
  let filesChanged = 0;
  for (const file of changedFiles) {
    try {
      const localPath = safeResolvePath(worktreePath, file);
      const data = await provider.downloadFile(sandboxId, `${SANDBOX_WORKDIR}/src/${file}`);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, data);
      filesChanged++;
    } catch (err) {
      logError(log, "sync_out_download_error", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // D14: fail loud
    }
  }

  // Delete files that were removed in sandbox
  let filesDeleted = 0;
  for (const file of deletedFiles) {
    const localPath = safeResolvePath(worktreePath, file);
    if (existsSync(localPath)) {
      unlinkSync(localPath);
      filesDeleted++;
    }
  }

  logInfo(log, "sync_out_done", { sandboxId, filesChanged, filesDeleted });
  return { filesChanged, filesDeleted };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a gzipped tarball of the worktree (or specific files). */
function createTarball(cwd: string, files: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-czf", "-", "-C", cwd, "--"];
    if (files.length > 0) {
      args.push(...files);
    } else {
      args.push(".");
    }

    const child = execFile("tar", args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(Buffer.from(stdout, "binary"));
    });

    // Set encoding to binary for tar output
    child.stdout?.setEncoding("binary");
  });
}

/** Get changed tracked + new untracked files via git. */
function getChangedFiles(worktreePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // Combine: modified/staged files + untracked files
    execFile(
      "sh",
      [
        "-c",
        "git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
      ],
      { cwd: worktreePath },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFileList(stdout));
      },
    );
  });
}

/** Resolve a file path and verify it stays within the worktree boundary. */
function safeResolvePath(worktreePath: string, file: string): string {
  const resolved = resolve(worktreePath, file);
  const normalizedBase = resolve(worktreePath);
  if (!resolved.startsWith(normalizedBase + "/") && resolved !== normalizedBase) {
    throw new Error(`path traversal detected: "${file}" resolves outside worktree`);
  }
  return resolved;
}

/** Parse newline-separated file list, filtering empties. */
function parseFileList(output: string): string[] {
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/** Parse "git status --porcelain" output for deleted files (lines starting with " D" or "D "). */
function parseDeletedFiles(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /^\s*D\s/.test(line) || /^D\s/.test(line))
    .map((line) => line.slice(3).trim())
    .filter((f) => f.length > 0);
}

/** Mark a sandbox as needing full sync on next syncIn (e.g. after error). */
export function resetSyncState(sandboxId: string): void {
  syncedSandboxes.delete(sandboxId);
}
