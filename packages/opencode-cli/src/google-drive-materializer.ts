import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleDriveDownload } from "@thor/common";

/** Local download summary; path belongs to the agent, never the broker. */
export type GoogleDriveLocalDownload = {
  readonly path: string;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly skipped: number;
};

/** Safe download failure; provider contents and filesystem causes are never rendered. */
export class GoogleDriveMaterializationError extends Error {
  /** Identifies an expected download materialization failure. */
  readonly _tag = "GoogleDriveMaterializationError" as const;

  /** Classify materialization failure without exposing payloads or filesystem error details. */
  constructor(
    /** Cleanup failure is distinct because complete rollback could not be established. */
    readonly stage: "digest" | "write" | "cleanup",
  ) {
    super(
      stage === "digest"
        ? "Drive download integrity check failed; no local files were created."
        : stage === "cleanup"
          ? "Drive download cleanup failed after a local write error."
          : "Drive download local write failed; temporary files were removed.",
    );
  }
}

/** Materialize a parsed Drive manifest in a fresh private directory, verifying all digests before I/O. */
export async function materializeGoogleDriveDownload(
  manifest: GoogleDriveDownload,
): Promise<
  | { readonly ok: true; readonly value: GoogleDriveLocalDownload }
  | { readonly ok: false; readonly error: GoogleDriveMaterializationError }
> {
  // Schema validation belongs to the HTTP edge; this owner establishes byte integrity.
  const files: Array<{ readonly path: readonly string[]; readonly data: Buffer }> = [];
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const data = Buffer.from(entry.dataBase64, "base64");
    if (createHash("sha256").update(data).digest("hex") !== entry.sha256) {
      return { ok: false, error: new GoogleDriveMaterializationError("digest") };
    }
    files.push({ path: entry.path, data });
    bytes += data.length;
  }
  const directories = manifest.entries
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => left.path.length - right.path.length);

  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "neo-drive-"));
    await chmod(root, 0o700);
    // Only validated components enter join. No existing tree or caller-supplied path is accepted.
    for (const entry of directories) {
      const path = join(root, ...entry.path);
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    }
    for (const file of files) {
      const path = join(root, ...file.path);
      await writeFile(path, file.data, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
    }
    return {
      ok: true,
      value: {
        path: join(root, manifest.rootName),
        files: files.length,
        directories: directories.length,
        bytes,
        skipped: manifest.skipped.length,
      },
    };
  } catch {
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        return { ok: false, error: new GoogleDriveMaterializationError("cleanup") };
      }
    }
    return { ok: false, error: new GoogleDriveMaterializationError("write") };
  }
}
