import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  Harness,
  LiveDoc,
  createRegistry,
  watchEvents,
  type Conversation,
  type EntryRecord,
  type Submission,
  type AgentEvent,
  type Cursor,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  appendAlias,
  appendCorrelationAliasForAnchor,
  appendSessionEvent,
  isAllowedDirectory,
  mintAnchor,
  mintTriggerId,
  readTriggerSlice,
  resolveAlias,
  resolveAnchorForCorrelationKey,
  handleProgressEvent,
  matchesInternalSecret,
  type ProgressEvent,
} from "@thor/common";
import { PiExecutionEnv } from "./pi-execution-env.js";
import { acquirePiStorageOwner } from "./pi-storage-owner.js";
import { installPiRunnerTools } from "./pi-runner-tools.js";
import {
  piTriggerRequestSchema,
  piConversationMetadataDoc,
  piConversationMetadataSchema,
  type PiAdmissionReceipt,
  type PiTriggerRequest,
} from "./pi-runner-state.js";
import { resolveSlackProgressTarget, type SlackProgressTransportTarget } from "./slack-progress.js";
import type { ProgressTransport } from "@thor/common";
import type { PiRunnerConfig } from "./pi-runner-config.js";
import { GoogleWorkspaceConnectionStatusClient } from "./google-workspace-connection-status.js";

const context = BACKGROUND_CONTEXT;
type ConversationMetadata = ReturnType<typeof piConversationMetadataSchema.parse>;
type ConversationOwner = { conversation: Conversation; metadata: ConversationMetadata };
type StreamFrame = ProgressEvent | { type: "text"; text: string };

function escapePiHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
function textFromEntries(entries: readonly EntryRecord[]): string {
  return entries
    .flatMap((entry) => entry.model ?? [])
    .filter(
      (message) =>
        message.role === "assistant" && !["error", "aborted"].includes(message.stopReason),
    )
    .flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.filter((block) => block.type === "text").map((block) => block.text),
    )
    .join("\n");
}
function fingerprintPiRequest(request: PiTriggerRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prompt: request.prompt,
        directory: request.directory,
        correlationKey: request.correlationKey,
        sessionId: request.sessionId,
        triggerSlackId: request.triggerSlackId,
        triggerGithubLogin: request.triggerGithubLogin,
        interrupt: request.interrupt,
      }),
    )
    .digest("hex");
}

/** Open a runner-owned SQLite Harness; expected startup failures are safe error codes, never provider payloads. */
export async function createPiRunnerApp(
  config: PiRunnerConfig,
  options: {
    legacyViewerApp?: express.Express;
    progressEventSink?: (event: ProgressEvent) => void;
    progressTransport?: ProgressTransport<SlackProgressTransportTarget>;
    /** Existing internal broker service; override only for embedded integration tests/custom topology. */
    remoteCliUrl?: string;
  } = {},
): Promise<
  | { ok: false; error: "pi_storage_owned_or_unavailable" | "pi_startup_failed" }
  | { ok: true; app: express.Express; close: () => Promise<void> }
