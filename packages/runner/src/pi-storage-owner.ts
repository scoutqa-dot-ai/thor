import { spawn } from "node:child_process";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/** Hold a kernel advisory lock on a runner-owned descriptor; process death releases it without stale PID recovery. */
export async function acquirePiStorageOwner(
  storagePath: string,
): Promise<
  | { ok: true; path: string; release: () => Promise<void> }
  | { ok: false; error: "pi_storage_owned_or_unavailable" }
> {
  let descriptor: FileHandle | undefined;
  try {
    await mkdir(dirname(storagePath), { recursive: true });
    let path = join(await realpath(dirname(storagePath)), basename(storagePath));
    try {
      path = await realpath(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    descriptor = await open(`${path}.owner`, "a", 0o600);
    // flock acts on the inherited open file description. The parent retains the same description,
    // so the lock survives helper exit, and releases only on descriptor close or runner process death.
    // No shell or agent command is run locally; Linux util-linux supplies the missing Node flock syscall.
    const child = spawn("flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", descriptor.fd],
    });
    const acquired = await new Promise<boolean>((resolve) => {
      child.once("close", (code) => resolve(code === 0));
      child.once("error", () => resolve(false));
    });
    if (!acquired) {
      await descriptor.close();
      return { ok: false, error: "pi_storage_owned_or_unavailable" };
    }
    const ownedDescriptor = descriptor;
    return { ok: true, path, release: () => ownedDescriptor.close() };
  } catch {
    await descriptor?.close().catch(() => undefined);
    return { ok: false, error: "pi_storage_owned_or_unavailable" };
  }
}
