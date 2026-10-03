import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiExecutorService } from "@thor/pi-executor/service";
import { piExecutionRequestSchema, type PiExecutionRequest } from "@thor/pi-executor/protocol";
import { createPiRunnerApp } from "./pi-runner.js";
import type { PiRunnerConfig } from "./pi-runner-config.js";
import {
  appendAlias,
  appendSessionEvent,
  findActiveTrigger,
  findTriggerActor,
  mintAnchor,
  mintTriggerId,
  readTriggerSlice,
  resolveAlias,
} from "@thor/common";
import { createRunnerApp } from "./index.js";
import sharp from "sharp";
import { truncate } from "node:fs/promises";
import { crc32 } from "node:zlib";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function respond(res: ServerResponse, content: { text: string } | { tool: string; args: object }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let sequence_number = 0;
  const emit = (event: object) =>
    res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence_number++ })}\n\n`);
  emit({ type: "response.created", response: { id: "resp_test" } });
  if ("tool" in content) {
    const item = {
      type: "function_call",
      id: "fc_test",
      call_id: "call_test",
      name: content.tool,
      arguments: JSON.stringify(content.args),
      status: "completed",
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    emit({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: item.arguments,
    });
    emit({ type: "response.output_item.done", output_index: 0, item });
  } else {
    const item = {
      type: "message",
      id: "msg_test",
      role: "assistant",
      content: [{ type: "output_text", text: content.text, annotations: [] }],
      status: "completed",
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    emit({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: content.text,
    });
    emit({ type: "response.output_item.done", output_index: 0, item });
  }
  emit({
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  });
  res.end();
}

let directory: string;
let config: PiRunnerConfig;
let modelServer: Server;
let executor: ReturnType<typeof createPiExecutorService>;
let executorProxy: Server;
let executorRequests: PiExecutionRequest[];
let runner: Extract<Awaited<ReturnType<typeof createPiRunnerApp>>, { ok: true }>;
let runnerServer: Server;
let runnerUrl: string;
let requests: Record<string, unknown>[];
let hold: ServerResponse | undefined;
let toolRound: boolean;
let modelFailure: boolean;
let imagePath: string;
let holdImageRead: boolean;
let failImageRead: boolean;
const triggerDirectory = "/workspace/repos/pi-fixture";

async function openRunner(options?: Parameters<typeof createPiRunnerApp>[1]) {
  const result = await createPiRunnerApp(config, options);
  if (!result.ok) throw new Error(result.error);
  runner = result;
  runnerServer = createServer(runner.app);
  runnerUrl = await listen(runnerServer);
}
async function trigger(body: object) {
  return fetch(`${runnerUrl}/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-thor-internal-secret": config.internalSecret,
    },
    body: JSON.stringify({ directory: triggerDirectory, ...body }),
  });
}
async function stream(body: object): Promise<Array<Record<string, unknown>>> {
  const response = await trigger({ ...body, stream: true });
  expect(response.status).toBe(200);
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "thor-pi-runner-"));
  process.env.WORKLOG_DIR = join(directory, "worklog");
  requests = [];
  hold = undefined;
  toolRound = false;
  modelFailure = false;
  imagePath = "remote-image.bin";
  holdImageRead = false;
  failImageRead = false;
  executor = createPiExecutorService({
    shellEnvironment: {
      PATH: process.env.PATH,
      HOME: directory,
      THOR_REMOTE_CLI_URL: "http://executor-side-remote-cli",
    },
  });
  const remoteUrl = await listen(executor.server);
  executorRequests = [];
  // Faithful remote filesystem namespace: /workspace/repos/pi-fixture exists only at the executor.
  executorProxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = piExecutionRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    executorRequests.push(structuredClone(payload));
    if (payload.operation.type === "readBoundedBinaryFile" && failImageRead) {
      res.writeHead(503);
      res.end();
      return;
    }
    payload.cwd = directory;
    if (payload.operation.type === "exec" && payload.operation.options?.cwd === triggerDirectory)
      payload.operation.options.cwd = directory;
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      const response = await fetch(`${remoteUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (payload.operation.type === "readBoundedBinaryFile" && holdImageRead) {
        await response.body?.cancel();
        hold = res;
        return;
      }
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch {
      res.destroy();
    }
  });
  const executorUrl = await listen(executorProxy);
  modelServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    if (modelFailure) {
      res.writeHead(500);
      res.end("provider secret=DO_NOT_EXPOSE");
      return;
    }
    const serialized = JSON.stringify(payload.input);
    if (serialized.includes("hold-run") && !serialized.includes("replacement")) {
      hold = res;
      return;
    }
    if (serialized.includes("image-round") && !toolRound) {
      toolRound = true;
      respond(res, { tool: "read_image", args: { path: imagePath } });
    } else if (serialized.includes("write-round") && !toolRound) {
      toolRound = true;
      respond(res, {
        tool: "write",
        args: { path: "remote-only.txt", content: "<remote-result>" },
      });
    } else if (serialized.includes("unsafe-round") && !toolRound) {
      toolRound = true;
      respond(res, {
        tool: "bash",
        args: { command: "printf invoked >> unsafe-marker; sleep 30" },
      });
    } else if (serialized.includes("skill-round") && !toolRound) {
      toolRound = true;
      respond(res, { tool: "load_skill", args: { name: "demo" } });
    } else if (serialized.includes("bash-round") && !toolRound) {
      toolRound = true;
      respond(res, {
        tool: "bash",
        args: {
          command: `printf '%s|%s|%s|%s' "$THOR_OPENCODE_SESSION_ID" "$THOR_OPENCODE_DIRECTORY" "$THOR_OPENCODE_CALL_ID" "$THOR_REMOTE_CLI_URL"`,
          timeout: 2,
        },
      });
    } else respond(res, { text: '<answer> & "fixture"' });
  });
  config = {
    internalSecret: "fixture-gateway-secret",
    executorUrl,
    modelBaseUrl: `${await listen(modelServer)}/v1`,
    modelId: "fixture-model",
    modelApiKey: "fixture-only",
    modelContextWindow: 65536,
    modelSupportsImages: true,
    storagePath: join(directory, "pi.sqlite"),
    skillsDir: join(directory, "skills"),
    memoryDir: join(directory, "memory"),
  };
  await openRunner();
});
afterEach(async () => {
  hold?.destroy();
  await closeServer(runnerServer);
  await runner.close();
  await closeServer(executorProxy);
  await executor.dispose();
  await closeServer(executor.server);
  await closeServer(modelServer);
  await rm(directory, { recursive: true, force: true });
});

describe("embedded Pi runner over Responses HTTP, executor HTTP and SQLite", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)(
    "sends real inline %s image input from executor-only bytes and renders a safe marker",
    async (format) => {
      const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
        .toFormat(format)
        .toBuffer();
      await writeFile(join(directory, imagePath), bytes);
      await expect(readFile(join(process.cwd(), imagePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const frames = await stream({ prompt: "image-round", requestId: "image" });
      expect(frames).toContainEqual({ type: "tool", tool: "read_image", status: "completed" });
      expect(requests).toHaveLength(2);
      const nextRequest = JSON.stringify(requests[1]);
      expect(nextRequest).toContain('"type":"input_image"');
      expect(nextRequest).toContain(`data:image/${format};base64,${bytes.toString("base64")}`);
      expect(nextRequest).toContain("3 × 2");
      expect(nextRequest).not.toContain(config.internalSecret);
      expect(nextRequest).not.toContain(config.modelApiKey);
      expect(
        executorRequests.filter((r) => r.operation.type === "readBoundedBinaryFile"),
      ).toHaveLength(1);
      expect(executorRequests.some((r) => r.operation.type === "readBinaryFile")).toBe(false);
      const receipt = await (await trigger({ prompt: "image-round", requestId: "image" })).json();
      const html = await (
        await fetch(`${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`)
      ).text();
      expect(html).toContain(`[Image attached: image/${format}]`);
      expect(html).not.toContain(bytes.toString("base64"));
      expect(html).not.toContain("data:image/");
      const log = JSON.stringify(readTriggerSlice(receipt.sessionId, receipt.triggerId));
      expect(log).not.toContain(bytes.toString("base64"));
    },
  );

  it.each([
    ["https://files.slack.com/files-pri/private-sentinel", undefined, "filesystem path"],
    ["data:image/png;base64,private-sentinel", undefined, "filesystem path"],
    ["file:///etc/passwd", undefined, "filesystem path"],
    ["//files.slack.com/private-sentinel", undefined, "filesystem path"],
    [
      "remote-image.bin",
      "<svg xmlns='http://www.w3.org/2000/svg'><image href='https://private-sentinel'/></svg>",
      "unsupported image contents",
    ],
    [
      "remote-image.bin",
      "<html><body>private-sentinel</body></html>",
      "unsupported image contents",
    ],
    ["remote-image.bin", "not an image", "unsupported image contents"],
    ["remote-image.bin", undefined, "not_found"],
  ])(
    "rejects unsafe or missing image input %s without forwarding it as image data",
    async (path, content, reason) => {
      imagePath = path;
      if (content !== undefined) await writeFile(join(directory, path), content);
      await stream({ prompt: "image-round", requestId: "image-rejected" });
      const nextRequest = JSON.stringify(requests[1]);
      expect(nextRequest).toContain(reason);
      expect(nextRequest).not.toContain('"type":"input_image"');
      if (content) expect(nextRequest).not.toContain(content);
      expect(executorRequests.some((r) => r.operation.type === "readBinaryFile")).toBe(false);
      if (reason === "filesystem path")
        expect(executorRequests.some((r) => r.operation.type === "readBoundedBinaryFile")).toBe(
          false,
        );
    },
  );

  it.each(["malformed", "decompression", "bytes", "pixels", "animated"])(
    "rejects image %s boundaries without image content",
    async (boundary) => {
      const create = {
        width: boundary === "pixels" ? 4001 : 3,
        height: boundary === "pixels" ? 4000 : 2,
        channels: 3 as const,
        background: "red",
      };
      const bytes =
        boundary === "animated"
          ? Buffer.from(
              "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAAh+QQBAAAAACwAAAAAAQABAAACAUSAOw==",
              "base64",
            )
          : await sharp({ create }).png().toBuffer();
      if (boundary === "decompression") {
        // Preserve a correct PNG envelope/CRC while independently corrupting its compressed data.
        const chunk = bytes.indexOf(Buffer.from("IDAT"));
        const length = bytes.readUInt32BE(chunk - 4);
        bytes[chunk + 4] = 0;
        bytes.writeUInt32BE(crc32(bytes.subarray(chunk, chunk + 4 + length)), chunk + 4 + length);
      }
      await writeFile(
        join(directory, imagePath),
        boundary === "malformed" ? bytes.subarray(0, bytes.length - 15) : bytes,
      );
      if (boundary === "bytes") await truncate(join(directory, imagePath), 1024 * 1024 * 1024);
      await stream({ prompt: "image-round", requestId: "image-limit" });
      const next = JSON.stringify(requests[1]);
      expect(next).toContain(
        boundary === "bytes"
          ? "10 MiB byte limit"
          : boundary === "pixels"
            ? "16 million pixel limit"
            : boundary === "animated"
              ? "animated images"
              : "malformed",
      );
      expect(next).not.toContain('"type":"input_image"');
    },
  );

  it("never falls back to a runner-local image when the remote executor is unavailable", async () => {
    imagePath = join(directory, "runner-local.png");
    await writeFile(
      imagePath,
      await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    failImageRead = true;
    await stream({ prompt: "image-round", requestId: "image-unavailable" });
    expect(JSON.stringify(requests[1])).toContain("remote file unavailable (unknown)");
    expect(JSON.stringify(requests[1])).not.toContain('"type":"input_image"');
  });

  it("cancels a remote image turn without publishing inline content or losing attribution", async () => {
    await writeFile(
      join(directory, imagePath),
      await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    holdImageRead = true;
    const accepted = await (
      await trigger({
        prompt: "image-round",
        requestId: "image-cancel",
        correlationKey: "cron:image-cancel",
        triggerSlackId: "U_IMAGE",
      })
    ).json();
    await expect.poll(() => Boolean(hold)).toBe(true);
    expect(findTriggerActor(accepted.sessionId)).toMatchObject({ slack: "U_IMAGE" });
    const frames = await stream({
      prompt: "replacement",
      requestId: "image-replacement",
      correlationKey: "cron:image-cancel",
      interrupt: true,
    });
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "completed" });
    await expect.poll(() => hold?.destroyed).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('"type":"input_image"');
    const cancelled = readTriggerSlice(accepted.sessionId, accepted.triggerId);
    expect(cancelled).toMatchObject({ status: "aborted" });
    if (!("notFound" in cancelled))
      expect(cancelled.records).toContainEqual(
        expect.objectContaining({ type: "trigger_start", triggerSlackId: "U_IMAGE" }),
      );
  });

  it("fails honestly for a text-only model before opening a remote image", async () => {
    await closeServer(runnerServer);
    await runner.close();
    config.modelSupportsImages = false;
    await openRunner();
    await stream({ prompt: "image-round", requestId: "text-model" });
    expect(JSON.stringify(requests[1])).toContain("selected model does not support images");
    expect(JSON.stringify(requests[1])).not.toContain('"type":"input_image"');
    expect(executorRequests.some((r) => r.operation.type === "readBoundedBinaryFile")).toBe(false);
  });

  it("answers, reports NDJSON, executes a remote tool round, renders escaped history and records attribution", async () => {
    const frames = await stream({
      prompt: "write-round",
      correlationKey: "cron:pi-test",
      requestId: "write-1",
      triggerSlackId: "UACTOR",
    });
    expect(frames[0]).toMatchObject({ type: "start", sessionId: expect.stringMatching(/^pi-/) });
    expect(frames).toContainEqual({ type: "tool", tool: "write", status: "completed" });
    expect(frames.some((frame) => frame.type === "text")).toBe(true);
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      response: '<answer> & "fixture"',
    });
    expect(frames).toContainEqual({
      type: "context",
      providerID: "codex-lb",
      modelID: "fixture-model",
      tokens: 27,
      limit: 65536,
      usagePercent: 0,
    });
    expect(await readFile(join(directory, "remote-only.txt"), "utf8")).toBe("<remote-result>");
    expect(executorRequests.some((request) => request.operation.type === "writeFile")).toBe(true);
    await expect(readFile(join(process.cwd(), "remote-only.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "fixture-model", reasoning: { effort: "medium" } });
    const accepted = await (
      await trigger({
        prompt: "write-round",
        correlationKey: "cron:pi-test",
        requestId: "write-1",
        triggerSlackId: "UACTOR",
      })
    ).json();
    expect(accepted).toMatchObject({ accepted: true, duplicate: true, resumed: false });
    expect(findActiveTrigger(accepted.sessionId)).toMatchObject({ ok: false, reason: "none" });
    expect(findTriggerActor(accepted.sessionId)).toMatchObject({ slack: "UACTOR" });
    expect(resolveAlias({ aliasType: "pi.conversation", aliasValue: accepted.sessionId })).toBe(
      accepted.anchorId,
    );
    const viewer = await fetch(`${runnerUrl}/runner/v/${accepted.anchorId}/${accepted.triggerId}`);
    const html = await viewer.text();
    expect(html).toContain("&lt;answer&gt; &amp; &quot;fixture&quot;");
    expect(html).not.toContain("<answer>");
    expect(html).toContain("fixture-model");
    expect(html).toContain("totalTokens");
    const log = readTriggerSlice(accepted.sessionId, accepted.triggerId);
    expect(log).toMatchObject({ status: "completed" });
    if (!("notFound" in log))
      expect(log.records.map((entry) => entry.type)).toEqual(["trigger_start", "trigger_end"]);
  });
  it("explicitly loads the remote skill catalog, root/repo memory, tool instructions and active actor", async () => {
    await mkdir(join(config.skillsDir, "demo"), { recursive: true });
    await writeFile(
      join(config.skillsDir, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demonstrate skill loading\n---\n<loaded-skill>Use the demo wrapper.</loaded-skill>",
    );
    await mkdir(join(config.memoryDir, "pi-fixture"), { recursive: true });
    await writeFile(join(config.memoryDir, "README.md"), "root memory fixture");
    await writeFile(join(config.memoryDir, "pi-fixture", "README.md"), "repo memory fixture");
    const frames = await stream({
      prompt: "skill-round",
      requestId: "skill",
      triggerGithubLogin: "alice",
    });
    expect(frames).toContainEqual({ type: "tool", tool: "load_skill", status: "completed" });
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain("Demonstrate skill loading");
    expect(prompt).toContain("root memory fixture");
    expect(prompt).toContain("repo memory fixture");
    expect(prompt).toContain("Run triggered by github: alice");
    expect(prompt).toContain("slack-post-message");
    expect(JSON.stringify(requests[1])).toContain("loaded-skill");
    expect(
      executorRequests.some(
        (request) =>
          request.operation.type === "readTextFile" &&
          request.operation.path.endsWith("demo/SKILL.md"),
      ),
    ).toBe(true);
  });

  it("deduplicates direct request IDs, rejects mismatch and serializes competing admission", async () => {
    const body = {
      prompt: "hold-run",
      requestId: "held",
      correlationKey: "cron:serial",
      triggerGithubLogin: "alice",
    };
    const first = await (await trigger(body)).json();
    const repeated = await (await trigger(body)).json();
    expect(repeated).toMatchObject({
      accepted: true,
      triggerId: first.triggerId,
      sessionId: first.sessionId,
      duplicate: true,
    });
    expect((await trigger({ ...body, prompt: "changed" })).status).toBe(409);
    expect(findActiveTrigger(first.sessionId)).toMatchObject({ triggerId: first.triggerId });
    expect(findTriggerActor(first.sessionId)).toMatchObject({ github: "alice" });
    const busy = await Promise.all([
      trigger({ prompt: "other", requestId: "other", correlationKey: "cron:serial" }),
      trigger({ prompt: "other2", requestId: "other2", correlationKey: "cron:serial" }),
    ]);
    for (const response of busy)
      expect(await response.json()).toMatchObject({ busy: true, accepted: false });
    const frames = await stream({
      prompt: "replacement",
      requestId: "replacement",
      correlationKey: "cron:serial",
      triggerGithubLogin: "bob",
      interrupt: true,
    });
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(findTriggerActor(first.sessionId)).toMatchObject({ github: "bob" });
    expect(readTriggerSlice(first.sessionId, first.triggerId)).toMatchObject({ status: "aborted" });
  });
  it("reopens the same conversation/history and prevents a second SQLite owner", async () => {
    await stream({ prompt: "first", requestId: "first", correlationKey: "cron:reopen" });
    const first = await (
      await trigger({ prompt: "first", requestId: "first", correlationKey: "cron:reopen" })
    ).json();
    const secondOwner = await createPiRunnerApp(config);
    expect(secondOwner).toEqual({ ok: false, error: "pi_storage_owned_or_unavailable" });
    await closeServer(runnerServer);
    await runner.close();
    await openRunner();
    const repeated = await (
      await trigger({ prompt: "first", requestId: "first", correlationKey: "cron:reopen" })
    ).json();
    expect(repeated).toMatchObject({
      accepted: true,
      sessionId: first.sessionId,
      triggerId: first.triggerId,
      duplicate: true,
    });
    const second = await stream({
      prompt: "second",
      requestId: "second",
      correlationKey: "cron:reopen",
    });
    expect(second[0]).toMatchObject({ sessionId: first.sessionId, resumed: true });
    expect(JSON.stringify(requests.at(-1))).toContain("first");
    expect((await fetch(`${runnerUrl}/runner/v/${first.anchorId}/${first.triggerId}`)).status).toBe(
      200,
    );
  });
  it("graceful close leaves accepted work pending and startup restores its receipt before resuming", async () => {
    const body = { prompt: "hold-run", requestId: "pending", correlationKey: "cron:recovery" };
    const accepted = await (await trigger(body)).json();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (hold) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    await closeServer(runnerServer);
    await runner.close();
    expect(readTriggerSlice(accepted.sessionId, accepted.triggerId)).toMatchObject({
      status: "in_flight",
    });
    // The fixture now answers the recovered request instead of holding it.
    modelServer.removeAllListeners("request");
    modelServer.on("request", async (req, res) => {
      for await (const _chunk of req) {
        /* Drain request. */
      }
      respond(res, { text: "recovered" });
    });
    await openRunner();
    const frames = await stream(body);
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      response: "recovered",
    });
    expect(readTriggerSlice(accepted.sessionId, accepted.triggerId)).toMatchObject({
      status: "completed",
    });
  });
  it("keeps legacy viewer history read-only and never forwards Pi session IDs to OpenCode", async () => {
    let openCodeRequests = 0;
    const openCode = createServer((_req, res) => {
      openCodeRequests++;
      res.writeHead(500);
      res.end();
    });
    const url = await listen(openCode);
    try {
      await closeServer(runnerServer);
      await runner.close();
      await openRunner({ legacyViewerApp: createRunnerApp({ opencodeUrl: url }) });
      const anchorId = mintAnchor();
      const triggerId = mintTriggerId();
      appendAlias({ aliasType: "opencode.session", aliasValue: "ses_legacy_history", anchorId });
      appendSessionEvent("ses_legacy_history", { type: "trigger_start", triggerId });
      appendSessionEvent("ses_legacy_history", {
        type: "trigger_end",
        triggerId,
        status: "completed",
      });
      const legacyViewer = await fetch(`${runnerUrl}/runner/v/${anchorId}/${triggerId}`);
      expect(legacyViewer.status).toBe(200);
      expect(await legacyViewer.text()).toContain("ses_legacy_history");
      expect(await (await fetch(`${runnerUrl}/health`)).json()).toMatchObject({
        runtime: "pi",
        status: "ok",
      });
      await stream({ prompt: "Pi only", requestId: "pi-only" });
      expect(
        (await trigger({ prompt: "must not resume legacy", sessionId: "ses_legacy_history" }))
          .status,
      ).toBe(404);
      expect(openCodeRequests).toBe(0);
    } finally {
      await closeServer(openCode);
    }
  });

  it("releases the single-owner lock after SIGKILL and resumes an accepted input without duplicating it", async () => {
    await closeServer(runnerServer);
    await runner.close();
    const moduleUrl = new URL("./pi-runner.ts", import.meta.url).href;
    const script = `import { createPiRunnerApp } from ${JSON.stringify(moduleUrl)};
      const opened = await createPiRunnerApp(${JSON.stringify(config)});
      if (!opened.ok) process.exit(2);
      const server = opened.app.listen(0, "127.0.0.1", () => console.log('http://127.0.0.1:' + server.address().port));`;
    const tsxLoader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, "--input-type=module", "-e", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const childUrl = await new Promise<string>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
        child.once("exit", () => reject(new Error("Crash fixture failed to open")));
      });
      const body = {
        directory: triggerDirectory,
        prompt: "hold-run",
        requestId: "crash-input",
        correlationKey: "cron:crash",
      };
      const response = await fetch(`${childUrl}/trigger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-thor-internal-secret": config.internalSecret,
        },
        body: JSON.stringify(body),
      });
      const accepted = await response.json();
      expect(accepted.accepted).toBe(true);
      child.kill("SIGKILL");
      await exited;
      modelServer.removeAllListeners("request");
      modelServer.on("request", async (req, res) => {
        for await (const _chunk of req) {
          /* Drain request. */
        }
        respond(res, { text: "crash recovered" });
      });
      await openRunner();
      const frames = await stream(body);
      expect(frames[0]).toMatchObject({ sessionId: accepted.sessionId });
      expect(frames.at(-1)).toMatchObject({
        type: "done",
        status: "completed",
        response: "crash recovered",
      });
      expect(readTriggerSlice(accepted.sessionId, accepted.triggerId)).toMatchObject({
        status: "completed",
      });
      const duplicate = await (await trigger(body)).json();
      expect(duplicate.triggerId).toBe(accepted.triggerId);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("attributes remote bash to the active conversation and never replays an interrupted unsafe command", async () => {
    const body = { prompt: "unsafe-round", requestId: "unsafe", correlationKey: "cron:unsafe" };
    const accepted = await (await trigger(body)).json();
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        void readFile(join(directory, "unsafe-marker"), "utf8").then(
          () => {
            clearInterval(timer);
            resolve();
          },
          () => undefined,
        );
      }, 10);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error("Unsafe tool fixture did not start"));
      }, 3000).unref();
    });
    const execution = executorRequests.find((request) => request.operation.type === "exec");
    expect(execution?.operation).toMatchObject({
      type: "exec",
      options: {
        inheritEnv: true,
        env: {
          THOR_OPENCODE_SESSION_ID: accepted.sessionId,
          THOR_OPENCODE_DIRECTORY: triggerDirectory,
          THOR_OPENCODE_CALL_ID: expect.stringContaining("call_test"),
        },
      },
    });
    await closeServer(runnerServer);
    await runner.close();
    await openRunner();
    const frames = await stream(body);
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(await readFile(join(directory, "unsafe-marker"), "utf8")).toBe("invoked");
    expect(executorRequests.filter((request) => request.operation.type === "exec")).toHaveLength(1);
  });

  it("inherits only the executor-side wrapper environment during a model-requested bash call", async () => {
    const frames = await stream({ prompt: "bash-round", requestId: "bash-env" });
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(JSON.stringify(requests[1])).toContain("http://executor-side-remote-cli");
    expect(JSON.stringify(requests[1])).toContain(triggerDirectory);
  });

  it("refuses forged actors from callers without the gateway credential", async () => {
    for (const secret of [undefined, "forged"]) {
      const response = await fetch(`${runnerUrl}/trigger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-thor-internal-secret": secret } : {}),
        },
        body: JSON.stringify({
          directory: triggerDirectory,
          prompt: "spoof",
          triggerSlackId: "U_ADMIN",
        }),
      });
      expect(response.status).toBe(401);
    }
    expect(requests).toHaveLength(0);
  });

  it("replays terminal state to reconnecting streams while Slack delivery is still blocked", async () => {
    await closeServer(runnerServer);
    await runner.close();
    let releaseDelivery: () => void = () => undefined;
    let signalBlocked: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    await openRunner({
      progressTransport: {
        async post() {
          return { ts: "fixture-ts" };
        },
        async update() {},
        async delete() {},
        async addReaction() {
          signalBlocked();
          await delivery;
        },
      },
    });
    modelFailure = true;
    const body = {
      prompt: "failed",
      requestId: "terminal-reconnect",
      correlationKey: "slack:thread:C_RECONNECT/1710000000.009",
    };
    try {
      expect((await stream(body)).at(-1)).toMatchObject({ type: "done", status: "error" });
      await blocked;
      const repeated = await Promise.race([
        stream(body),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Terminal stream did not settle")), 1000).unref();
        }),
      ]);
      expect(repeated.at(-1)).toMatchObject({ type: "done", status: "error" });
    } finally {
      releaseDelivery();
    }
  });

  it("fails safely for invalid directories and provider errors without exposing provider secrets", async () => {
    expect((await trigger({ prompt: "test", directory: "/etc" })).status).toBe(400);
    const malformed = await fetch(`${runnerUrl}/trigger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-thor-internal-secret": config.internalSecret,
      },
      body: '{"secret":"must-not-echo", invalid}',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('{"error":"invalid_trigger_json"}');
    expect((await trigger({ prompt: "test", sessionId: "legacy-session" })).status).toBe(404);
    modelFailure = true;
    const frames = await stream({ prompt: "fail", requestId: "failure" });
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "error", error: "Pi run failed" });
    expect(JSON.stringify(frames)).not.toContain("DO_NOT_EXPOSE");
  });
});
