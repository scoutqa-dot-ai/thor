import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import { FileError, type Result } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import { PI_IMAGE_MAX_BYTES, piBoundedBinarySchema } from "./execution-protocol.js";

function failure(code: FileError["code"]): Result<never, FileError> {
  return { ok: false, error: new FileError(code, "Pi executor bounded binary read failed") };
}

/** Bounded binary read uses one opened regular file and at most maxBytes + 1 bytes, even if it grows. */
export async function readBoundedExecutorFile(
  path: string,
  maxBytes: number,
  context: Context,
): Promise<Result<z.infer<typeof piBoundedBinarySchema>, FileError>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PI_IMAGE_MAX_BYTES)
    return failure("invalid");
  if (context.abortSignal?.aborted) return failure("aborted");
  try {
    // Nonblocking open prevents a FIFO from waiting for a writer before the regular-file check.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (context.abortSignal?.aborted) return failure("aborted");
      if (!(await file.stat()).isFile()) return failure("not_supported");
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        if (context.abortSignal?.aborted) return failure("aborted");
        const result = await file.read(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (context.abortSignal?.aborted) return failure("aborted");
      return {
        ok: true,
        value:
          offset > maxBytes
            ? { tooLarge: true }
            : { data: bytes.subarray(0, offset).toString("base64") },
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (context.abortSignal?.aborted) return failure("aborted");
    const decoded = z.object({ code: z.string() }).safeParse(error);
    switch (decoded.success ? decoded.data.code : undefined) {
      case "ENOENT":
        return failure("not_found");
      case "EACCES":
      case "EPERM":
        return failure("permission_denied");
      case "ENOTDIR":
        return failure("not_directory");
      default:
        return failure("unknown");
    }
  }
}
