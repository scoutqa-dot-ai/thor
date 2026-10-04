import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  AgentDoc,
  configure,
  createRegistry,
  type Tx,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { piConversationMetadataDoc } from "./pi-runner-state.js";
import { executeBatchDispatchPlan, planBatchDispatch } from "../../gateway/src/service.js";
import { persistBatchRunnerRequest } from "../../gateway/src/batch-request.js";
import { createConfigLoader } from "@thor/common";
import { clearRegistry, type ProgressEvent } from "@thor/common";
import { createSlackProgressTransport } from "./slack-progress.js";

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

function respondAfterThinking(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let sequence_number = 0;
  const emit = (event: object) =>
    res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence_number++ })}\n\n`);
  emit({ type: "response.created", response: { id: "resp_thought" } });
  const reasoning = {
    type: "reasoning",
    id: "rs_thought",
    summary: [{ type: "summary_text", text: "private-reasoning-fixture" }],
  };
  emit({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...reasoning, summary: [] },
  });
  emit({
    type: "response.reasoning_summary_text.delta",
    output_index: 0,
    summary_index: 0,
    delta: "private-reasoning-fixture",
  });
  const timer = setTimeout(() => {
    emit({ type: "response.output_item.done", output_index: 0, item: reasoning });
    const item = {
      type: "message",
      id: "msg_thought",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Visible answer", annotations: [] }],
    };
    emit({ type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } });
    for (const delta of ["Visible", " ", "answer"])
      emit({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta });
    emit({ type: "response.output_item.done", output_index: 1, item });
    emit({
      type: "response.completed",
      response: {
        id: "resp_thought",
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
  }, 1800);
  res.once("close", () => clearTimeout(timer));
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
let modelActions: Array<{ text: string } | { tool: string; args: object }>;
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
  modelActions = [];
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
    const action = modelActions.shift();
    if (action) {
      respond(res, action);
      return;
    }
    if (modelFailure) {
      res.writeHead(500);
      res.end("provider secret=DO_NOT_EXPOSE");
      return;
    }
    const serialized = JSON.stringify(payload.input);
    if (
      serialized.includes("hold-run") &&
      !serialized.includes("replacement") &&
      !JSON.stringify(payload).includes("Google authorization continuation:")
    ) {
      hold = res;
      return;
    }
    if (serialized.includes("fixture-thinking-delay")) {
      respondAfterThinking(res);
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
  clearRegistry();
  hold?.destroy();
  await closeServer(runnerServer);
  await runner.close();
  await closeServer(executorProxy);
  await executor.dispose();
  await closeServer(executor.server);
  await closeServer(modelServer);
  await rm(directory, { recursive: true, force: true });
});

async function continuationBroker() {
  let records: import("@thor/common").GoogleAuthContinuation[] = [];
  let ackUnavailable = false;
  let bindingSupported = true;
  const acks: string[] = [];
  const server = createServer(async (req, res) => {
    expect(req.headers["x-thor-internal-secret"]).toBe(config.internalSecret);
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/google-workspace/continuations")
      res.end(JSON.stringify({ continuations: records }));
    else if (req.url === "/internal/google-workspace/waits")
      res.end(JSON.stringify({ waits: records }));
    else if (req.url === "/internal/google-workspace/diagnostics")
      res.end(
        JSON.stringify({ oauth: { configured: true }, identity: { ok: true, connected: true } }),
      );
    else if (req.url?.endsWith("/ack")) {
      acks.push(req.url);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const binding: { dispatchTriggerId?: string } = JSON.parse(Buffer.concat(chunks).toString());
      res.statusCode = ackUnavailable ? 503 : 200;
      res.end(
        JSON.stringify({
          acknowledged: !ackUnavailable,
          ...(binding.dispatchTriggerId && bindingSupported
            ? { dispatchTriggerId: binding.dispatchTriggerId }
            : {}),
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const url = await listen(server);
  await closeServer(runnerServer);
  await runner.close();
  config.slackTeamId = "T123";
  await openRunner({ remoteCliUrl: url });
  return {
    url,
    acks,
    publish(
      receipt: { sessionId: string; anchorId: string; triggerId: string },
      patch: Partial<import("@thor/common").GoogleAuthContinuation> = {},
    ) {
      records = [
        {
          id: "continuation_invitation_fixture",
          ...receipt,
          slackTeamId: "T123",
          slackUserId: "UOWNER",
          connectionId: "10000000-0000-4000-8000-000000000001",
          args: ["docs", "documents", "create", "--json", '{"title":"original title"}'],
          createdAtMs: Date.now() - 1000,
          expiresAtMs: Date.now() + 60000,
          ...patch,
        },
      ];
    },
    setAckUnavailable(value: boolean) {
      ackUnavailable = value;
    },
    setBindingSupported(value: boolean) {
      bindingSupported = value;
    },
    close: () => closeServer(server),
  };
}

describe("Google authorization durable admission", () => {
  const continuationInputs = () =>
    requests.filter((input) =>
      JSON.stringify(input).includes("Google authorization continuation:"),
    );
  it("defers callback-before-turn-finish, resumes exactly once and deduplicates redelivery across restart", async () => {
    const broker = await continuationBroker();
    try {
      const body = {
        prompt: "hold-run",
        requestId: "original",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      };
      const receipt = await (await trigger(body)).json();
      await vi.waitFor(() => expect(hold).toBeDefined());
      broker.publish(receipt);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(continuationInputs()).toHaveLength(0);
      expect(broker.acks).toHaveLength(0);
      if (!hold) throw new Error("Held original turn missing");
      respond(hold, { text: "Waiting for Google sign-in" });
      await vi.waitFor(() => expect(continuationInputs()).toHaveLength(1), { timeout: 4000 });
      await vi.waitFor(() => expect(findActiveTrigger(receipt.sessionId).ok).toBe(false));
      const sourceInput = JSON.stringify(continuationInputs()[0]);
      expect(sourceInput).toContain("hold-run");
      expect(sourceInput).toContain("original title");
      expect(sourceInput).not.toContain(config.internalSecret);
      await closeServer(runnerServer);
      await runner.close();
      await openRunner({ remoteCliUrl: broker.url });
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(continuationInputs()).toHaveLength(1);
      expect(broker.acks.length).toBeGreaterThan(1);
      expect(
        (await trigger({ ...body, requestId: "google-auth:continuation_invitation_fixture" }))
          .status,
      ).toBe(400);
    } finally {
      await broker.close();
    }
  });

  it("recovers durable admission when acknowledgement fails before submit and the runner restarts", async () => {
    const broker = await continuationBroker();
    try {
      await stream({
        prompt: "original task",
        requestId: "original",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      });
      const receipt = await (
        await trigger({
          prompt: "original task",
          requestId: "original",
          correlationKey: "cron:auth",
          triggerSlackId: "UOWNER",
        })
      ).json();
      broker.setAckUnavailable(true);
      broker.publish(receipt);
      await vi.waitFor(() => expect(broker.acks.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(continuationInputs()).toHaveLength(0);
      await closeServer(runnerServer);
      await runner.close();
      await openRunner({ remoteCliUrl: broker.url });
      broker.setAckUnavailable(false);
      await vi.waitFor(() => expect(continuationInputs()).toHaveLength(1), { timeout: 4000 });
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(continuationInputs()).toHaveLength(1);
    } finally {
      await broker.close();
    }
  });

  it("a new human request supersedes a durable but undispatched auth continuation without requiring interrupt", async () => {
    const broker = await continuationBroker();
    try {
      const body = {
        prompt: "original task",
        requestId: "original",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      };
      await stream(body);
      const receipt = await (await trigger(body)).json();
      broker.setAckUnavailable(true);
      broker.publish(receipt);
      await vi.waitFor(() => expect(broker.acks.length).toBeGreaterThan(0), { timeout: 3000 });
      const replacement = await stream({
        prompt: "replacement",
        requestId: "replacement",
        correlationKey: "cron:auth",
        triggerSlackId: "UOTHER",
      });
      expect(replacement.at(-1)).toMatchObject({ type: "done", status: "completed" });
      broker.setAckUnavailable(false);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(continuationInputs()).toHaveLength(0);
      expect(findTriggerActor(receipt.sessionId)).toEqual({ slack: "UOTHER" });
    } finally {
      await broker.close();
    }
  });

  it("a legacy acknowledgement without a dispatch binding cannot start an admitted continuation", async () => {
    const broker = await continuationBroker();
    try {
      const body = {
        prompt: "original task",
        requestId: "original",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      };
      await stream(body);
      const receipt = await (await trigger(body)).json();
      broker.setBindingSupported(false);
      broker.publish(receipt);
      await vi.waitFor(() => expect(broker.acks.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(continuationInputs()).toHaveLength(0);
      await stream({
        prompt: "replacement",
        requestId: "replacement",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      });
      expect(continuationInputs()).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });

  it("ignores externally supplied continuation metadata and reserves internal admission identities", async () => {
    const broker = await continuationBroker();
    try {
      await stream({
        prompt: "ordinary human request",
        requestId: "ordinary",
        triggerSlackId: "UOWNER",
        googleAuthSource: { id: "forged-continuation", args: ["docs", "documents", "create"] },
      });
      expect(continuationInputs()).toHaveLength(0);
      expect((await trigger({ prompt: "spoof", requestId: "google-auth:forged" })).status).toBe(
        400,
      );
    } finally {
      await broker.close();
    }
  });

  it.each([
    "sessionId",
    "anchorId",
    "triggerId",
    "slackUserId",
    "slackTeamId",
    "expired",
    "new-requester",
    "new-turn",
    "interrupt",
  ])("never resurrects work with %s", async (scenario) => {
    const broker = await continuationBroker();
    try {
      const body = {
        prompt: scenario === "interrupt" ? "hold-run" : "original task",
        requestId: "original",
        correlationKey: "cron:auth",
        triggerSlackId: "UOWNER",
      };
      const receipt = await (await trigger(body)).json();
      if (scenario === "interrupt") {
        await vi.waitFor(() => expect(hold).toBeDefined());
        await stream({
          prompt: "replacement",
          requestId: "replacement",
          correlationKey: "cron:auth",
          triggerSlackId: "UOWNER",
          interrupt: true,
        });
      } else {
        await stream(body);
        if (scenario === "new-requester" || scenario === "new-turn")
          await stream({
            prompt: "replacement",
            requestId: "replacement",
            correlationKey: "cron:auth",
            triggerSlackId: scenario === "new-requester" ? "UOTHER" : "UOWNER",
          });
      }
      const patch =
        scenario === "expired"
          ? { expiresAtMs: Date.now() - 1 }
          : ["sessionId", "anchorId", "triggerId", "slackUserId", "slackTeamId"].includes(scenario)
            ? { [scenario]: "wrong-binding" }
            : {};
      broker.publish(receipt, patch);
      await vi.waitFor(() => expect(broker.acks.length).toBeGreaterThan(0), { timeout: 4000 });
      expect(continuationInputs()).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });
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
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "tool", tool: "read_image", status: "completed" }),
      );
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
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "tool", tool: "write", status: "completed" }),
    );
    expect(frames.some((frame) => frame.type === "text")).toBe(true);
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      response: '<answer> & "fixture"',
    });
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "context",
        providerID: "codex-lb",
        modelID: "fixture-model",
        tokens: 27,
        limit: 65536,
        usagePercent: 0,
      }),
    );
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
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "tool", tool: "load_skill", status: "completed" }),
    );
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain("You are Neo");
    expect(prompt).not.toContain("You are Thor");
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

async function editPiNativeDocuments(change: (tx: Tx, id: ConversationId) => Promise<void>) {
  await closeServer(runnerServer);
  await runner.close();
  const storage = await openNodeSqliteStorage(config.storagePath);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    await harness.commit(async (tx) => {
      const conversations = await tx.scanConversations({}, 200);
      for (const conversation of conversations.items) await change(tx, conversation.id);
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

describe("native Pi activity through the real Slack SDK", () => {
  async function slackFixture(reactionError?: "already_reacted" | "invalid_auth") {
    const deliveries: Array<{ method: string; form: URLSearchParams }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      deliveries.push({
        method: req.url ?? "",
        form: new URLSearchParams(Buffer.concat(chunks).toString()),
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          (req.url === "/reactions.add" || req.url === "/reactions.remove") && reactionError
            ? {
                ok: false,
                error:
                  req.url === "/reactions.remove" && reactionError === "already_reacted"
                    ? "no_reaction"
                    : reactionError,
              }
            : { ok: true, ts: `footer-${deliveries.length}` },
        ),
      );
    });
    const url = await listen(server);
    const progressTransport = createSlackProgressTransport({
      token: "dummy-slack-token",
      slackApiUrl: `${url}/`,
    });
    const events: ProgressEvent[] = [];
    config.runnerBaseUrl = "https://neo.example.test/private/viewer/path";
    return {
      deliveries,
      events,
      progressTransport,
      progressEventSink: (event: ProgressEvent) => events.push(event),
      close: async () => {
        // Keep the SDK endpoint alive until terminal footer delivery has drained.
        await closeServer(runnerServer);
        await runner.close();
        await closeServer(server);
        await openRunner();
      },
    };
  }
  async function reopenProgress(
    fixture: Awaited<ReturnType<typeof slackFixture>>,
    remoteCliUrl?: string,
  ) {
    await closeServer(runnerServer);
    await runner.close();
    await openRunner({
      progressTransport: fixture.progressTransport,
      progressEventSink: fixture.progressEventSink,
      remoteCliUrl,
    });
  }
  const correlationKey = "slack:thread:C_CURRENT/1710000000.001";
  const posts = (fixture: Awaited<ReturnType<typeof slackFixture>>) =>
    fixture.deliveries.filter((entry) => entry.method === "/chat.postMessage");
  const checks = (fixture: Awaited<ReturnType<typeof slackFixture>>) =>
    fixture.deliveries.filter((entry) => entry.method === "/reactions.add");
  const removals = (fixture: Awaited<ReturnType<typeof slackFixture>>) =>
    fixture.deliveries.filter((entry) => entry.method === "/reactions.remove");

  it("shows delayed zero-tool model activity, replaces animation on text output, and checks successive current messages", async () => {
    const fixture = await slackFixture();
    try {
      await reopenProgress(fixture);
      const pending = stream({
        prompt: "hold-run",
        requestId: "long-thought",
        correlationKey,
        triggerSlackId: "U_CURRENT",
        messageTs: "1710000000.002",
      });
      await vi.waitFor(() => expect(hold).toBeDefined());
      await vi.waitFor(() => expect(posts(fixture)).toHaveLength(1), { timeout: 3000 });
      const footer = posts(fixture)[0].form;
      expect(JSON.parse(footer.get("blocks") ?? "[]")[0].elements).toContainEqual({
        type: "plain_text",
        text: "Model: fixture-model · Thinking: medium",
        emoji: false,
      });
      expect(footer.get("thread_ts")).toBe("1710000000.001");
      expect(footer.get("text")).toMatch(/^Neo thinking\.\.\. 0 tool calls/);
      expect(JSON.parse(footer.get("blocks") ?? "[]")[0].elements[0].image_url).toBe(
        "https://neo.example.test/neo-thinking-v1.gif",
      );
      if (!hold) throw new Error("Held model response missing");
      respond(hold, { text: "Visible answer" });
      const frames = await pending;
      expect(frames.at(-1)).toMatchObject({
        requestId: "long-thought",
        status: "completed",
        toolCalls: [],
      });
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1));
      expect(checks(fixture)[0].form.get("timestamp")).toBe("1710000000.002");
      expect(checks(fixture)[0].form.get("name")).toBe("white_check_mark");
      expect(removals(fixture)[0].form.get("timestamp")).toBe("1710000000.002");
      expect(removals(fixture)[0].form.get("channel")).toBe("C_CURRENT");
      expect(removals(fixture)[0].form.get("name")).toBe("eyes");
      const updates = fixture.deliveries.filter((entry) => entry.method === "/chat.update");
      expect(
        updates.some(
          (entry) =>
            entry.form.get("text")?.includes("Neo responding") &&
            entry.form.get("blocks")?.includes("neo-ai-still-v1.png"),
        ),
      ).toBe(true);
      expect(
        fixture.events.every((event) => event.requestId === "long-thought" && !!event.sessionId),
      ).toBe(true);
      expect(fixture.events.filter((event) => event.type === "activity")).toEqual([
        expect.objectContaining({ activity: "responding" }),
      ]);
      const followup = await stream({
        prompt: "replacement follow-up",
        requestId: "short-followup",
        correlationKey,
        triggerSlackId: "U_CURRENT",
        messageTs: "1710000000.003",
      });
      expect(followup[0].sessionId).toBe(frames[0].sessionId);
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(2));
      expect(checks(fixture)[1].form.get("timestamp")).toBe("1710000000.003");
      expect(removals(fixture)[1].form.get("timestamp")).toBe("1710000000.003");
      expect(posts(fixture)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("ignores private native reasoning content while showing long model-only work and coalescing text output", async () => {
    const fixture = await slackFixture();
    try {
      await reopenProgress(fixture);
      const frames = await stream({
        prompt: "fixture-thinking-delay",
        requestId: "reasoning-only",
        correlationKey,
        messageTs: "1710000000.010",
      });
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1));
      expect(posts(fixture)[0].form.get("text")).toContain("Neo thinking... 0 tool calls");
      expect(frames.at(-1)).toMatchObject({
        status: "completed",
        response: "Visible answer",
        toolCalls: [],
      });
      expect(JSON.stringify(frames)).not.toContain("private-reasoning-fixture");
      expect(JSON.stringify(fixture.events)).not.toContain("private-reasoning-fixture");
      expect(
        fixture.deliveries.some((entry) =>
          entry.form.toString().includes("private-reasoning-fixture"),
        ),
      ).toBe(false);
      expect(
        fixture.events.filter(
          (event) => event.type === "activity" && event.activity === "responding",
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("projects observable tool start/finish without double counting and checks a one-tool success", async () => {
    const fixture = await slackFixture();
    try {
      await reopenProgress(fixture);
      modelActions = [
        { tool: "bash", args: { command: "sleep 1.8; printf complete", timeout: 3 } },
        { text: "Tool completed" },
      ];
      const frames = await stream({
        prompt: "one slow tool",
        requestId: "working",
        correlationKey,
        messageTs: "1710000000.004",
      });
      expect(posts(fixture)[0].form.get("text")).toContain("Neo working... 0 tool calls");
      expect(posts(fixture)[0].form.get("blocks")).toContain("neo-working-v1.gif");
      expect(
        fixture.deliveries.some((entry) =>
          entry.form.get("text")?.includes("Neo thinking... 1 tool calls"),
        ),
      ).toBe(true);
      expect(frames.filter((frame) => frame.type === "tool").map((frame) => frame.status)).toEqual([
        "running",
        "completed",
      ]);
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1));
      expect(
        fixture.deliveries.some((entry) => entry.form.get("text")?.includes("Done — 1 tool calls")),
      ).toBe(true);
      expect(checks(fixture)[0].form.get("timestamp")).toBe("1710000000.004");
    } finally {
      await fixture.close();
    }
  });

  it("does not check an interrupted native request, but checks only its successful replacement", async () => {
    const fixture = await slackFixture();
    try {
      await reopenProgress(fixture);
      const body = {
        prompt: "hold-run",
        requestId: "old-turn",
        correlationKey,
        messageTs: "1710000000.005",
      };
      await trigger(body);
      await vi.waitFor(() => expect(posts(fixture)).toHaveLength(1), { timeout: 3000 });
      const replacement = await stream({
        ...body,
        prompt: "replacement",
        requestId: "new-turn",
        messageTs: "1710000000.006",
        interrupt: true,
      });
      expect(replacement.at(-1)).toMatchObject({ status: "completed" });
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1));
      expect(checks(fixture)[0].form.get("timestamp")).toBe("1710000000.006");
      expect(fixture.deliveries.some((entry) => entry.method === "/chat.delete")).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("leaves OAuth waiting static without a check, then resumes against the original human source", async () => {
    const fixture = await slackFixture();
    const broker = await continuationBroker();
    try {
      await reopenProgress(fixture, broker.url);
      broker.setAckUnavailable(true);
      const body = {
        prompt: "hold-run",
        requestId: "auth-original",
        correlationKey,
        triggerSlackId: "UOWNER",
        messageTs: "1710000000.007",
      };
      const receipt = await (await trigger(body)).json();
      await vi.waitFor(() => expect(hold).toBeDefined());
      broker.publish(receipt);
      if (!hold) throw new Error("Held auth response missing");
      respond(hold, { text: "Waiting for Google sign-in" });
      await vi.waitFor(() =>
        expect(
          fixture.deliveries.some((entry) =>
            entry.form.get("text")?.includes("Neo waiting for Google sign-in"),
          ),
        ).toBe(true),
      );
      expect(checks(fixture)).toHaveLength(0);
      expect(removals(fixture)).toHaveLength(0);
      const waiting = fixture.deliveries.findLast((entry) =>
        entry.form.get("text")?.includes("Neo waiting for Google sign-in"),
      );
      expect(waiting?.form.get("blocks")).toContain("neo-ai-still-v1.png");
      expect(waiting?.form.get("blocks")).toContain("Model: fixture-model · Thinking: medium");
      broker.setAckUnavailable(false);
      await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1), { timeout: 4000 });
      expect(checks(fixture)[0].form.get("timestamp")).toBe("1710000000.007");
      expect(removals(fixture)[0].form.get("timestamp")).toBe("1710000000.007");
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "start",
          requestId: "google-auth:continuation_invitation_fixture",
          resumed: true,
        }),
      );
    } finally {
      await broker.close();
      await fixture.close();
    }
  });

  it.each(["already_reacted", "invalid_auth"] as const)(
    "keeps native completion independent of Slack reaction outcome (%s)",
    async (reactionError) => {
      const fixture = await slackFixture(reactionError);
      try {
        await reopenProgress(fixture);
        const frames = await stream({
          prompt: "short answer",
          requestId: "sdk-reaction",
          correlationKey,
          messageTs: "1710000000.008",
        });
        expect(frames.at(-1)).toMatchObject({ status: "completed" });
        await vi.waitFor(() => expect(checks(fixture)).toHaveLength(1));
        expect(checks(fixture)[0].form.get("name")).toBe("white_check_mark");
      } finally {
        await fixture.close();
      }
    },
  );

  it("never sends a success reaction for a failed native model turn", async () => {
    const fixture = await slackFixture();
    try {
      await reopenProgress(fixture);
      modelFailure = true;
      const frames = await stream({
        prompt: "fail",
        requestId: "sdk-error",
        correlationKey,
        messageTs: "1710000000.009",
      });
      expect(frames.at(-1)).toMatchObject({ status: "error" });
      expect(
        fixture.deliveries.filter((entry) => entry.form.get("name") === "white_check_mark"),
      ).toHaveLength(0);
      expect(JSON.stringify(fixture.events)).not.toContain("DO_NOT_EXPOSE");
    } finally {
      await fixture.close();
    }
  });

  it("rejects a malformed direct message timestamp before model execution", async () => {
    expect(
      (await trigger({ prompt: "task", messageTs: "1710000000.002?cap=private" })).status,
    ).toBe(400);
    expect(requests).toHaveLength(0);
  });
});

describe("per-task native model routing", () => {
  const workspace = {
    pi: {
      modelRouting: {
        profiles: {
          fast: { modelId: "fixture-fast" },
          balanced: { modelId: "fixture-balanced" },
          strong: { modelId: "fixture-strong" },
        },
      },
    },
  };
  async function reopenRouting(extra: Parameters<typeof createPiRunnerApp>[1] = {}) {
    await closeServer(runnerServer);
    await runner.close();
    await openRunner({ configLoader: () => workspace, ...extra });
  }
  it("delivers trusted current Slack selectors through the actual gateway HTTP transport into Pi and freezes retries", async () => {
    await reopenRouting();
    const plan = await planBatchDispatch({
      requestId: "gateway-actual-pi",
      slackEvents: [
        {
          type: "app_mention",
          channel: "C123",
          thread_ts: "1",
          ts: "1",
          user: "U1",
          text: "[profile:fast] old history",
        },
        {
          type: "app_mention",
          channel: "C123",
          thread_ts: "1",
          ts: "2",
          user: "U1",
          text: "<@UBOT> [model:fixture-strong thinking:low] Create a Google document",
        },
        {
          type: "app_mention",
          channel: "C123",
          thread_ts: "1",
          ts: "3",
          user: "U2",
          text: "[profile:fast] bystander",
        },
      ],
      cronEvents: [],
      githubEvents: [],
      approvalOutcomes: [],
      correlationKey: "slack:C123:1",
      triggerSlackId: "U1",
      deps: { runnerUrl, internalSecret: config.internalSecret },
      slackDirectoryForChannel: () => ({ directory: triggerDirectory }),
    });
    if (plan.kind !== "dispatch") throw new Error("Expected Pi gateway dispatch");
    const queue = join(directory, "routing-queue");
    await mkdir(queue);
    const frozen = persistBatchRunnerRequest(queue, {
      ...plan.options,
      requestId: "gateway-actual-pi",
    });
    expect(await executeBatchDispatchPlan({ ...plan, options: frozen })).toMatchObject({
      busy: false,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ model: "fixture-strong", reasoning: { effort: "low" } });
    const retry = persistBatchRunnerRequest(queue, {
      ...plan.options,
      modelProfile: "fast",
      modelId: undefined,
      thinkingLevel: "high",
      routingTask: "different",
    });
    expect(await executeBatchDispatchPlan({ ...plan, options: retry })).toMatchObject({
      busy: false,
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects declared invalid routing from the real config loader without exposing diagnostics or falling back", async () => {
    await closeServer(runnerServer);
    await runner.close();
    const path = join(directory, "operator-config.json");
    await writeFile(
      path,
      JSON.stringify({
        pi: {
          modelRouting: {
            profiles: {
              strong: { modelId: "fixture-strong", thinkingLevel: "secret-DO_NOT_EXPOSE" },
            },
          },
        },
      }),
    );
    expect(await createPiRunnerApp(config, { configLoader: createConfigLoader(path) })).toEqual({
      ok: false,
      error: "pi_startup_failed",
    });
    expect(requests).toHaveLength(0);
    await writeFile(path, JSON.stringify(workspace));
    await openRunner({ configLoader: createConfigLoader(path) });
    await stream({ prompt: "Create a Google document" });
    expect(requests[0]).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
  });

  it("selects actual HTTP model and effort per human task, freezes retries, and attributes each viewer", async () => {
    const loader = vi.fn(() => workspace);
    await reopenRouting({ configLoader: loader });
    const first = {
      prompt: "Create a Google document",
      requestId: "route-fast",
      correlationKey: "cron:routing",
    };
    await stream(first);
    const receipt = await (await trigger(first)).json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
    await stream({
      prompt: "Investigate the architecture",
      requestId: "route-strong",
      sessionId: receipt.sessionId,
    });
    expect(requests[1]).toMatchObject({ model: "fixture-strong", reasoning: { effort: "high" } });
    const html = await (
      await fetch(`${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`)
    ).text();
    expect(html).toContain("fixture-fast · thinking low · profile fast");
    expect(html).not.toContain("<h3>codex-lb/fixture-strong</h3>");
    expect(loader).toHaveBeenCalledTimes(1);
    await reopenRouting({
      configLoader: () => ({
        pi: {
          modelRouting: {
            profiles: {
              fast: { modelId: "fixture-strong" },
              balanced: { modelId: "fixture-balanced" },
              strong: { modelId: "fixture-fast" },
            },
          },
        },
      }),
    });
    await stream(first);
    expect(requests).toHaveLength(2); // Completed retry never routes again or executes a new request.
    await stream({
      prompt: "Create a Google document",
      requestId: "new-human",
      sessionId: receipt.sessionId,
    });
    expect(requests[2]).toMatchObject({ model: "fixture-strong", reasoning: { effort: "low" } });
  });

  it.each([
    [{ modelProfile: "strong", thinkingLevel: "minimal" }, "fixture-strong", "minimal"],
    [{ modelId: "fixture-fast", thinkingLevel: "high" }, "fixture-fast", "high"],
    [{ thinkingLevel: "low" }, "fixture-balanced", "low"],
  ])(
    "honors explicit overrides and denies escalation without changing native choices (%j)",
    async (overrides, model, effort) => {
      await reopenRouting();
      modelActions = [
        { tool: "escalate_model", args: { profile: "strong", reason: "Need deeper reasoning" } },
        { text: "done" },
      ];
      const frames = await stream({ prompt: "Implement a feature", ...overrides });
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "tool", tool: "escalate_model", status: "error" }),
      );
      expect(requests).toHaveLength(2);
      for (const input of requests) expect(input).toMatchObject({ model, reasoning: { effort } });
      expect(JSON.stringify(requests)).not.toContain(config.modelApiKey);
      expect(JSON.stringify(requests)).not.toContain(config.internalSecret);
    },
  );

  it.each([
    { modelProfile: "strong", modelId: "fixture-fast" },
    { modelProfile: "unconfigured" },
    { thinkingLevel: "xhigh" },
    { modelId: "not-in-pool" },
  ])("rejects invalid external selection before model/tool execution (%j)", async (overrides) => {
    await reopenRouting();
    expect((await trigger({ prompt: "Run tool", ...overrides })).status).toBe(400);
    expect(requests).toHaveLength(0);
    expect(executorRequests).toHaveLength(0);
  });

  it("restart with supported but reordered profiles keeps the active frozen choice, while disabled auto routing uses the fresh default", async () => {
    await reopenRouting();
    const body = { prompt: "hold-run Create a Google document", requestId: "pool-reload" };
    const receipt = await (await trigger(body)).json();
    await vi.waitFor(() => expect(hold).toBeDefined());
    modelActions = [{ text: "frozen recovery" }];
    await reopenRouting({
      configLoader: () => ({
        pi: {
          modelRouting: {
            autoSelect: false,
            defaultProfile: "strong",
            profiles: {
              fast: { modelId: "fixture-strong" },
              balanced: { modelId: "fixture-balanced" },
              strong: { modelId: "fixture-fast" },
            },
          },
        },
      }),
    });
    await stream(body);
    expect(requests).toHaveLength(2);
    for (const input of requests)
      expect(input).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
    modelActions = [
      {
        tool: "escalate_model",
        args: { profile: "strong", reason: "default tasks are not automatic" },
      },
      { text: "new default settled" },
    ];
    const frames = await stream({
      prompt: "replacement Read a Google document",
      requestId: "fresh-default",
      sessionId: receipt.sessionId,
    });
    expect(requests.at(-1)).toMatchObject({ model: "fixture-fast", reasoning: { effort: "high" } });
    expect(JSON.stringify(requests.at(-1))).toContain(
      "Model escalation is unavailable for this task",
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "tool", tool: "escalate_model", status: "error" }),
    );
  });

  it.each(["fast", "balanced", "strong"] as const)(
    "honestly shares the existing image capability and credential boundary with profile %s",
    async (modelProfile) => {
      await reopenRouting();
      const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer();
      await writeFile(join(directory, imagePath), bytes);
      const frames = await stream({ prompt: "image-round", modelProfile });
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "tool", tool: "read_image", status: "completed" }),
      );
      expect(requests[1]).toMatchObject({ model: `fixture-${modelProfile}` });
      const input = JSON.stringify(requests[1]);
      expect(input).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
      expect(input).not.toContain(config.internalSecret);
      expect(input).not.toContain(config.modelApiKey);
      expect(JSON.stringify(executorRequests)).not.toContain(config.modelApiKey);
    },
  );

  it("routing evidence participates in duplicate identity and injected saved authority is stripped", async () => {
    await reopenRouting();
    const body = {
      prompt: "history says investigate architecture",
      routingTask: "read docs.google.com/document/d/example",
      requestId: "frozen-task",
    };
    await stream({
      ...body,
      modelSelection: { modelId: "attacker", history: [] },
      source: "explicit_model",
      pool: {},
      promotions: 2,
    });
    expect(requests[0]).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
    for (const patch of [
      { routingTask: "investigate architecture" },
      { thinkingLevel: "high" },
      { modelProfile: "strong" },
      { modelId: "fixture-strong" },
    ])
      expect((await trigger({ ...body, ...patch })).status).toBe(409);
    expect(requests).toHaveLength(1);
  });

  it("promotes exactly twice, denies skip/self-loop/downgrade/third promotion, and saves truthful response models", async () => {
    const progressModels: ProgressEvent[] = [];
    await reopenRouting({ progressEventSink: (event) => progressModels.push(event) });
    modelActions = [
      { tool: "escalate_model", args: { profile: "strong", reason: "skip" } },
      { tool: "escalate_model", args: { profile: "balanced", reason: "Need more reasoning" } },
      { tool: "escalate_model", args: { profile: "balanced", reason: "self loop" } },
      { tool: "escalate_model", args: { profile: "strong", reason: "Need investigation" } },
      { tool: "escalate_model", args: { profile: "balanced", reason: "downgrade" } },
      { tool: "escalate_model", args: { profile: "strong", reason: "third" } },
      { text: "done" },
    ];
    const body = { prompt: "Read a Google document", requestId: "promoted" };
    const frames = await stream(body);
    expect(
      progressModels
        .filter((event) => event.type === "model")
        .map((event) => [event.modelId, event.thinkingLevel]),
    ).toEqual([
      ["fixture-fast", "low"],
      ["fixture-balanced", "medium"],
      ["fixture-strong", "high"],
    ]);
    expect(
      frames.filter((frame) => frame.type === "tool" && frame.status === "completed"),
    ).toHaveLength(2);
    expect(
      frames.filter((frame) => frame.type === "tool" && frame.status === "error"),
    ).toHaveLength(4);
    expect(requests.map((input) => [input.model, input.reasoning])).toEqual([
      ["fixture-fast", { effort: "low", summary: "auto" }],
      ["fixture-fast", { effort: "low", summary: "auto" }],
      ["fixture-balanced", { effort: "medium", summary: "auto" }],
      ["fixture-balanced", { effort: "medium", summary: "auto" }],
      ["fixture-strong", { effort: "high", summary: "auto" }],
      ["fixture-strong", { effort: "high", summary: "auto" }],
      ["fixture-strong", { effort: "high", summary: "auto" }],
    ]);
    const receipt = await (await trigger(body)).json();
    const html = await (
      await fetch(`${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`)
    ).text();
    expect(html).toContain("fixture-strong · thinking high · profile strong");
    expect(html).toContain("Need more reasoning");
    expect(html).toContain("Need investigation");
    for (const model of ["fixture-fast", "fixture-balanced", "fixture-strong"])
      expect(html).toContain(`codex-lb/${model}`);
    await reopenRouting();
    await stream(body);
    expect(requests).toHaveLength(7);
    expect(JSON.stringify(requests.at(-1))).toContain(
      "Model escalation is unavailable for this task",
    );
  });

  it("Google admission, failed ack and restart copy the original final escalated choice", async () => {
    const broker = await continuationBroker();
    try {
      await reopenRouting({ remoteCliUrl: broker.url });
      modelActions = [
        {
          tool: "escalate_model",
          args: { profile: "balanced", reason: "Google task became harder" },
        },
        { text: "waiting" },
      ];
      const body = {
        prompt: "Create a Google document",
        requestId: "oauth-route",
        triggerSlackId: "UOWNER",
      };
      await stream(body);
      const receipt = await (await trigger(body)).json();
      broker.setAckUnavailable(true);
      broker.publish(receipt);
      await vi.waitFor(() => expect(broker.acks.length).toBeGreaterThan(0), { timeout: 3500 });
      expect(requests).toHaveLength(2);
      await reopenRouting({ remoteCliUrl: broker.url });
      broker.setAckUnavailable(false);
      await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 4000 });
      expect(requests[2]).toMatchObject({
        model: "fixture-balanced",
        reasoning: { effort: "medium" },
      });
      expect(JSON.stringify(requests[2])).toContain("Current model profile balanced");
      expect(JSON.stringify(requests[2])).toContain("profile strong");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(requests).toHaveLength(3);
    } finally {
      await broker.close();
    }
  });

  it("SIGKILL between escalation commit and tool memo replays once without double promotion or a resumed model reset", async () => {
    await closeServer(runnerServer);
    await runner.close();
    modelActions = [
      {
        tool: "escalate_model",
        args: { profile: "balanced", reason: "More reasoning for the Google task" },
      },
    ];
    const body = {
      prompt: "Read a Google document",
      requestId: "crash-escalation",
      directory: triggerDirectory,
      interrupt: false,
      stream: false,
    };
    const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
    const script = `
      import { Harness, createRegistry, defineExtension } from ${JSON.stringify(moduleUrl("../node_modules/@earendil-works/pi-durable/dist/index.js"))};
      import { openNodeSqliteStorage } from ${JSON.stringify(moduleUrl("../node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js"))};
      import { createModels, createProvider } from ${JSON.stringify(moduleUrl("../node_modules/@earendil-works/pi-ai/dist/models.js"))};
      import { openAIResponsesApi } from ${JSON.stringify(moduleUrl("../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js"))};
      import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(moduleUrl("../node_modules/@earendil-works/chord/dist/context/index.js"))};
      import { PiModelRoutingRuntime, loadPiModelRoutingPool } from ${JSON.stringify(moduleUrl("./pi-model-routing-runtime.ts"))};
      import { selectPiTaskModel } from ${JSON.stringify(moduleUrl("./pi-model-routing-policy.ts"))};
      import { piConversationMetadataDoc } from ${JSON.stringify(moduleUrl("./pi-runner-state.ts"))};
      import { mintAnchor, mintTriggerId } from ${JSON.stringify(moduleUrl("../../common/src/index.ts"))};
      const config = ${JSON.stringify(config)};
      const pool = loadPiModelRoutingPool(config, () => (${JSON.stringify(workspace)})).value;
      const routing = new PiModelRoutingRuntime(pool, config.modelId);
      const models = createModels();
      models.setProvider(createProvider({ id: 'codex-lb', baseUrl: config.modelBaseUrl,
        auth: { apiKey: { name: 'fixture', resolve: async()=>({auth:{apiKey:config.modelApiKey}}) } }, api: openAIResponsesApi(),
        models: routing.modelIds().map(id=>({id,name:id,provider:'codex-lb',api:'openai-responses',baseUrl:config.modelBaseUrl,
          input:['text','image'],reasoning:true,contextWindow:65536,maxTokens:16384,
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})) }));
      const registry = createRegistry(), tool = routing.escalationTool();
      // Real native tool API and transaction; inject a process loss exactly before the memo/result commit.
      registry.install(defineExtension({name:'fault-window',tools:[{...tool,execute:(args,api,ctx)=>tool.execute(args,{
        ...api, memo: async (...rest)=>{
          if(rest.length === 3){ console.log('escalation-committed'); await new Promise(()=>{}); }
          return api.memo(...rest);
        }
      },ctx)}]}));
      const runtime = await Harness.open(await openNodeSqliteStorage(config.storagePath), {models,registry,settings:{toolExecution:'sequential'}},context);
      const request = ${JSON.stringify(body)};
      const selected = selectPiTaskModel({pool,routingTask:request.prompt}).value;
      const conversation = await runtime.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'codex-lb',modelId:selected.modelId},thinkingLevel:selected.thinkingLevel,cwd:request.directory},
        init:async(tx,id)=>Object.assign(await tx.doc(piConversationMetadataDoc,id),{
          anchorId:mintAnchor(),directory:request.directory,activeRequestId:request.requestId,
          receipts:[{requestId:request.requestId,fingerprint:'fixture-unused',triggerId:mintTriggerId(),startedAt:Date.now(),resumed:false,status:'accepted',request,modelSelection:selected}]
        })},context);
      await conversation.submit({type:'input',content:request.prompt,requestId:request.requestId},context);
    `;
    const loader = moduleUrl("../node_modules/tsx/dist/loader.mjs");
    const child = spawn(
      process.execPath,
      ["--import", loader, "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "",
          errors = "";
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("escalation-committed")) resolve();
        });
        child.once("exit", () =>
          reject(new Error(`Native escalation crash fixture exited: ${errors}`)),
        );
      });
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await exited).toBe("SIGKILL");
      modelActions = [{ text: "recovered after committed promotion" }];
      await openRunner({ configLoader: () => workspace });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[0]).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
      expect(requests[1]).toMatchObject({
        model: "fixture-balanced",
        reasoning: { effort: "medium" },
      });
      await vi.waitFor(() =>
        expect(JSON.stringify(requests[1])).toContain("Model profile promoted to balanced"),
      );
      await editPiNativeDocuments(async (tx, id) => {
        const metadata = await tx.doc(piConversationMetadataDoc, id);
        expect(metadata.receipts[0]?.modelSelection).toMatchObject({
          profile: "balanced",
          promotions: 1,
          history: [{ from: "fast", to: "balanced" }],
        });
        expect(metadata.receipts[0]?.escalationCalls).toHaveLength(1);
        expect((await tx.doc(AgentDoc, id)).thinkingLevel).toBe("medium");
      });
      await openRunner({ configLoader: () => workspace });
      expect(requests).toHaveLength(2);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("legacy admitted work resumes its native model/effort without reclassifying old text, then new human work reroutes", async () => {
    const body = {
      prompt: "hold-run create a Google document",
      thinkingLevel: "high",
      requestId: "legacy-native",
    };
    const accepted = await (await trigger(body)).json();
    await vi.waitFor(() => expect(hold).toBeDefined());
    expect(requests[0]).toMatchObject({ model: "fixture-model", reasoning: { effort: "high" } });
    await editPiNativeDocuments(async (tx, id) => {
      const metadata = await tx.doc(piConversationMetadataDoc, id);
      for (const receipt of metadata.receipts) {
        delete receipt.modelSelection;
        delete receipt.escalationCalls;
      }
    });
    modelActions = [{ text: "legacy recovered" }];
    await openRunner({ configLoader: () => workspace });
    await stream(body);
    expect(requests.at(-1)).toMatchObject({
      model: "fixture-model",
      reasoning: { effort: "high" },
    });
    await stream({
      prompt: "replacement Read a Google document",
      requestId: "new-native",
      sessionId: accepted.sessionId,
    });
    expect(requests.at(-1)).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
    const html = await (
      await fetch(`${runnerUrl}/runner/v/${accepted.anchorId}/${accepted.triggerId}`)
    ).text();
    expect(html).toContain("fixture-model · thinking high · legacy native choice");
    expect(html).not.toContain("profile fast");
  });

  it("invalid durable selection is preserved on startup failure, and native configuration drift fails before tools", async () => {
    await reopenRouting();
    const body = { prompt: "hold-run create a Google document", requestId: "invalid-evidence" };
    await trigger(body);
    await vi.waitFor(() => expect(hold).toBeDefined());
    await editPiNativeDocuments(async (tx, id) => {
      const metadata = await tx.doc(piConversationMetadataDoc, id);
      const selection = metadata.receipts[0]?.modelSelection;
      if (!selection) throw new Error("Missing routing fixture");
      selection.modelId = "invalid-saved-secret-looking-evidence";
    });
    expect(await createPiRunnerApp(config, { configLoader: () => workspace })).toEqual({
      ok: false,
      error: "pi_startup_failed",
    });
    expect(requests).toHaveLength(1);
    const executorCount = executorRequests.length;
    await editPiNativeDocuments(async (tx, id) => {
      const metadata = await tx.doc(piConversationMetadataDoc, id);
      const selection = metadata.receipts[0]?.modelSelection;
      expect(selection?.modelId).toBe("invalid-saved-secret-looking-evidence"); // No guessed overwrite.
      if (!selection) throw new Error("Missing routing fixture");
      selection.modelId = "fixture-fast";
      await configure(tx, id, { model: { provider: "codex-lb", modelId: "fixture-strong" } });
    });
    expect(await createPiRunnerApp(config, { configLoader: () => workspace })).toEqual({
      ok: false,
      error: "pi_startup_failed",
    });
    expect(requests).toHaveLength(1);
    expect(executorRequests).toHaveLength(executorCount);
    await editPiNativeDocuments(async (tx, id) => {
      await configure(tx, id, { model: { provider: "codex-lb", modelId: "fixture-fast" } });
    });
    modelActions = [{ text: "valid evidence recovered" }];
    await openRunner({ configLoader: () => workspace });
    await stream(body);
    expect(requests.at(-1)).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
  });

  it("fails startup safely on invalid declared config and unsupported frozen capabilities without execution", async () => {
    await reopenRouting();
    const saved = { prompt: "hold-run Read a file", requestId: "saved" };
    await trigger(saved);
    await vi.waitFor(() => expect(hold).toBeDefined());
    await closeServer(runnerServer);
    await runner.close();
    const failedConfig = await createPiRunnerApp(config, {
      configLoader: () => {
        throw new Error("secret config value DO_NOT_EXPOSE");
      },
    });
    expect(failedConfig).toEqual({ ok: false, error: "pi_startup_failed" });
    const incompatible = await createPiRunnerApp(
      { ...config, modelSupportsImages: false },
      { configLoader: () => workspace },
    );
    expect(
      await createPiRunnerApp(
        { ...config, modelContextWindow: 131072 },
        { configLoader: () => workspace },
      ),
    ).toEqual({ ok: false, error: "pi_startup_failed" });
    expect(incompatible).toEqual({ ok: false, error: "pi_startup_failed" });
    const removed = await createPiRunnerApp(config); // Only legacy model is registered now.
    expect(removed).toEqual({ ok: false, error: "pi_startup_failed" });
    expect(requests).toHaveLength(1);
    modelActions = [{ text: "pending task recovered with its original model" }];
    await openRunner({ configLoader: () => workspace }); // Invalid attempts did not overwrite saved evidence.
    await stream(saved);
    expect(requests.at(-1)).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
  });

  it("retains completed history and duplicate results after retiring models, while fresh tasks use the new pool", async () => {
    await reopenRouting();
    const original = { prompt: "Read a Google document", requestId: "retired-model-history" };
    await stream(original);
    const receipt = await (await trigger(original)).json();
    const replacement = {
      pi: {
        modelRouting: {
          profiles: {
            fast: { modelId: "replacement-fast" },
            balanced: { modelId: "replacement-balanced" },
            strong: { modelId: "replacement-strong" },
          },
        },
      },
    };
    await reopenRouting({ configLoader: () => replacement });
    const duplicate = await (await trigger(original)).json();
    expect(duplicate).toMatchObject({ duplicate: true, triggerId: receipt.triggerId });
    expect((await stream(original)).at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(requests).toHaveLength(1);
    const url = `${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`;
    expect(await (await fetch(url)).text()).toContain("fixture-fast · thinking low · profile fast");
    await stream({
      prompt: "Read another document",
      requestId: "new-pool-task",
      sessionId: receipt.sessionId,
    });
    expect(requests.at(-1)).toMatchObject({
      model: "replacement-fast",
      reasoning: { effort: "low" },
    });
    expect(await (await fetch(url)).text()).toContain("fixture-fast · thinking low · profile fast");
  });
});
