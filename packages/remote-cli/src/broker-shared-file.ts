import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isPathWithin } from "@thor/common";

function openSharedRegularFile(
  path: string,
  allowedRoots: readonly string[],
  maxBytes: number,
): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = realpathSync(`/proc/self/fd/${fd}`);
    const stat = fstatSync(fd);
    if (
      !allowedRoots.some((root) => isPathWithin(root, actual)) ||
      !stat.isFile() ||
      stat.size > maxBytes
    ) {
      closeSync(fd);
      return undefined;
    }
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

/** Pin a shared regular file and check its opened inode's path, not a raceable pre-open symlink. */
export function readBrokerSharedFile(
  path: string,
  allowedRoots: readonly string[],
  maxBytes: number,
): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  const fd = openSharedRegularFile(path, allowedRoots, maxBytes);
  if (fd === undefined) return { ok: false };
  try {
    const raw = readFileSync(fd, "utf8");
    return Buffer.byteLength(raw) <= maxBytes ? { ok: true, value: raw } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    closeSync(fd);
  }
}

/** Keep verified file descriptors alive through SDK uploads; paths cannot be swapped to broker secrets. */
export async function withBrokerSharedFiles<T>(
  paths: readonly string[],
  allowedRoots: readonly string[],
  maxBytes: number,
  consume: (pinnedPaths: string[]) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  const descriptors: number[] = [];
  try {
    for (const path of paths) {
      const fd = openSharedRegularFile(path, allowedRoots, maxBytes);
      if (fd === undefined) return { ok: false };
      descriptors.push(fd);
    }
    return { ok: true, value: await consume(descriptors.map((fd) => `/proc/self/fd/${fd}`)) };
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}
