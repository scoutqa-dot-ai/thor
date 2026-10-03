import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  createContextKey,
  withAbortSignal,
  withoutAbortSignal,
} from "@earendil-works/chord/context";
import {
  FileError,
  ExecutionError,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { z } from "zod";
import {
  piExecutionRequestSchema,
  piExecFrameSchema,
  piFileResponseSchema,
  piFileInfoSchema,
  piTextLineSchema,
  piShellEnvironmentSchema,
  piBoundedBinarySchema,
  type PiExecutionOperation,
} from "@thor/pi-executor/protocol";

/** Per-call wrapper attribution; only these values, never runner process.env, may reach remote shell tools. */
export const piShellAttributionKey =
  createContextKey<z.infer<typeof piShellEnvironmentSchema>>("thor.piShellAttribution");

function fileFailure<T>(code: FileError["code"]): Result<T, FileError> {
  return {
    ok: false,
    error: new FileError(code, `Pi executor filesystem request failed (${code})`),
  };
}
function executionFailure(
  code: ExecutionError["code"],
  spillPath?: string,
): Result<ShellExecResult, ExecutionError> {
  const error = new ExecutionError(code, `Pi executor shell request failed (${code})`);
  if (spillPath !== undefined) error.spillPath = spillPath;
  return { ok: false, error };
}
const nullResponse = z.null();

/**
 * Durable execution environment whose filesystem and shell are always remote, including path resolution.
 * No retry is attempted: a lost mutation response is an uncertain outcome, not permission to repeat it.
 */
export class PiExecutionEnv implements ExecutionEnv {
  /** Stable filesystem namespace shared by fresh call environments targeting the same executor. */
  readonly id: string;
  /** Remote directory, not a local runner filesystem path. */
  cwd: string;
  private readonly endpoint: string;
  private readonly sessionId = randomUUID();

  /** URL must be an HTTP(S) origin without credentials; namespaceId identifies the deployed filesystem. */
  constructor(options: { url: string; cwd: string; namespaceId: string }) {
    const parsed = z
      .strictObject({ url: z.url(), cwd: z.string(), namespaceId: z.string().min(1) })
      .safeParse(options);
    if (!parsed.success) throw new TypeError("Pi executor invalid environment configuration");
    const url = new URL(parsed.data.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("Pi executor URL must be a credential-free HTTP origin");
    }
    this.endpoint = new URL("/execute", url).href;
    this.cwd = parsed.data.cwd;
    this.id = parsed.data.namespaceId;
  }

  private async fileRequest<T>(
    operation: PiExecutionOperation,
    schema: z.ZodType<T>,
    context: Context,
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return fileFailure("aborted");
    const request = piExecutionRequestSchema.safeParse({
      sessionId: this.sessionId,
      cwd: this.cwd,
      operation,
    });
    if (!request.success) return fileFailure("invalid");
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return fileFailure("unknown");
      }
      const decoded = piFileResponseSchema(schema).safeParse(await response.json());
      if (!decoded.success) return fileFailure("invalid");
      return decoded.data.ok ? decoded.data : fileFailure(decoded.data.error.code);
    } catch {
      return fileFailure(context.abortSignal?.aborted ? "aborted" : "unknown");
    }
  }

  private async voidRequest(
    operation: PiExecutionOperation,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileRequest(operation, nullResponse, context);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  /** Resolve relative, absolute and home paths on the executor. */
  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileRequest({ type: "absolutePath", path }, z.string(), context);
  }
  /** Join path components using the remote host's path rules. */
  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.fileRequest({ type: "joinPath", parts }, z.string(), context);
  }
  /** Read text without opening any runner-local file. */
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileRequest({ type: "readTextFile", path }, z.string(), context);
  }
  /** Open an executor-owned LF reader; close it or cleanup this environment when finished. */
  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const readerId = randomUUID();
    const opened = await this.voidRequest({ type: "openTextLineReader", path, readerId }, context);
    if (!opened.ok) {
      // The server may have opened the handle before a transport failure; release it without retrying the open.
      await this.voidRequest({ type: "closeReader", readerId }, withoutAbortSignal(context));
      return opened;
    }
    let closed = false;
    let pending = Promise.resolve();
    return {
      ok: true,
      value: {
        readLine: async (readContext): Promise<Result<TextLine | undefined, FileError>> => {
          if (closed) return fileFailure("invalid");
          // Preserve reader cursor order even if a caller issues overlapping readLine requests.
          const next = pending.then(async () => {
            const result = await this.fileRequest(
              { type: "readLine", readerId },
              piTextLineSchema,
              readContext,
            );
            return result.ok ? { ok: true as const, value: result.value ?? undefined } : result;
          });
          pending = next.then(() => undefined);
          return next;
        },
        close: async (closeContext): Promise<void> => {
          if (closed) return;
          closed = true;
          await pending;
          await this.voidRequest(
            { type: "closeReader", readerId },
            withoutAbortSignal(closeContext),
          );
        },
      },
    };
  }
  /** Read an optional number of lines using the executor's reader implementation. */
  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.fileRequest(
      { type: "readTextLines", path, ...(options === undefined ? {} : { options }) },
      z.array(z.string()),
      context,
    );
  }
  /** Decode remote file bytes losslessly from the private base64 wire representation. */
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await this.fileRequest({ type: "readBinaryFile", path }, z.base64(), context);
    return result.ok ? { ok: true, value: Buffer.from(result.value, "base64") } : result;
  }
  /** Read at most maxBytes plus one from an opened remote regular file, without stat/read races. */
  async readBoundedBinaryFile(
    path: string,
    maxBytes: number,
    context: Context,
  ): Promise<Result<z.infer<typeof piBoundedBinarySchema>, FileError>> {
    return this.fileRequest(
      { type: "readBoundedBinaryFile", path, maxBytes },
      piBoundedBinarySchema,
      context,
    );
  }
  /** Write text or bytes remotely, creating parents through the vendor implementation. */
  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest({ type: "writeFile", path, content: encodeContent(content) }, context);
  }
  /** Append text or bytes remotely. */
  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest({ type: "appendFile", path, content: encodeContent(content) }, context);
  }
  /** Set the remote file length in bytes. */
  async truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest({ type: "truncateFile", path, size }, context);
  }
  /** Flush the remote file's contents and metadata through the vendor implementation. */
  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.voidRequest({ type: "flushFile", path }, context);
  }
  /** Rename within the remote filesystem namespace. */
  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest({ type: "renameFile", sourcePath, destinationPath }, context);
  }
  /** Inspect the remote path without following symlinks. */
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.fileRequest({ type: "fileInfo", path }, piFileInfoSchema, context);
  }
  /** List file metadata in a remote directory. */
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.fileRequest({ type: "listDir", path }, z.array(piFileInfoSchema), context);
  }
  /** Resolve symlinks on the executor, never locally. */
  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileRequest({ type: "canonicalPath", path }, z.string(), context);
  }
  /** Missing remote paths return false rather than a not-found error. */
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.fileRequest({ type: "exists", path }, z.boolean(), context);
  }
  /** Create a remote directory with the vendor's recursive default. */
  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest(
      { type: "createDir", path, ...(options === undefined ? {} : { options }) },
      context,
    );
  }
  /** Remove remote paths with explicit force/recursion options. */
  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.voidRequest(
      { type: "remove", path, ...(options === undefined ? {} : { options }) },
      context,
    );
  }
  /** Return an executor-local temporary directory path. */
  async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.fileRequest(
      { type: "createTempDir", ...(prefix === undefined ? {} : { prefix }) },
      z.string(),
      context,
    );
  }
  /** Return an executor-local temporary file path. */
  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.fileRequest(
      { type: "createTempFile", ...(options === undefined ? {} : { options }) },
      z.string(),
      context,
    );
  }
  /** Cancel only this environment's active commands and release its remote readers, even after cancellation. */
  async cleanup(context: Context): Promise<void> {
    await this.voidRequest({ type: "cleanup" }, withoutAbortSignal(context));
  }

  /** Stream remote raw stdout/stderr; vendor owns process kills, timeout policy, and complete-output spill files. */
  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return executionFailure("aborted");
    const attribution = piShellEnvironmentSchema.safeParse({
      ...options?.env,
      ...context.value(piShellAttributionKey),
    });
    if (!attribution.success) return executionFailure("spawn_error");
    const { onOutput, ...wireOptions } = options ?? {};
    const request = piExecutionRequestSchema.safeParse({
      sessionId: this.sessionId,
      cwd: this.cwd,
      operation: { type: "exec", command, options: { ...wireOptions, env: attribution.data } },
    });
    if (!request.success) return executionFailure("spawn_error");
    const controller = new AbortController();
    const requestContext = withAbortSignal(controller.signal, context);
    let callbackFailed = false;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
        ...(requestContext.abortSignal === undefined ? {} : { signal: requestContext.abortSignal }),
      });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get("content-type") !== "application/x-ndjson"
      ) {
        await response.body?.cancel();
        return executionFailure("unknown");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffered = "";
      let terminal: Result<ShellExecResult, ExecutionError> | undefined;
      try {
        while (true) {
          const chunk = await reader.read();
          buffered += decoder.decode(chunk.value, { stream: !chunk.done });
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const row = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            const raw: unknown = JSON.parse(row);
            const frame = piExecFrameSchema.safeParse(raw);
            if (!frame.success || terminal !== undefined) return executionFailure("unknown");
            if (frame.data.type === "output") {
              try {
                onOutput?.(frame.data.text, context);
              } catch {
                callbackFailed = true;
                return executionFailure("callback_error");
              }
            } else {
              const result = frame.data.result;
              terminal = result.ok
                ? {
                    ok: true,
                    value: {
                      exitCode: result.value.exitCode,
                      ...(result.value.spillPath === undefined
                        ? {}
                        : { spillPath: result.value.spillPath }),
                    },
                  }
                : executionFailure(result.error.code, result.error.spillPath);
            }
          }
          if (chunk.done) break;
        }
        return buffered === "" && terminal !== undefined ? terminal : executionFailure("unknown");
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      return executionFailure(
        callbackFailed ? "callback_error" : context.abortSignal?.aborted ? "aborted" : "unknown",
      );
    } finally {
      // Includes malformed frame and output-callback failures: closing the HTTP stream kills remote processes.
      controller.abort();
    }
  }
}

function encodeContent(content: string | Uint8Array): {
  encoding: "text" | "base64";
  data: string;
} {
  return typeof content === "string"
    ? { encoding: "text", data: content }
    : { encoding: "base64", data: Buffer.from(content).toString("base64") };
}
