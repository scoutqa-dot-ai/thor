import { realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { envString, type EnvSource } from "./env.js";

export const WORKSPACE_REPOS_ROOT = "/workspace/repos";
export const WORKSPACE_WORKTREES_ROOT = "/workspace/worktrees";
export const THOR_WORKTREES_ROOT_ENV = "THOR_WORKTREES_ROOT";

export function getWorkspaceWorktreesRoot(env: EnvSource = process.env): string {
  return envString(env, THOR_WORKTREES_ROOT_ENV, WORKSPACE_WORKTREES_ROOT);
}

export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isPathWithinPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

export function realpathOrNull(candidate: string): string | null {
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

export async function resolveExistingDirectoryWithinRoot(
  root: string,
  relativePath: string,
): Promise<string | null> {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!isPathWithin(resolvedRoot, candidate)) return null;

  try {
    const entry = await stat(candidate);
    if (!entry.isDirectory()) return null;
    const realRoot = await realpath(resolvedRoot);
    const realCandidate = await realpath(candidate);
    if (!isPathWithin(realRoot, realCandidate)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}
