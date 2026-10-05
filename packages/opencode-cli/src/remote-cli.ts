/**
 * Shared HTTP client for remote-cli wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> [args...]
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service
 */

import {
  ExecResultSchema,
  ExecStreamEventSchema,
  GOOGLE_DRIVE_DOWNLOAD_MAX_WIRE_BYTES,
  GoogleDriveDownloadExecResultSchema,
  GoogleDriveFileIdSchema,
  type ExecStreamEvent,
} from "@thor/common";
import { materializeGoogleDriveDownload } from "./google-drive-materializer.js";

const [endpoint, ...args] = process.argv.slice(2);

const isDriveDownload = endpoint === "gws" && args[0] === "drive" && args[1] === "+download";
if (
  isDriveDownload &&
  (args.length !== 4 ||
    args[2] !== "--file-id" ||
    !GoogleDriveFileIdSchema.safeParse(args[3]).success)
) {
  process.stderr.write("Drive download requires exactly: gws drive +download --file-id FILE_ID\n");
  process.exit(1);
}

class DriveDownloadResponseError extends Error {
  readonly _tag = "DriveDownloadResponseError" as const;
  constructor() {
    super("Drive download response failed; no local files were created.");
  }
}

async function readDriveDownloadResponse(
  res: Response,
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: DriveDownloadResponseError }
> {
  if (!res.body) return { ok: false, error: new DriveDownloadResponseError() };
  try {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > GOOGLE_DRIVE_DOWNLOAD_MAX_WIRE_BYTES) {
          return { ok: false, error: new DriveDownloadResponseError() };
        }
        chunks.push(chunk.value);
      }
      return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    return { ok: false, error: new DriveDownloadResponseError() };
  }
}

if (!endpoint) {
  process.stderr.write("Usage: remote-cli.mjs <endpoint> [args...]\n");
  process.exit(1);
}

const baseUrl = process.env.THOR_REMOTE_CLI_URL;
if (!baseUrl) {
  process.stderr.write("THOR_REMOTE_CLI_URL is not set\n");
  process.exit(1);
}

const url = `${baseUrl}/exec/${endpoint}`;
const cwd = process.cwd();
const sessionDirectory = process.env.THOR_OPENCODE_DIRECTORY || cwd;
const sessionId = process.env.THOR_OPENCODE_SESSION_ID || "";
const callId = process.env.THOR_OPENCODE_CALL_ID || "";
const body: Record<string, unknown> = { args, cwd, directory: sessionDirectory };

if (endpoint === "slack-post-message") {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  body.stdin = Buffer.concat(chunks).toString("utf8");
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId && { "x-thor-session-id": sessionId }),
      ...(callId && { "x-thor-call-id": callId }),
    },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get("content-type") || "";

  if (isDriveDownload) {
    // Never route a download through generic JSON/NDJSON rendering or Zod error diagnostics.
    const wire = await readDriveDownloadResponse(res);
    if (!wire.ok) {
      process.stderr.write(`${wire.error.message}\n`);
      process.exit(1);
    }
    const result = GoogleDriveDownloadExecResultSchema.safeParse(JSON.parse(wire.text));
    if (!result.success || (result.data.driveDownload && (!res.ok || result.data.exitCode !== 0))) {
      process.stderr.write("Drive download response rejected; no local files were created.\n");
      process.exit(1);
    }
    if (!res.ok || result.data.exitCode !== 0) {
      // Ordinary broker failures, including 428 auth waits, keep their established output.
      if (result.data.stdout) process.stdout.write(result.data.stdout);
      if (result.data.stderr) process.stderr.write(result.data.stderr);
      process.exit(result.data.exitCode || 1);
    }
    if (!result.data.driveDownload) {
      process.stderr.write(
        "Drive download artifact missing; rebuild the broker and agent wrappers together.\n",
      );
      process.exit(1);
    }
    const download = await materializeGoogleDriveDownload(result.data.driveDownload);
    if (!download.ok) {
      process.stderr.write(`${download.error.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(download.value)}\n`);
    if (download.value.skipped > 0) {
      process.stderr.write(
        `Drive download warning: ${download.value.skipped} shortcut(s) skipped.\n`,
      );
    }
    process.exit(0);
  }

  // NDJSON streaming response (scoutqa)
  if (contentType.includes("application/x-ndjson")) {
    let exitCode = 1;
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (msg: ExecStreamEvent) => {
      switch (msg.type) {
        case "stdout":
          process.stdout.write(msg.data);
          break;
        case "stderr":
          process.stderr.write(msg.data);
          break;
        case "exit":
          exitCode = msg.exitCode;
          break;
        case "heartbeat":
          break;
      }
    };

    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line) continue;
        handleEvent(ExecStreamEventSchema.parse(JSON.parse(line)));
      }
    }
    // flush remaining buffer
    if (buffer.trim()) {
      handleEvent(ExecStreamEventSchema.parse(JSON.parse(buffer)));
    }
    process.exit(exitCode);
  }

  // Buffered JSON response (git/gh)
  if (!res.ok && contentType.includes("application/json")) {
    const result = ExecResultSchema.parse(await res.json());
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode ?? 1);
  }

  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${await res.text()}\n`);
    process.exit(1);
  }

  const result = ExecResultSchema.parse(await res.json());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  process.exit(result.exitCode ?? 0);
} catch (err) {
  process.stderr.write(
    isDriveDownload
      ? `${new DriveDownloadResponseError().message}\n`
      : `Failed to reach remote-cli: ${(err as Error).message}\n`,
  );
  process.exit(1);
}
