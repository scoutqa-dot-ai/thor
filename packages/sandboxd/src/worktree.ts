import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";

import { getRemoteWorkspaceDir } from "@thor/common";

const CONTAINER_WORKTREE_PREFIX = "/workspace/worktrees/";

export interface WorktreeContext {
  cwd: string;
  worktreePath: string;
  focusPath?: string;
  repo?: string;
  branch?: string;
}

export interface WorktreeMetadata {
  repo?: string;
  branch?: string;
}

export function resolveWorktreeContext(cwd: string): WorktreeContext {
  if (!cwd) {
    throw new Error("cwd is required");
  }

  const absoluteCwd = normalizePath(cwd);
  const worktreePath = findGitRoot(absoluteCwd);

  if (absoluteCwd.startsWith("/workspace") && !worktreePath.startsWith(CONTAINER_WORKTREE_PREFIX)) {
    throw new Error("coder must be run from inside /workspace/worktrees/...");
  }

  const focusPath = toPosixRelativePath(relative(worktreePath, absoluteCwd));
  return {
    cwd: absoluteCwd,
    worktreePath,
    focusPath: focusPath || undefined,
    ...parseWorktreeMetadata(worktreePath),
  };
}

export function parseWorktreeMetadata(worktreePath: string): WorktreeMetadata {
  if (!worktreePath.startsWith(CONTAINER_WORKTREE_PREFIX)) {
    return {
      repo: basename(worktreePath),
    };
  }

  const segments = worktreePath.slice(CONTAINER_WORKTREE_PREFIX.length).split("/").filter(Boolean);

  if (segments.length === 0) {
    return {};
  }

  const [repo, ...branchSegments] = segments;
  return {
    repo,
    branch: branchSegments.length > 0 ? branchSegments.join("/") : undefined,
  };
}

export function getRemoteExecutionDir(context: WorktreeContext): string {
  const remoteWorkspaceDir = getRemoteWorkspaceDir(context.worktreePath);
  if (!context.focusPath) {
    return remoteWorkspaceDir;
  }

  return posix.join(remoteWorkspaceDir, ...context.focusPath.split("/"));
}

function findGitRoot(startPath: string): string {
  let current = startPath;

  while (true) {
    if (isGitMarker(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No git worktree found for ${startPath}`);
    }

    current = parent;
  }
}

function isGitMarker(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(inputPath: string): string {
  try {
    return realpathSync(resolve(inputPath));
  } catch {
    return resolve(inputPath);
  }
}

function toPosixRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === ".") {
    return "";
  }

  return relativePath.split(sep).join(posix.sep);
}
