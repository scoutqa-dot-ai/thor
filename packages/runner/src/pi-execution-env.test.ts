import { createServer, type Server } from "node:http";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT, withCancel, withContextValue } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createPiExecutorService } from "@thor/pi-executor/service";
import { PiExecutionEnv, piShellAttributionKey } from "./pi-execution-env.js";

const context = BACKGROUND_CONTEXT;
let service: ReturnType<typeof createPiExecutorService>;
let cwd: string;
let url: string;
let env: PiExecutionEnv;
const extraServers: Server[] = [];
const extraDirs: string[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pi executor test failed to listen");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-remote-env-test-"));
  service = createPiExecutorService({
    shellEnvironment: {
      PATH: process.env.PATH,
      HOME: cwd,
      LANG: "C.UTF-8",
      THOR_REMOTE_CLI_URL: "http://remote-cli:3000",
    },
  });
  url = await listen(service.server);
  env = new PiExecutionEnv({ url, cwd, namespaceId: "thor:test-executor" });
  // The public class satisfies the complete published vendor capability, not a partial lookalike.
  const capability: ExecutionEnv = env;
  expect(capability.id).toBe("thor:test-executor");
});
afterEach(async () => {
  await env.cleanup(context);
  await service.dispose();
  await close(service.server);
  await Promise.all(extraServers.splice(0).map(close));
  await Promise.all(
    [cwd, ...extraDirs.splice(0)].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PiExecutionEnv through real HTTP", () => {
  it("roundtrips all filesystem capabilities including LF readers, binary data, symlinks and temporary files", async () => {
    expect(getOrThrow(await env.absolutePath("nested/data", context))).toBe(
      join(cwd, "nested/data"),
    );
    expect(getOrThrow(await env.joinPath([cwd, "nested", "data"], context))).toBe(
      join(cwd, "nested/data"),
    );
    expect(getOrThrow(await env.exists("nested/data", context))).toBe(false);
    getOrThrow(await env.createDir("nested", undefined, context));
    getOrThrow(await env.writeFile("nested/data", "first\r\nsecond\nlast", context));
    getOrThrow(await env.appendFile("nested/data", "!", context));
    getOrThrow(await env.flushFile("nested/data", context));
    expect(getOrThrow(await env.readTextFile("nested/data", context))).toBe(
      "first\r\nsecond\nlast!",
    );
    expect(getOrThrow(await env.readTextLines("nested/data", { maxLines: 2 }, context))).toEqual([
      "first\r",
      "second",
    ]);
    expect(getOrThrow(await env.readTextLines("nested/data", { maxLines: 0 }, context))).toEqual(
      [],
    );
    const reader = getOrThrow(await env.openTextLineReader("nested/data", context));
    expect(getOrThrow(await reader.readLine(context))).toEqual({
      text: "first\r",
      terminated: true,
    });
    const concurrent = await Promise.all([reader.readLine(context), reader.readLine(context)]);
    expect(concurrent.map(getOrThrow)).toEqual([
      { text: "second", terminated: true },
      { text: "last!", terminated: false },
    ]);
    expect(getOrThrow(await reader.readLine(context))).toBeUndefined();
    await reader.close(context);
    await reader.close(context);
    expect(await reader.readLine(context)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(getOrThrow(await env.fileInfo("nested/data", context))).toMatchObject({
      kind: "file",
      name: "data",
      size: 19,
    });
    expect(getOrThrow(await env.listDir("nested", context)).map((info) => info.name)).toEqual([
      "data",
    ]);
    getOrThrow(await env.renameFile("nested/data", "nested/renamed", context));
    getOrThrow(await env.truncateFile("nested/renamed", 5, context));
    expect(getOrThrow(await env.readTextFile("nested/renamed", context))).toBe("first");
    await symlink(join(cwd, "nested/renamed"), join(cwd, "link"));
    expect(getOrThrow(await env.fileInfo("link", context)).kind).toBe("symlink");
    expect(getOrThrow(await env.canonicalPath("link", context))).toBe(join(cwd, "nested/renamed"));
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0, 255, 128, 10]),
      Uint8Array.from({ length: 8192 }, (_, i) => i % 256),
    ]) {
      getOrThrow(await env.writeFile("binary", bytes, context));
      expect(Array.from(getOrThrow(await env.readBinaryFile("binary", context)))).toEqual(
        Array.from(bytes),
      );
    }
    getOrThrow(await env.appendFile("binary", new Uint8Array([255]), context));
    expect(getOrThrow(await env.readBinaryFile("binary", context)).at(-1)).toBe(255);
    const tempDir = getOrThrow(await env.createTempDir("pi-env-dir-", context));
    extraDirs.push(tempDir);
    expect(getOrThrow(await env.fileInfo(tempDir, context)).kind).toBe("directory");
    const tempFile = getOrThrow(
      await env.createTempFile({ prefix: "data-", suffix: ".txt" }, context),
    );
    extraDirs.push(dirname(tempFile));
    expect(tempFile).toMatch(/data-.*\.txt$/);
    expect(getOrThrow(await env.exists(tempFile, context))).toBe(true);
    getOrThrow(await env.remove("nested", { recursive: true }, context));
    expect(getOrThrow(await env.exists("nested", context))).toBe(false);
    expect(await env.readTextFile("no-such-file-sensitive-sentinel", context)).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "Pi executor filesystem request failed (not_found)" },
    });
  });

  it("uses published Durable read/write/edit tools against the remote filesystem", async () => {
    const provider = fauxProvider();
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "tool.txt", content: "before\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("edit", {
          path: "tool.txt",
          edits: [{ oldText: "before", newText: "after" }],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: "tool.txt" }), { stopReason: "toolUse" }),
      (transcript) => {
        expect(JSON.stringify(transcript)).toContain("after\\n");
        return fauxAssistantMessage("done");
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const registry = createRegistry();
    registry.install(CodingTools);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: () => env },
      context,
    );
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const submitted = await root.submit({ type: "input", content: "write/edit/read" }, context);
      expect((await submitted.wait(context)).status).toBe("done");
      expect(getOrThrow(await env.readTextFile("tool.txt", context))).toBe("after\n");
    } finally {
      await harness.close(context);
    }
  });

  it("streams raw combined shell output before exit with the exact caller context, attribution and spill metadata", async () => {
    const callContext = withContextValue(
      piShellAttributionKey,
      {
        THOR_OPENCODE_DIRECTORY: cwd,
        THOR_OPENCODE_SESSION_ID: "conversation-1",
        THOR_OPENCODE_CALL_ID: "call-1",
      },
      context,
    );
    let output = "";
    let observedContext: unknown;
    const result = await env.exec(
      "printf 'first\\n'; sleep 0.03; printf 'second\\n' >&2; printf '%s' \"$THOR_OPENCODE_CALL_ID\"; exit 7",
      {
        onOutput: (text, received) => {
          output += text;
          observedContext = received;
        },
        spill: { afterBytes: 4, afterLines: 1 },
      },
      callContext,
    );
    expect(output).toBe("first\nsecond\ncall-1");
    expect(observedContext).toBe(callContext);
    const shell = getOrThrow(result);
    expect(shell.exitCode).toBe(7);
    expect(shell.spillPath).toBeDefined();
    if (!shell.spillPath) throw new Error("Pi executor test missing spill file");
    extraDirs.push(dirname(shell.spillPath));
    expect(getOrThrow(await env.readTextFile(shell.spillPath, context))).toBe(output);
    expect(
      getOrThrow(
        await env.exec(
          "test \"$THOR_REMOTE_CLI_URL\" = 'http://remote-cli:3000'",
          undefined,
          context,
        ),
      ).exitCode,
    ).toBe(0);
    expect(
      getOrThrow(await env.exec('test -z "$THOR_REMOTE_CLI_URL"', { inheritEnv: false }, context))
        .exitCode,
    ).toBe(0);
  });

  it("passes the vendor timeout in seconds and returns safe error codes without command leakage", async () => {
    const result = await env.exec(
      "sleep 30; echo sensitive-command-sentinel",
      { timeout: 0.05 },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "timeout", message: "Pi executor shell request failed (timeout)" },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("caller cancellation after streamed output kills the remote command; pre-cancelled filesystem work stays untouched", async () => {
    const call = withCancel(context);
    let pid = 0;
    const result = await env.exec(
      "printf '%s\\n' \"$$\"; sleep 30; touch survived",
      {
        onOutput: (text) => {
          pid = Number(text.trim());
          call.cancel();
        },
      },
      call.context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(pid).toBeGreaterThan(0);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(getOrThrow(await env.exists("survived", context))).toBe(false);
    expect(await env.writeFile("cancelled-file", "x", call.context)).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(getOrThrow(await env.exists("cancelled-file", context))).toBe(false);
  });

  it("rejects privileged env before transport and cancels a command when output callbacks fail safely", async () => {
    expect(
      await env.exec(
        "touch forbidden",
        { env: { THOR_INTERNAL_SECRET: "secret-sentinel" } },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: "spawn_error" } });
    expect(getOrThrow(await env.exists("forbidden", context))).toBe(false);
    const result = await env.exec(
      "echo ready; sleep 30; touch callback-survived",
      {
        onOutput: () => {
          throw new Error("callback-secret-sentinel");
        },
      },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "callback_error" } });
    expect(JSON.stringify(result)).not.toContain("secret-sentinel");
  });

  it("fresh environments share stable namespace but cleanup releases only its own readers and commands", async () => {
    const other = new PiExecutionEnv({ url, cwd, namespaceId: env.id });
    expect(other.id).toBe(env.id);
    getOrThrow(await env.writeFile("shared", "one\ntwo", context));
    const first = getOrThrow(await env.openTextLineReader("shared", context));
    const second = getOrThrow(await other.openTextLineReader("shared", context));
    await env.cleanup(context);
    expect(await first.readLine(context)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(getOrThrow(await second.readLine(context))).toEqual({ text: "one", terminated: true });
    await second.close(context);
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = env.exec("echo ready; sleep 30", { onOutput: ready }, context);
    await started;
    await env.cleanup(context);
    expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
    await other.cleanup(context);
  });

  it.each([
    "{malformed-secret-sentinel\n",
    '{"type":"output","text":123}\n',
    '{"type":"unknown","secret":"secret-sentinel"}\n',
    '{"type":"output","text":"partial"}\n',
    '{"type":"result","result":{"ok":true,"value":{"exitCode":0}}}',
    '{"type":"result","result":{"ok":true,"value":{"exitCode":0}}}\n{"type":"output","text":"late"}\n',
  ])("fails closed on malformed/truncated/late NDJSON frames", async (frames) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(frames);
    });
    extraServers.push(server);
    const broken = new PiExecutionEnv({ url: await listen(server), cwd, namespaceId: "broken" });
    const result = await broken.exec("private-command-sentinel", undefined, context);
    expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("never falls back to runner files or shell when the executor fails", async () => {
    getOrThrow(await env.writeFile("local-readable", "local-file-sentinel", context));
    const unavailable = createServer((_request, response) => {
      response.writeHead(503);
      response.end("server-error-sentinel");
    });
    extraServers.push(unavailable);
    const broken = new PiExecutionEnv({
      url: await listen(unavailable),
      cwd,
      namespaceId: "unavailable",
    });
    expect(await broken.readTextFile(join(cwd, "local-readable"), context)).toMatchObject({
      ok: false,
    });
    expect(await broken.exec("touch should-not-run", undefined, context)).toMatchObject({
      ok: false,
    });
    expect(getOrThrow(await env.exists("should-not-run", context))).toBe(false);
    expect(await broken.absolutePath("local-readable", context)).toMatchObject({ ok: false });
  });

  it("rejects malformed file responses and HTTP redirects without sending requests to the target", async () => {
    let redirectedRequests = 0;
    const target = createServer((_request, response) => {
      redirectedRequests++;
      response.end("bad");
    });
    extraServers.push(target);
    const targetUrl = await listen(target);
    const redirect = createServer((_request, response) => {
      response.writeHead(307, { location: targetUrl });
      response.end();
    });
    extraServers.push(redirect);
    const redirected = new PiExecutionEnv({
      url: await listen(redirect),
      cwd,
      namespaceId: "redirect",
    });
    expect(await redirected.exec("private-command-sentinel", undefined, context)).toMatchObject({
      ok: false,
    });
    expect(await redirected.readTextFile("private-path-sentinel", context)).toMatchObject({
      ok: false,
    });
    expect(redirectedRequests).toBe(0);
    const malformed = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true,"value":123}');
    });
    extraServers.push(malformed);
    const broken = new PiExecutionEnv({
      url: await listen(malformed),
      cwd,
      namespaceId: "malformed",
    });
    expect(await broken.readTextFile("anything", context)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });
});
