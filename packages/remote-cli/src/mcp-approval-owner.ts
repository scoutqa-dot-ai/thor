import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
  fstatSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** New generic records only; historical workspace approvals remain in their original location. */
export const MCP_APPROVAL_STATE_ROOT = "/var/lib/remote-cli/mcp-approvals";

/** Refuse unsafe existing directories; do not silently chmod somebody else's state. */
export function ensurePrivateApprovalDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700
  )
    throw new Error("MCP approval private directory unavailable");
}

/** Flush the file then atomic replacement then containing directory on Linux local volumes. */
export function replacePrivateApprovalJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    flushApprovalDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* Renamed or never created. */
    }
  }
}

/** Directory flush is part of each new-record and activation durability boundary. */
export function flushApprovalDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Stable lock inode stays separate from every replaceable JSON inode. */
export async function acquireApprovalFileLock(path: string): Promise<(() => void) | undefined> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600
    )
      throw new Error("MCP approval lock unavailable");
    // flock locks the inherited open file description. Parent ownership survives helper exit;
    // process death closes it. No PID files, lease recovery, shell or agent-selected executable.
    const child = spawn("/usr/bin/flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    const locked = await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
    if (!locked) {
      closeSync(fd);
      return undefined;
    }
    fsyncSync(fd);
    flushApprovalDirectory(dirname(path));
    const owned = fd;
    return () => closeSync(owned);
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

/** Lifetime owner capability: only acquisition may mint an activation, after the kernel fence. */
export class McpApprovalOwner {
  private released = false;
  private constructor(
    readonly root: string,
    readonly activationId: string,
    private readonly unlock: () => void,
  ) {}
  /** Fail second startup before writing activation.json, including byte-identical catalogs. */
  static async acquire(
    root = MCP_APPROVAL_STATE_ROOT,
  ): Promise<
    | { ok: true; value: McpApprovalOwner }
    | { ok: false; reason: "mcp_approval_state_owned_or_unavailable" }
  > {
    let release: (() => void) | undefined;
    try {
      ensurePrivateApprovalDirectory(root);
      release = await acquireApprovalFileLock(join(root, "owner.lock"));
      if (!release) return { ok: false, reason: "mcp_approval_state_owned_or_unavailable" };
      const activationId = randomUUID();
      replacePrivateApprovalJson(join(root, "activation.json"), { version: 1, activationId });
      return { ok: true, value: new McpApprovalOwner(root, activationId, release) };
    } catch {
      release?.();
      return { ok: false, reason: "mcp_approval_state_owned_or_unavailable" };
    }
  }
  /** Release only after all dispatch/result windows and upstream shutdown have settled. */
  release(): void {
    if (!this.released) {
      this.released = true;
      this.unlock();
    }
  }
}
