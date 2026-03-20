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

const SANDBOX_WORKDIR = "/home/daytona";

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

  // Exclude .git — worktrees have a pointer file referencing the host's git dir
  // which doesn't exist in the sandbox. We init a standalone repo instead.
  const tarball = await createTarball(worktreePath, [], ["--exclude", ".git"]);
  if (tarball.length === 0) {
    logInfo(log, "sync_in_empty_worktree", { sandboxId });
    return;
  }

  await provider.uploadFile(sandboxId, `${SANDBOX_WORKDIR}/source.tar.gz`, tarball);
  const { exitCode: extractExit, result: extractOutput } = await provider.executeCommand(
    sandboxId,
    [
      `mkdir -p ${SANDBOX_WORKDIR}/src`,
      `tar -xzf ${SANDBOX_WORKDIR}/source.tar.gz -C ${SANDBOX_WORKDIR}/src`,
      `rm ${SANDBOX_WORKDIR}/source.tar.gz`,
      `cd ${SANDBOX_WORKDIR}/src && git init && git add -A && git commit -m sync --allow-empty`,
    ].join(" && ") + " 2>&1",
  );
  if (extractExit !== 0) {
    logError(log, "sync_in_full_extract_failed", {
      sandboxId,
      exitCode: extractExit,
      output: extractOutput,
    });
    throw new Error(
      `syncIn full extract failed in sandbox ${sandboxId} (exit ${extractExit}): ${extractOutput}`,
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

  const { changed, deleted } = await getLocalChanges(worktreePath);

  if (changed.length === 0 && deleted.length === 0) {
    logInfo(log, "sync_in_partial_no_changes", { sandboxId });
    return;
  }

  logInfo(log, "sync_in_partial_files", { sandboxId, changed, deleted });

  // Upload and extract changed/new files
  if (changed.length > 0) {
    const tarball = await createTarball(worktreePath, changed);
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
  }

  // Remove deleted files in sandbox
  if (deleted.length > 0) {
    const rmArgs = deleted.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
    await provider.executeCommand(sandboxId, `cd ${SANDBOX_WORKDIR}/src && rm -f -- ${rmArgs}`);
  }

  // Re-snapshot so sandbox HEAD stays current for next syncOut
  await provider.executeCommand(
    sandboxId,
    `cd ${SANDBOX_WORKDIR}/src && git add -A && git commit -m sync --allow-empty`,
  );

  logInfo(log, "sync_in_partial_done", {
    sandboxId,
    filesChanged: changed.length,
    filesDeleted: deleted.length,
  });
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

  const deletedFiles = parseDeletedFiles(statusOutput);
  const deletedSet = new Set(deletedFiles);

  // Filter deleted files out of the download list — git diff includes deletions
  const changedFiles = parseFileList(diffOutput)
    .filter((f) => !deletedSet.has(f))
    .concat(parseFileList(untrackedOutput));

  logInfo(log, "sync_out_files", { sandboxId, changed: changedFiles, deleted: deletedFiles });

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
function createTarball(cwd: string, files: string[], extraArgs: string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-czf", "-", ...extraArgs, "-C", cwd, "--"];
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

/** Get changed/new files and deleted files separately via git. */
function getLocalChanges(worktreePath: string): Promise<{ changed: string[]; deleted: string[] }> {
  return new Promise((resolve, reject) => {
    // --diff-filter=d (lowercase) excludes deletions; =D (uppercase) selects only deletions
    const script = [
      "echo '---CHANGED---'",
      "git diff --name-only --diff-filter=d HEAD 2>/dev/null",
      "git ls-files --others --exclude-standard 2>/dev/null",
      "echo '---DELETED---'",
      "git diff --name-only --diff-filter=D HEAD 2>/dev/null",
    ].join("; ");

    execFile("sh", ["-c", script], { cwd: worktreePath }, (err, stdout) => {
      if (err) return reject(err);
      const sections = stdout.split("---DELETED---");
      const changedSection = (sections[0] ?? "").replace("---CHANGED---", "");
      const deletedSection = sections[1] ?? "";
      resolve({
        changed: parseFileList(changedSection),
        deleted: parseFileList(deletedSection),
      });
    });
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
