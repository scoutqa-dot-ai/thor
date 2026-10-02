import { createServer, type Server, type ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError, type Result, type TextLineReader } from "@earendil-works/pi-durable/env";
import { piExecutionRequestSchema, type PiExecutionRequest } from "./execution-protocol.js";

const shellEnvironmentNames = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "THOR_REMOTE_CLI_URL",
] as const;

/** Snapshot the reduced executor environment at startup, excluding credentials and runtime injection knobs. */
export function selectPiShellEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of shellEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function fileResponse<T>(result: Result<T, FileError>): unknown {
  return result.ok
    ? { ok: true, value: result.value ?? null }
    : { ok: false, error: { code: result.error.code } };
}

/**
 * Create an inert private HTTP service. The deployment container, not cwd, is the security boundary.
 * Call dispose before closing the HTTP server to cancel active processes and close text readers.
 */
export function createPiExecutorService(options: { shellEnvironment: NodeJS.ProcessEnv }): {
  readonly server: Server;
  readonly dispose: () => Promise<void>;
} {
  // Filter even explicitly supplied startup configuration: a poisoned process.env must never reach a shell.
  const shellEnvironment = selectPiShellEnvironment(options.shellEnvironment);
  const readers = new Map<string, { sessionId: string; reader: TextLineReader }>();
  const active = new Map<PiExecutionRequest, { cancel: () => void; finished: Promise<void> }>();
  let disposed = false;

  async function cleanupSession(sessionId: string): Promise<void> {
    for (const [request, invocation] of active) {
      if (request.sessionId === sessionId && request.operation.type === "exec") invocation.cancel();
    }
    for (const [readerId, entry] of readers) {
      if (entry.sessionId !== sessionId) continue;
      readers.delete(readerId);
      await entry.reader.close(BACKGROUND_CONTEXT);
    }
  }

  async function runFileOperation(
    request: PiExecutionRequest,
    env: NodeExecutionEnv,
    context: Context,
  ): Promise<unknown> {
    const op = request.operation;
    switch (op.type) {
      case "absolutePath":
        return fileResponse(await env.absolutePath(op.path, context));
      case "joinPath":
        return fileResponse(await env.joinPath(op.parts, context));
      case "readTextFile":
        return fileResponse(await env.readTextFile(op.path, context));
      case "openTextLineReader": {
        if (readers.has(op.readerId))
          return fileResponse({
            ok: false,
            error: new FileError("invalid", "Pi executor reader already exists"),
          });
        const opened = await env.openTextLineReader(op.path, context);
        if (!opened.ok) return fileResponse(opened);
        if (context.abortSignal?.aborted) {
          await opened.value.close(BACKGROUND_CONTEXT);
          return fileResponse({
            ok: false,
            error: new FileError("aborted", "Pi executor request cancelled"),
          });
        }
        readers.set(op.readerId, { sessionId: request.sessionId, reader: opened.value });
        return { ok: true, value: null };
      }
      case "readLine":
      case "closeReader": {
        const entry = readers.get(op.readerId);
        if (entry === undefined || entry.sessionId !== request.sessionId) {
          // Closing an already closed reader is idempotent.
          return op.type === "closeReader"
            ? { ok: true, value: null }
            : { ok: false, error: { code: "invalid" } };
        }
        if (op.type === "readLine") return fileResponse(await entry.reader.readLine(context));
        readers.delete(op.readerId);
        await entry.reader.close(BACKGROUND_CONTEXT);
        return { ok: true, value: null };
      }
      case "readTextLines":
        return fileResponse(
          await env.readTextLines(
            op.path,
            op.options?.maxLines === undefined ? undefined : { maxLines: op.options.maxLines },
            context,
          ),
        );
      case "readBinaryFile": {
        const result = await env.readBinaryFile(op.path, context);
        return result.ok
          ? { ok: true, value: Buffer.from(result.value).toString("base64") }
          : fileResponse(result);
      }
      case "writeFile":
        return fileResponse(
          await env.writeFile(
            op.path,
            op.content.encoding === "text"
              ? op.content.data
              : Buffer.from(op.content.data, "base64"),
            context,
          ),
        );
      case "appendFile":
        return fileResponse(
          await env.appendFile(
            op.path,
            op.content.encoding === "text"
              ? op.content.data
              : Buffer.from(op.content.data, "base64"),
            context,
          ),
        );
      case "truncateFile":
        return fileResponse(await env.truncateFile(op.path, op.size, context));
      case "flushFile":
        return fileResponse(await env.flushFile(op.path, context));
      case "renameFile":
        return fileResponse(await env.renameFile(op.sourcePath, op.destinationPath, context));
      case "fileInfo":
        return fileResponse(await env.fileInfo(op.path, context));
      case "listDir":
        return fileResponse(await env.listDir(op.path, context));
      case "canonicalPath":
        return fileResponse(await env.canonicalPath(op.path, context));
      case "exists":
        return fileResponse(await env.exists(op.path, context));
      case "createDir":
        return fileResponse(
          await env.createDir(
            op.path,
            op.options?.recursive === undefined ? undefined : { recursive: op.options.recursive },
            context,
          ),
        );
      case "remove":
        return fileResponse(
          await env.remove(
            op.path,
            {
              ...(op.options?.recursive === undefined ? {} : { recursive: op.options.recursive }),
              ...(op.options?.force === undefined ? {} : { force: op.options.force }),
            },
            context,
          ),
        );
      case "createTempDir":
        return fileResponse(await env.createTempDir(op.prefix, context));
      case "createTempFile":
        return fileResponse(
          await env.createTempFile(
            {
              ...(op.options?.prefix === undefined ? {} : { prefix: op.options.prefix }),
              ...(op.options?.suffix === undefined ? {} : { suffix: op.options.suffix }),
            },
            context,
          ),
        );
      case "cleanup":
        await cleanupSession(request.sessionId);
        return { ok: true, value: null };
      case "exec":
        throw new Error("Pi executor exec reached file dispatch");
    }
  }

  async function runRequest(
    request: PiExecutionRequest,
    response: ServerResponse,
    invocation: ReturnType<typeof withCancel>,
  ): Promise<void> {
    const onClose = (): void => {
      if (!response.writableFinished) invocation.cancel();
    };
    response.once("close", onClose);
    const env = new NodeExecutionEnv({ cwd: request.cwd });
    try {
      const op = request.operation;
      if (op.type !== "exec") {
        sendJson(response, await runFileOperation(request, env, invocation.context));
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders();
      const result = await env.exec(
        op.command,
        {
          ...(op.options?.cwd === undefined ? {} : { cwd: op.options.cwd }),
          ...(op.options?.timeout === undefined ? {} : { timeout: op.options.timeout }),
          ...(op.options?.spill === undefined ? {} : { spill: op.options.spill }),
          // Vendor inheritEnv=false ignores its base shellEnv. Pass the complete reduced environment here.
          inheritEnv: false,
          env: {
            ...(op.options?.inheritEnv === false ? {} : shellEnvironment),
            ...Object.fromEntries(
              Object.entries(op.options?.env ?? {}).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
          onOutput: (text) => {
            if (!response.destroyed)
              response.write(JSON.stringify({ type: "output", text }) + "\n");
          },
        },
        invocation.context,
      );
      const wireResult = result.ok
        ? result
        : {
            ok: false,
            error: {
              code: result.error.code,
              ...(result.error.spillPath === undefined
                ? {}
                : { spillPath: result.error.spillPath }),
            },
          };
      if (!response.destroyed)
        response.end(JSON.stringify({ type: "result", result: wireResult }) + "\n");
    } catch {
      // Never serialize raw command, environment, paths from errors, or vendor causes.
      if (response.destroyed) return;
      if (request.operation.type === "exec" && response.headersSent) {
        response.end(
          JSON.stringify({ type: "result", result: { ok: false, error: { code: "unknown" } } }) +
            "\n",
        );
      } else sendJson(response, { ok: false, error: { code: "unknown" } });
    } finally {
      response.removeListener("close", onClose);
      invocation.cancel();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (disposed) {
        sendJson(response, { error: "Pi executor unavailable" }, 503);
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, { ok: true });
        return;
      }
      if (request.method !== "POST" || request.url !== "/execute") {
        sendJson(response, { error: "Pi executor route not found" }, 404);
        return;
      }
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request)
        body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        sendJson(response, { error: "Pi executor invalid request" }, 400);
        return;
      }
      const parsed = piExecutionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendJson(response, { error: "Pi executor invalid request" }, 400);
        return;
      }
      if (disposed) {
        sendJson(response, { error: "Pi executor unavailable" }, 503);
        return;
      }
      if (response.destroyed) return;
      const requestValue = parsed.data;
      // Create a cancellation owner before execution starts, including synchronous output/close races.
      const invocation = withCancel(BACKGROUND_CONTEXT);
      const finished = runRequest(requestValue, response, invocation).finally(() =>
        active.delete(requestValue),
      );
      active.set(requestValue, { cancel: invocation.cancel, finished });
    })().catch(() => {
      if (!response.destroyed && !response.headersSent)
        sendJson(response, { error: "Pi executor invalid request" }, 400);
      else response.destroy();
    });
  });

  return {
    server,
    async dispose(): Promise<void> {
      disposed = true;
      const running = [...active.values()];
      for (const invocation of running) invocation.cancel();
      await Promise.all(running.map((invocation) => invocation.finished));
      for (const entry of readers.values()) await entry.reader.close(BACKGROUND_CONTEXT);
      readers.clear();
    },
  };
}