> {
  const ownerLock = await acquirePiStorageOwner(config.storagePath);
  if (!ownerLock.ok) return ownerLock;
  let harness: Harness | undefined;
  try {
    const models = createModels();
    models.setProvider(
      createProvider({
        id: "codex-lb",
        baseUrl: config.modelBaseUrl,
        auth: {
          apiKey: {
            name: "Neo model key",
            resolve: async () => ({ auth: { apiKey: config.modelApiKey } }),
          },
        },
        api: openAIResponsesApi(),
        models: [
          {
            id: config.modelId,
            name: config.modelId,
            provider: "codex-lb",
            api: "openai-responses",
            baseUrl: config.modelBaseUrl,
            input: config.modelSupportsImages ? ["text", "image"] : ["text"],
            reasoning: true,
            thinkingLevelMap: {
              minimal: "minimal",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: null,
            },
            contextWindow: config.modelContextWindow,
            maxTokens: Math.min(32768, Math.floor(config.modelContextWindow / 4)),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
    );
    const registry = createRegistry();
    installPiRunnerTools(
      registry,
      config,
      new GoogleWorkspaceConnectionStatusClient({
        remoteCliUrl: options.remoteCliUrl ?? "http://remote-cli:3004",
        internalSecret: config.internalSecret,
      }),
    );
    const storage = await openNodeSqliteStorage(ownerLock.path);
    try {
      harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            retry: { enabled: false },
            stream: { maxRetries: 0 },
            toolExecution: "sequential",
          },
          env: ({ cwd }) =>
            new PiExecutionEnv({
              url: config.executorUrl,
              cwd: cwd ?? "/workspace",
              namespaceId: config.executorUrl,
            }),
        },
        context,
      );
    } catch {
      await storage.close(context);
      throw new Error("Pi startup failed");
    }
    const runtime = harness;
    const owners = new Map<string, ConversationOwner>();
    const requests = new Map<string, ConversationOwner>();
    const monitors = new Map<
      string,
      {
        completion: Promise<void>;
        listeners: Set<(frame: StreamFrame) => void>;
        terminal?: StreamFrame;
      }
    >();
    const slackTransport = options.progressTransport;
    let closing = false;
    let admissionLine = Promise.resolve();

    const serialAdmission = <T>(work: () => Promise<T>): Promise<T> => {
      const pending = admissionLine.then(work);
      admissionLine = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    const sessionId = (owner: ConversationOwner) => `pi-${owner.metadata.anchorId}`;
    const remember = (owner: ConversationOwner) => {
      owners.set(sessionId(owner), owner);
      for (const receipt of owner.metadata.receipts) requests.set(receipt.requestId, owner);
    };
    const reload = async (owner: ConversationOwner) => {
      owner.metadata = piConversationMetadataSchema.parse(
        await runtime.snapshot(piConversationMetadataDoc, owner.conversation.id, context),
      );
      remember(owner);
    };
    const reconcileLogs = (owner: ConversationOwner) => {
      const id = sessionId(owner);
      for (const aliasType of ["opencode.session", "pi.conversation"] as const) {
        if (resolveAlias({ aliasType, aliasValue: id }) !== owner.metadata.anchorId)
          appendAlias({ aliasType, aliasValue: id, anchorId: owner.metadata.anchorId });
      }
      const correlationKeys = new Set([
        owner.metadata.correlationKey,
        ...owner.metadata.receipts.map((receipt) => receipt.request.correlationKey),
      ]);
      for (const correlationKey of correlationKeys) {
        if (
          correlationKey &&
          resolveAnchorForCorrelationKey(correlationKey) !== owner.metadata.anchorId
        )
          appendCorrelationAliasForAnchor(owner.metadata.anchorId, correlationKey);
      }
      for (const receipt of owner.metadata.receipts) {
        let slice = readTriggerSlice(id, receipt.triggerId);
        if ("notFound" in slice) {
          appendSessionEvent(id, {
            type: "trigger_start",
            triggerId: receipt.triggerId,
            correlationKey: receipt.request.correlationKey,
            triggerSlackId: receipt.request.triggerSlackId,
            triggerGithubLogin: receipt.request.triggerGithubLogin,
          });
          slice = readTriggerSlice(id, receipt.triggerId);
        }
        if (
          receipt.status !== "accepted" &&
          !("notFound" in slice) &&
          !slice.records.some((record) => record.type === "trigger_end")
        )
          appendSessionEvent(id, {
            type: "trigger_end",
            triggerId: receipt.triggerId,
            status: receipt.status,
            durationMs: Date.now() - receipt.startedAt,
          });
      }
    };
    const progress = async (event: ProgressEvent, correlationKey: string | undefined) => {
      options.progressEventSink?.(event);
      const target = resolveSlackProgressTarget(correlationKey);
      if (target && slackTransport) {
        try {
          await handleProgressEvent(target, event, slackTransport);
        } catch {
          /* Progress delivery is best effort; never expose transport errors. */
        }
      }
    };
    const submissionFor = async (owner: ConversationOwner, requestId: string) => {
      const record = await owner.conversation.commit(
        (tx) => tx.submissionByRequest(owner.conversation.id, requestId),
        context,
      );
      return record ? runtime.submission(record.id, context) : undefined;
    };
    const entriesFor = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
    ): Promise<EntryRecord[]> => {
      const submitted = await submissionFor(owner, receipt.requestId);
      const record = await submitted?.status(context);
      const firstEntry = record?.entry;
      if (firstEntry === undefined) return [];
      const index = owner.metadata.receipts.findIndex(
        (item) => item.requestId === receipt.requestId,
      );
      const next = owner.metadata.receipts[index + 1];
      const nextRecord = next
        ? await (await submissionFor(owner, next.requestId))?.status(context)
        : undefined;
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await owner.conversation.entries({}, 200, cursor, context);
        entries.push(
          ...page.items.filter(
            (entry) =>
              entry.id >= firstEntry &&
              (nextRecord?.entry === undefined || entry.id < nextRecord.entry),
          ),
        );
        cursor = page.next;
      } while (cursor !== undefined);
      return entries.sort((a, b) => a.id - b.id);
    };
    const doneFrame = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
    ): Promise<ProgressEvent> => {
      const entries = await entriesFor(owner, receipt);
      return {
        type: "done",
        sessionId: sessionId(owner),
        correlationKey: receipt.request.correlationKey,
        resumed: receipt.resumed,
        status: receipt.status === "completed" ? "completed" : "error",
        ...(receipt.status === "completed"
          ? {}
          : { error: receipt.status === "aborted" ? "Run aborted" : "Pi run failed" }),
        response: textFromEntries(entries),
        toolCalls: entries
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "toolResult")
          .map((message) => ({
            tool: message.toolName,
            state: message.isError ? "error" : "completed",
          })),
        durationMs: Math.max(0, Date.now() - receipt.startedAt),
      };
    };
    const monitor = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
      submission: Submission,
    ) => {
      if (monitors.has(receipt.requestId)) return;
      const listeners = new Set<(frame: StreamFrame) => void>();
      const submitted = await submission.status(context);
      const firstEntry = submitted.entry;
      const stream = await watchEvents(runtime, owner.conversation.id, context);
      let emittedText = "";
      const emit = async (event: StreamFrame) => {
        if (event.type === "done" || event.type === "error") {
          const monitorState = monitors.get(receipt.requestId);
          if (monitorState) monitorState.terminal = event;
        }
        for (const listener of listeners) listener(event);
        // NDJSON includes both tool states; Slack counts one completed call, not start + end twice.
        if (event.type !== "text" && !(event.type === "tool" && event.status === "running"))
          await progress(event, receipt.request.correlationKey);
      };
      const project = async (event: AgentEvent) => {
        if (event.type === "snapshot") {
          for (const entry of event.entries) {
            if (firstEntry !== undefined && entry.id < firstEntry) continue;
            for (const message of entry.model ?? [])
              if (message.role === "toolResult")
                await emit({
                  type: "tool",
                  tool: message.toolName,
                  status: message.isError ? "error" : "completed",
                });
          }
          for (const tool of event.tools)
            if (tool.status !== "done")
              await emit({ type: "tool", tool: tool.name, status: "running" });
          const partial =
            event.generation?.message?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("") ?? "";
          emittedText = partial;
          if (partial) await emit({ type: "text", text: partial });
        } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          const failed =
            event.type === "tool_execution_end" &&
            event.entry?.model?.some((message) => message.role === "toolResult" && message.isError);
          await emit({
            type: "tool",
            tool: event.toolName,
            status:
              event.type === "tool_execution_start" ? "running" : failed ? "error" : "completed",
          });
          if (
            event.type === "tool_execution_start" &&
            ["read", "write", "edit"].includes(event.toolName) &&
            typeof event.args.path === "string" &&
            event.args.path.startsWith(`${config.memoryDir}/`)
          )
            await emit({
              type: "memory",
              action: event.toolName === "read" ? "read" : "write",
              path: event.args.path,
              source: "tool",
            });
        } else if (event.type === "message_update") {
          for (const change of event.changes)
            if (change.type === "text_delta") {
              emittedText += change.delta;
              await emit({ type: "text", text: change.delta });
            }
        } else if (event.type === "message_start") {
          emittedText = "";
        } else if (event.type === "message_end") {
          for (const message of event.entry.model ?? []) {
            if (message.role !== "assistant" || ["error", "aborted"].includes(message.stopReason))
              continue;
            // Pi input excludes cache reads; output already includes reasoning tokens.
            const tokens = message.usage.input + message.usage.cacheRead + message.usage.output;
            await emit({
              type: "context",
              providerID: message.provider,
              modelID: message.model,
              tokens,
              limit: config.modelContextWindow,
              usagePercent: Math.round((tokens / config.modelContextWindow) * 100),
            });
          }
          const completeText = textFromEntries([event.entry]);
          if (completeText.startsWith(emittedText) && completeText.length > emittedText.length)
            await emit({ type: "text", text: completeText.slice(emittedText.length) });
          emittedText = "";
        }
      };
      await progress(
        {
          type: "start",
          sessionId: sessionId(owner),
          correlationKey: receipt.request.correlationKey,
          resumed: receipt.resumed,
        },
        receipt.request.correlationKey,
      );
      await project(stream.snapshot);
      stream.start(async (events) => {
        for (const event of events) await project(event);
      });
      const completion = (async () => {
        try {
          const settled = await submission.wait(context);
          if (closing) return;
          const status =
            settled.status === "done"
              ? "completed"
              : settled.reason === "aborted"
                ? "aborted"
                : "error";
          await owner.conversation.commit(async (tx) => {
            const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
            const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
            if (stored) stored.status = status;
            if (metadata.activeRequestId === receipt.requestId) delete metadata.activeRequestId;
          }, context);
          await reload(owner);
          reconcileLogs(owner);
          await emit(await doneFrame(owner, { ...receipt, status }));
        } catch {
          if (!closing) await emit({ type: "error", error: "Pi run unavailable" });
        } finally {
          await stream.stop();
          monitors.delete(receipt.requestId);
        }
      })();
      monitors.set(receipt.requestId, { completion, listeners });
    };
    const startAccepted = async (owner: ConversationOwner, receipt: PiAdmissionReceipt) => {
      const submission = await owner.conversation.submit(
        {
          type: "input",
          content: receipt.request.prompt,
          requestId: receipt.requestId,
          whenBusy: "reject",
        },
        context,
      );
      await monitor(owner, receipt, submission);
    };

    // No scheduler is resumed until the persisted identity/log projection has been restored.
    let cursor: Cursor | undefined;
    do {
      const page = await runtime.commit((tx) => tx.scanConversations({}, 200, cursor), context);
      for (const record of page.items) {
        const conversation = await runtime.conversation(record.id, context);
        const persisted = await runtime.snapshot(piConversationMetadataDoc, record.id, context);
        if (!conversation || !persisted) continue;
        const owner = { conversation, metadata: piConversationMetadataSchema.parse(persisted) };
        remember(owner);
        reconcileLogs(owner);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    for (const owner of owners.values())
      for (const receipt of owner.metadata.receipts)
        if (receipt.status === "accepted") await startAccepted(owner, receipt);
    runtime.resume();

    const app = express();
    // Actor identity may enter only through the trusted gateway, never from agent shell tools.
    app.use("/trigger", (req, res, next) => {
      if (!matchesInternalSecret(config.internalSecret, req.get("x-thor-internal-secret"))) {
        res.status(401).json({ error: "unauthorized_trigger" });
        return;
      }
      next();
    });
    app.use(express.json());
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        if (error) res.status(400).json({ error: "invalid_trigger_json" });
      },
    );
    app.get("/health", (_req, res) =>
      res.json({ status: closing ? "closing" : "ok", runtime: "pi" }),
    );
    app.get("/healthz", (_req, res) =>
      res.json({ status: closing ? "closing" : "ok", runtime: "pi" }),
    );
    app.get("/global/health", (_req, res) =>
      res.json({ status: closing ? "closing" : "ok", runtime: "pi" }),
    );
    app.get("/", (_req, res) => res.redirect("/admin/sessions"));
    app.post("/trigger", async (req, res) => {
      const parsed = piTriggerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_trigger" });
        return;
      }
      const request = parsed.data;
      if (!isAllowedDirectory(request.directory)) {
        res.status(400).json({ error: "directory_not_allowed" });
        return;
      }
      try {
        const outcome = await serialAdmission(async () => {
          if (closing) return { kind: "error", status: 503, error: "runner_closing" } as const;
          const requestId = request.requestId ?? randomUUID();
          const fingerprint = fingerprintPiRequest(request);
          const duplicate = requests.get(requestId);
          if (duplicate) {
            await reload(duplicate);
            const receipt = duplicate.metadata.receipts.find(
              (item) => item.requestId === requestId,
            );
            if (!receipt || receipt.fingerprint !== fingerprint)
              return { kind: "error", status: 409, error: "request_id_payload_mismatch" } as const;
            if (receipt.status === "accepted" && !monitors.has(requestId))
              await startAccepted(duplicate, receipt);
            return { kind: "accepted", owner: duplicate, receipt, duplicate: true } as const;
          }
          let owner = request.sessionId ? owners.get(request.sessionId) : undefined;
          if (request.sessionId && !owner)
            return { kind: "error", status: 404, error: "pi_session_not_found" } as const;
          const correlationKey = request.correlationKey;
          if (!owner && correlationKey)
            owner = [...owners.values()].find(
              (item) =>
                item.metadata.correlationKey === correlationKey ||
                item.metadata.anchorId === resolveAnchorForCorrelationKey(correlationKey),
            );
          if (owner && owner.metadata.directory !== request.directory)
            return { kind: "error", status: 409, error: "session_directory_mismatch" } as const;
          const resumed = owner !== undefined;
          if (owner) {
            const live = await runtime.snapshot(LiveDoc, owner.conversation.id, context);
            if (live?.run || owner.metadata.activeRequestId) {
              if (!request.interrupt) return { kind: "busy", sessionId: sessionId(owner) } as const;
              await owner.conversation.abort(context);
              const active = owner.metadata.activeRequestId;
              if (active) {
                const pending = monitors.get(active);
                if (pending) await pending.completion;
                else {
                  const interruptedOwner = owner;
                  // An admission may have been persisted before submit/monitor failed. Interrupt withdraws that intent too.
                  await owner.conversation.commit(async (tx) => {
                    const metadata = await tx.doc(
                      piConversationMetadataDoc,
                      interruptedOwner.conversation.id,
                    );
                    const receipt = metadata.receipts.find((item) => item.requestId === active);
                    if (receipt) receipt.status = "aborted";
                    if (metadata.activeRequestId === active) delete metadata.activeRequestId;
                  }, context);
                }
              }
              await reload(owner);
              reconcileLogs(owner);
            }
          }
          const receipt: PiAdmissionReceipt = {
            requestId,
            fingerprint,
            triggerId: mintTriggerId(),
            startedAt: Date.now(),
            resumed,
            request,
            status: "accepted",
          };
          if (!owner) {
            const anchorId = request.correlationKey
              ? (resolveAnchorForCorrelationKey(request.correlationKey) ?? mintAnchor())
              : mintAnchor();
            const metadata: ConversationMetadata = {
              anchorId,
              directory: request.directory,
              ...(request.correlationKey ? { correlationKey: request.correlationKey } : {}),
              activeRequestId: requestId,
              receipts: [receipt],
            };
            const conversation = await runtime.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { provider: "codex-lb", modelId: config.modelId },
                  thinkingLevel: "medium",
                  cwd: request.directory,
                },
                init: async (tx, id) => {
                  Object.assign(await tx.doc(piConversationMetadataDoc, id), metadata);
                },
              },
              context,
            );
            owner = { conversation, metadata };
          } else {
            const existingOwner = owner;
            await owner.conversation.commit(async (tx) => {
              const metadata = await tx.doc(
                piConversationMetadataDoc,
                existingOwner.conversation.id,
              );
              metadata.receipts.push(receipt);
              metadata.activeRequestId = requestId;
            }, context);
            await reload(owner);
          }
          remember(owner);
          reconcileLogs(owner);
          await startAccepted(owner, receipt);
          return { kind: "accepted", owner, receipt, duplicate: false } as const;
        });
        if (outcome.kind === "error") {
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        if (outcome.kind === "busy") {
          res.json({ busy: true, accepted: false, sessionId: outcome.sessionId });
          return;
        }
        const { owner, receipt } = outcome;
        const response = {
          accepted: true,
          sessionId: sessionId(owner),
          anchorId: owner.metadata.anchorId,
          triggerId: receipt.triggerId,
          requestId: receipt.requestId,
          resumed: receipt.resumed,
          duplicate: outcome.duplicate,
        };
        if (!request.stream) {
          res.json(response);
          return;
        }
        res.type("application/x-ndjson");
        res.flushHeaders();
        const write = (frame: StreamFrame) => {
          if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(frame)}\n`);
          if (frame.type === "done" || frame.type === "error") res.end();
        };
        write({
          type: "start",
          sessionId: sessionId(owner),
          correlationKey: receipt.request.correlationKey,
          resumed: receipt.resumed,
        });
        const pending = monitors.get(receipt.requestId);
        if (receipt.status !== "accepted") {
          write(await doneFrame(owner, receipt));
        } else if (pending?.terminal) {
          write(pending.terminal);
        } else if (pending) {
          pending.listeners.add(write);
          res.once("close", () => pending.listeners.delete(write));
        } else {
          await reload(owner);
          const current = owner.metadata.receipts.find(
            (item) => item.requestId === receipt.requestId,
          );
          write(await doneFrame(owner, current ?? receipt));
        }
      } catch {
        if (!res.headersSent) res.status(503).json({ error: "pi_admission_unavailable" });
        else res.end();
      }
    });
    app.get("/runner/v/:anchor/:trigger", async (req, res, next) => {
      const owner = [...owners.values()].find(
        (item) => item.metadata.anchorId === req.params.anchor,
      );
      const receipt = owner?.metadata.receipts.find(
        (item) => item.triggerId === req.params.trigger,
      );
      if (!owner || !receipt) {
        next();
        return;
      }
      try {
        await reload(owner);
        const entries = await entriesFor(owner, receipt);
        const view = await owner.conversation.watch(context);
        const usage = JSON.stringify(view.value.docs["pi.usage"] ?? {});
        await view.stop();
        const live = await runtime.snapshot(LiveDoc, owner.conversation.id, context);
        const liveTools =
          owner.metadata.activeRequestId === receipt.requestId
            ? (live?.tools ?? [])
                .map(
                  (tool) =>
                    `<h3>${escapePiHtml(tool.name)} · ${escapePiHtml(tool.status)}</h3><pre>${escapePiHtml(tool.output ?? "")}</pre>`,
                )
                .join("")
            : "";
        const body = entries
          .map((entry) =>
            (entry.model ?? [])
              .filter((message) => message.role !== "system")
              .map((message) => {
                if (
                  message.role === "assistant" &&
                  ["error", "aborted"].includes(message.stopReason)
                )
                  return "<pre>Pi model request failed</pre>";
                const heading =
                  message.role === "toolResult"
                    ? `${message.toolName} · ${message.isError ? "error" : "completed"}`
                    : message.role === "assistant"
                      ? `${message.provider}/${message.model}`
                      : message.role;
                return `<h3>${escapePiHtml(heading)}</h3><pre>${escapePiHtml(typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `${block.name} ${JSON.stringify(block.arguments)}` : block.type === "image" ? `[Image attached: ${block.mimeType}]` : "")).join("\n"))}</pre>`;
              })
              .join(""),
          )
          .join("");
        const current = owner.metadata.receipts.find(
          (item) => item.triggerId === receipt.triggerId,
        );
        res
          .type("html")
          .send(
            `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="/favicon-v4.svg"><link rel="manifest" href="/site.webmanifest"><title>Neo Pi trigger</title></head><body><h1>Neo Pi trigger</h1><p>${escapePiHtml(current?.status ?? receipt.status)} · ${escapePiHtml(sessionId(owner))} · ${escapePiHtml(config.modelId)}</p>${body}${liveTools}<h3>Conversation usage</h3><pre>${escapePiHtml(usage)}</pre></body></html>`,
          );
      } catch {
        res.status(503).send("Pi history unavailable");
      }
    });
    // Legacy history only. Mutating routes and provider/session calls must never reach OpenCode in Pi mode.
    if (options.legacyViewerApp)
      app.use((req, res, next) => {
        if (req.method === "GET" && req.path.startsWith("/runner/v/"))
          options.legacyViewerApp?.(req, res, next);
        else next();
      });
    return {
      ok: true,
      app,
      close: async () => {
        closing = true;
        await admissionLine;
        await runtime.close(context); // Leaves work pending, unlike abort().
        await Promise.allSettled([...monitors.values()].map((item) => item.completion));
        await ownerLock.release();
      },
    };
  } catch {
    await harness?.close(context).catch(() => undefined);
    await ownerLock.release();
    return { ok: false, error: "pi_startup_failed" };
  }
}
