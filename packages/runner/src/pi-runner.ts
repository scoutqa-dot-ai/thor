import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  Harness,
  LiveDoc,
  AgentDoc,
  createRegistry,
  watchEvents,
  type Conversation,
  type EntryRecord,
  type Submission,
  type AgentEvent,
  type Cursor,
  type SubmissionRecord,
  type EntryId,
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
  ProgressModelSchema,
  SlackMessageTsSchema,
  matchesInternalSecret,
  type ProgressEvent,
  type ProgressModel,
  type ConfigLoader,
} from "@thor/common";
import { PiExecutionEnv } from "./pi-execution-env.js";
import { loadPiModelRoutingPool, PiModelRoutingRuntime } from "./pi-model-routing-runtime.js";
import { selectPiTaskModel } from "./pi-model-routing-policy.js";
import { acquirePiStorageOwner } from "./pi-storage-owner.js";
import { installPiRunnerTools } from "./pi-runner-tools.js";
import {
  piTriggerRequestSchema,
  piConversationMetadataDoc,
  piConversationMetadataSchema,
  type PiAdmissionReceipt,
  type PiTriggerRequest,
} from "./pi-runner-state.js";
import {
  resolveSlackProgressTarget,
  type SlackProgressTransport,
  type SlackAnswerReceipt,
} from "./slack-progress.js";
import { PiSlackPresentation } from "./pi-slack-presentation.js";
import { prepareSlackFinalAnswer } from "./slack-final-answer.js";
import type { PiRunnerConfig } from "./pi-runner-config.js";
import { GoogleWorkspaceConnectionStatusClient } from "./google-workspace-connection-status.js";
import {
  startGoogleAuthContinuationCoordinator,
  GoogleAuthContinuationClient,
} from "./google-auth-continuation-poller.js";

const context = BACKGROUND_CONTEXT;
type ConversationMetadata = ReturnType<typeof piConversationMetadataSchema.parse>;
type ConversationOwner = {
  conversation: Conversation;
  metadata: ConversationMetadata;
  presentation?: PiSlackPresentation;
};
type StreamFrame =
  | ProgressEvent
  | { type: "text"; text: string; requestId?: string; sessionId?: string };

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
        messageTs: request.messageTs,
        slackReplyAdmission: request.slackReplyAdmission,
        triggerGithubLogin: request.triggerGithubLogin,
        interrupt: request.interrupt,
        modelProfile: request.modelProfile,
        modelId: request.modelId,
        thinkingLevel: request.thinkingLevel,
        routingTask: request.routingTask,
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
    progressTransport?: SlackProgressTransport;
    /** Existing internal broker service; override only for embedded integration tests/custom topology. */
    remoteCliUrl?: string;
    /** Read operator workspace routing once at startup through the production config interface. */
    configLoader?: ConfigLoader;
  } = {},
): Promise<
  | { ok: false; error: "pi_storage_owned_or_unavailable" | "pi_startup_failed" }
  | { ok: true; app: express.Express; close: () => Promise<void> }
> {
  const ownerLock = await acquirePiStorageOwner(config.storagePath);
  if (!ownerLock.ok) return ownerLock;
  let harness: Harness | undefined;
  const owners = new Map<string, ConversationOwner>();
  const monitors = new Map<
    string,
    {
      completion: Promise<void>;
      listeners: Set<(frame: StreamFrame) => void>;
      terminal?: StreamFrame;
    }
  >();
  let closing = false;
  try {
    const models = createModels();
    const pool = loadPiModelRoutingPool(config, options.configLoader);
    if (!pool.ok) throw new Error("Pi model routing configuration invalid");
    const routing = new PiModelRoutingRuntime(pool.value, config.modelId);
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
        models: routing.modelIds().map((modelId) => ({
          id: modelId,
          name: modelId,
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
        })),
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
      routing,
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
    const continuationClient = new GoogleAuthContinuationClient(
      options.remoteCliUrl ?? "http://remote-cli:3004",
      config.internalSecret,
    );
    const requests = new Map<string, ConversationOwner>();
    const slackTransport = options.progressTransport;
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
      const previousOwner = owners.get(sessionId(owner));
      if (previousOwner && previousOwner.conversation.id !== owner.conversation.id)
        throw new Error("Pi public session binding conflict");
      owners.set(sessionId(owner), owner);
      for (const receipt of owner.metadata.receipts) {
        const previous = requests.get(receipt.requestId);
        if (previous && previous.conversation.id !== owner.conversation.id)
          throw new Error("Pi runner-wide request binding conflict");
        requests.set(receipt.requestId, owner);
      }
    };
    const reload = async (owner: ConversationOwner) => {
      owner.metadata = piConversationMetadataSchema.parse(
        await runtime.snapshot(piConversationMetadataDoc, owner.conversation.id, context),
      );
      remember(owner);
    };
    const nativeRecord = async (owner: ConversationOwner, requestId: string) => {
      const record = await owner.conversation.commit(
        (tx) => tx.submissionByRequest(owner.conversation.id, requestId),
        context,
      );
      if (record && record.type !== "input") throw new Error("Pi native request type mismatch");
      return record;
    };
    const executionStatus = async (owner: ConversationOwner, receipt: PiAdmissionReceipt) => {
      const record = await nativeRecord(owner, receipt.requestId);
      if (record?.status === "done") return "completed" as const;
      if (record?.status === "unanswered")
        return record.reason === "aborted" ? ("aborted" as const) : ("error" as const);
      // Withdrawal is only pre-submit evidence; live native input still requires validated requester authority.
      if (record) return "accepted" as const;
      if (receipt.admission.state === "withdrawn") return "aborted" as const;
      if (!record && receipt.admission.state === "submitted")
        throw new Error("Pi submitted binding missing native record");
      return "accepted" as const;
    };
    const reconcileLogs = async (owner: ConversationOwner) => {
      const id = sessionId(owner);
      for (const aliasType of ["opencode.session", "pi.conversation"] as const) {
        if (resolveAlias({ aliasType, aliasValue: id }) !== owner.metadata.anchorId)
          appendAlias({ aliasType, aliasValue: id, anchorId: owner.metadata.anchorId });
      }
      const correlationKeys = new Set([
        owner.metadata.correlationKey,
        ...owner.metadata.receipts.flatMap((receipt) => [
          receipt.request.correlationKey,
          ...(receipt.delivery.owner === "host"
            ? [
                `slack:thread:${receipt.delivery.target.channel}/${receipt.delivery.target.threadTs}`,
              ]
            : []),
        ]),
      ]);
      for (const correlationKey of correlationKeys) {
        if (
          correlationKey &&
          resolveAnchorForCorrelationKey(correlationKey) !== owner.metadata.anchorId
        )
          appendCorrelationAliasForAnchor(owner.metadata.anchorId, correlationKey);
      }
      for (const receipt of owner.metadata.receipts) {
        const status = await executionStatus(owner, receipt);
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
          status !== "accepted" &&
          (receipt.observation !== undefined || receipt.admission.state === "withdrawn") &&
          !("notFound" in slice) &&
          !slice.records.some((record) => record.type === "trigger_end")
        )
          appendSessionEvent(id, {
            type: "trigger_end",
            triggerId: receipt.triggerId,
            status,
            durationMs: Math.max(
              0,
              (receipt.observation?.settledAt ??
                (receipt.admission.state === "withdrawn"
                  ? receipt.admission.at
                  : receipt.startedAt)) - receipt.startedAt,
            ),
          });
      }
    };
    const presentationFor = async (owner: ConversationOwner, receipt: PiAdmissionReceipt) => {
      await owner.presentation?.stop();
      // Draining the previous owner may have deleted its saved footer. Do not reattach the
      // replacement to a stale timestamp from before that cleanup commit.
      await reload(owner);
      receipt =
        owner.metadata.receipts.find((item) => item.requestId === receipt.requestId) ?? receipt;
      const target = resolveSlackProgressTarget(
        receipt.delivery.owner === "host"
          ? `slack:thread:${receipt.delivery.target.channel}/${receipt.delivery.target.threadTs}`
          : receipt.request.correlationKey,
        {
          messageTs: receipt.request.messageTs,
          runnerBaseUrl: config.runnerBaseUrl,
        },
      );
      if (
        !target ||
        !slackTransport ||
        (receipt.delivery.owner === "host" && receipt.delivery.target.teamId !== config.slackTeamId)
      )
        return undefined;
      const presentation = new PiSlackPresentation(
        target,
        slackTransport,
        receipt.startedAt,
        async (ts) => {
          await owner.conversation.commit(async (tx) => {
            const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
            const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
            if (stored) {
              if (ts) stored.slackFooterTs = ts;
              else delete stored.slackFooterTs;
            }
          }, context);
        },
        receipt.slackFooterTs,
      );
      owner.presentation = presentation;
      const model = ProgressModelSchema.safeParse({
        type: "model",
        modelId: receipt.modelSelection?.modelId,
        thinkingLevel: receipt.modelSelection?.thinkingLevel,
      });
      if (model.success) await presentation.event(model.data);
      return presentation;
    };
    const publishFinalAnswer = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
      model?: ProgressModel,
    ) => {
      await reload(owner);
      const stored = owner.metadata.receipts.find((item) => item.requestId === receipt.requestId);
      if (
        !stored ||
        stored.delivery.owner !== "host" ||
        stored.publication ||
        stored.authorization !== "clear" ||
        owner.metadata.receipts.at(-1)?.requestId !== receipt.requestId ||
        (owner.metadata.activeRequestId !== undefined &&
          owner.metadata.activeRequestId !== receipt.requestId) ||
        closing
      )
        return false;
      const native = await nativeRecord(owner, receipt.requestId);
      if (native?.type !== "input" || native.status !== "done") return false;
      const entries = await owner.conversation.entries(
        { minEntryId: native.answer, maxEntryId: native.answer },
        1,
        undefined,
        context,
      );
      const answer = textFromEntries(entries.items.filter((entry) => entry.id === native.answer));
      const prepared = prepareSlackFinalAnswer(answer, model);
      if (prepared.state === "empty") return false;
      const target = stored.delivery.target;
      const publication: NonNullable<PiAdmissionReceipt["publication"]> = {
        answerEntry: native.answer,
        target,
        disposition: { state: prepared.state === "rejected" ? "rejected" : "pending" },
        chunks: prepared.state === "ready" ? prepared.chunks.map(() => ({ state: "pending" })) : [],
      };
      const save = async () => {
        await owner.conversation.commit(async (tx) => {
          const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
          const binding = metadata.receipts.find((item) => item.requestId === receipt.requestId);
          if (!binding) throw new Error("Pi publication binding missing");
          binding.publication = publication;
        }, context);
      };
      await save(); // The point of no automatic retry: intent commits before any Slack send.
      if (prepared.state !== "ready") return true;
      for (const [index, chunk] of prepared.chunks.entries()) {
        let result: SlackAnswerReceipt = { state: "rejected" };
        if (closing) result = { state: "uncertain" };
        else if (slackTransport && target.teamId === config.slackTeamId) {
          try {
            if (slackTransport.postAnswer)
              result = await slackTransport.postAnswer(target, chunk.text, chunk.blocks);
            else {
              const sent = await slackTransport.post(target, chunk.text, chunk.blocks);
              const timestamp = SlackMessageTsSchema.safeParse(sent.ts);
              result = timestamp.success
                ? { state: "confirmed", ts: timestamp.data }
                : { state: "uncertain" };
            }
          } catch {
            result = { state: "uncertain" };
          }
        }
        publication.chunks[index] = result;
        publication.disposition =
          result.state === "confirmed"
            ? index === prepared.chunks.length - 1
              ? result
              : { state: "pending" }
            : result.state === "rejected" && index === 0
              ? result
              : { state: "uncertain" };
        await save(); // Late receipts update only the original request/answer/destination binding.
        if (result.state !== "confirmed") break;
      }
      await reload(owner);
      return true;
    };
    const submissionFor = async (owner: ConversationOwner, requestId: string) => {
      const record = await nativeRecord(owner, requestId);
      return record ? runtime.submission(record.id, context) : undefined;
    };
    const entriesFor = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
      snapshotEnd?: EntryId,
    ): Promise<EntryRecord[]> => {
      const record = await nativeRecord(owner, receipt.requestId);
      const firstEntry = record?.entry;
      if (firstEntry === undefined) return [];
      const index = owner.metadata.receipts.findIndex(
        (item) => item.requestId === receipt.requestId,
      );
      let nextRecord: SubmissionRecord | undefined;
      if (record?.status !== "done") {
        for (const next of owner.metadata.receipts.slice(index + 1)) {
          nextRecord = await nativeRecord(owner, next.requestId);
          if (nextRecord?.entry !== undefined) break;
        }
      }
      const historyEnd =
        record?.type === "input" && record.status === "done"
          ? record.answer
          : (receipt.observation?.historyEnd ?? nextRecord?.entry);
      const upper =
        snapshotEnd === undefined
          ? historyEnd
          : historyEnd === undefined
            ? snapshotEnd
            : Math.min(historyEnd, snapshotEnd);
      // SAFETY: historyEnd is a positive native entry ID captured at settlement and parsed on rehydration.
      const maxEntryId = upper as EntryId | undefined;
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await owner.conversation.entries(
          { minEntryId: firstEntry, maxEntryId },
          200,
          cursor,
          context,
        );
        entries.push(
          ...page.items.filter(
            (entry) =>
              entry.id >= firstEntry &&
              (upper === undefined || entry.id <= upper) &&
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
      await reload(owner);
      receipt =
        owner.metadata.receipts.find((item) => item.requestId === receipt.requestId) ?? receipt;
      const entries = await entriesFor(owner, receipt);
      const status = await executionStatus(owner, receipt);
      const authorization =
        status === "completed"
          ? (receipt.authorization ?? (receipt.request.triggerSlackId ? "unavailable" : "clear"))
          : "clear";
      return {
        type: "done",
        requestId: receipt.requestId,
        sessionId: sessionId(owner),
        correlationKey: receipt.request.correlationKey,
        resumed: receipt.resumed,
        status: status === "completed" && authorization === "clear" ? "completed" : "error",
        ...(authorization === "waiting"
          ? { authWait: "google" as const }
          : authorization === "unavailable" || authorization === "waiting_unconfirmed"
            ? { authWait: "unconfirmed" as const }
            : {}),
        ...(status === "completed"
          ? {}
          : { error: status === "aborted" ? "Run aborted" : "Pi run failed" }),
        response: textFromEntries(entries),
        toolCalls: entries
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "toolResult")
          .map((message) => ({
            tool: message.toolName,
            state: message.isError ? "error" : "completed",
          })),
        durationMs: Math.max(
          0,
          (receipt.observation?.settledAt ??
            (receipt.admission.state === "withdrawn" ? receipt.admission.at : receipt.startedAt)) -
            receipt.startedAt,
        ),
      };
    };
    const observeSettlement = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
      observedAt = Date.now(),
    ) => {
      const status = await executionStatus(owner, receipt);
      if (status === "accepted")
        throw new Error("Pi settlement observation before native settlement");
      const end =
        status === "completed" ? undefined : (await entriesFor(owner, receipt)).at(-1)?.id;
      const slice = readTriggerSlice(sessionId(owner), receipt.triggerId);
      const priorEnd =
        "notFound" in slice
          ? undefined
          : slice.records.find((event) => event.type === "trigger_end");
      // Old shared completion timestamps can fix migration duration; native records still decide status.
      const priorTime = priorEnd ? Date.parse(priorEnd.ts) : NaN;
      await owner.conversation.commit(async (tx) => {
        const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
        const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
        if (stored) {
          stored.admission = { state: "submitted" };
          stored.observation ??= {
            settledAt: Number.isFinite(priorTime) ? priorTime : observedAt,
            ...(end === undefined ? {} : { historyEnd: end }),
          };
        }
      }, context);
      const brokerOutcome =
        status === "completed"
          ? await continuationClient.observeGoogleAuthWait(
              sessionId(owner),
              owner.metadata.anchorId,
              receipt,
            )
          : "clear";
      // Once a hold was confirmed, its disappearance is not proof the blocked operation completed.
      const hadConfirmedWait =
        receipt.authorization === "waiting" || receipt.authorization === "waiting_unconfirmed";
      const authorization =
        hadConfirmedWait && brokerOutcome !== "waiting" ? "waiting_unconfirmed" : brokerOutcome;
      await owner.conversation.commit(async (tx) => {
        const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
        const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
        if (stored) stored.authorization = authorization;
      }, context);
      await reload(owner);
      await reconcileLogs(owner);
    };
    // Only the latest idle request may repair the thread. A new host binding without publication
    // intent retains its first-send opportunity; existing/uncertain records never authorize repost.
    const reconcileSettledPresentation = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
    ) => {
      await reload(owner);
      if (
        owner.metadata.activeRequestId ||
        owner.metadata.receipts.at(-1)?.requestId !== receipt.requestId
      )
        return;
      const current = owner.metadata.receipts.at(-1);
      if (!current) return;
      const presentation = await presentationFor(owner, current);
      if (
        current.delivery.owner === "host" &&
        current.authorization === "clear" &&
        !current.publication &&
        (await executionStatus(owner, current)) === "completed"
      ) {
        const event = await doneFrame(owner, current);
        if (event.type !== "done") return;
        const model = ProgressModelSchema.safeParse({
          type: "model",
          modelId: current.modelSelection?.modelId,
          thinkingLevel: current.modelSelection?.thinkingLevel,
        });
        await presentation?.settle(event);
        const publicationCreated = await publishFinalAnswer(
          owner,
          current,
          model.success ? model.data : undefined,
        );
        // Completion is not delivery proof: an empty answer still completes when unavailable
        // authorization becomes clear. Persisted clear evidence prevents repeating its check.
        if (
          publicationCreated ||
          receipt.authorization === "unavailable" ||
          receipt.authorization === undefined
        ) {
          await presentation?.finish(event);
          return;
        }
      }
      await presentation?.reconcile(current.authorization);
    };

    const monitor = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
      submission: Submission,
    ) => {
      if (monitors.has(receipt.requestId)) return;
      const listeners = new Set<(frame: StreamFrame) => void>();
      let submitted = await submission.status(context);
      let firstEntry = submitted.entry;
      // Capture the legacy native choice before acquiring the owned observer.
      const legacyAgent = receipt.modelSelection
        ? undefined
        : await runtime.snapshot(AgentDoc, owner.conversation.id, context);
      const stream = await watchEvents(runtime, owner.conversation.id, context);
      let emittedText = "";
      let presentation: PiSlackPresentation | undefined;
      const emit = async (frame: StreamFrame) => {
        const event: StreamFrame = {
          ...frame,
          sessionId: sessionId(owner),
          requestId: receipt.requestId,
        };
        if (event.type === "done" || event.type === "error") {
          const monitorState = monitors.get(receipt.requestId);
          if (monitorState) monitorState.terminal = event;
        }
        for (const listener of listeners) listener(event);
        if (event.type !== "text") {
          options.progressEventSink?.(event);
          if (event.type === "done" || event.type === "error") {
            await presentation?.settle(event);
            if (event.type === "done" && event.status === "completed" && !event.authWait)
              await publishFinalAnswer(owner, receipt, displayedModel);
            await presentation?.finish(event);
          } else await presentation?.event(event);
        }
      };
      let displayedModel: ProgressModel | undefined;
      const refreshTaskModel = async () => {
        // Legacy tasks cannot escalate; their captured native choice cannot follow a replacement.
        await reload(owner);
        const selected = owner.metadata.receipts.find(
          (item) => item.requestId === receipt.requestId,
        )?.modelSelection;
        const model = ProgressModelSchema.safeParse({
          type: "model",
          modelId: selected?.modelId ?? legacyAgent?.model?.modelId,
          thinkingLevel: selected?.thinkingLevel ?? legacyAgent?.thinkingLevel ?? "off",
        });
        if (
          !model.success ||
          (displayedModel?.modelId === model.data.modelId &&
            displayedModel.thinkingLevel === model.data.thinkingLevel)
        )
          return;
        displayedModel = model.data;
        await emit(model.data);
      };

      let activity: "thinking" | "working" | "responding" = "thinking";
      const runningTools = new Set<string>();
      const setActivity = async (next: typeof activity) => {
        if (next === activity) return;
        activity = next;
        await emit({ type: "activity", activity });
      };
      const project = async (event: AgentEvent) => {
        if (event.type === "snapshot") {
          submitted = await submission.status(context);
          firstEntry = submitted.entry;
          if (event.run && !event.run.inputs.includes(submission.id)) return;
          runningTools.clear();
          // Native snapshots are active context, which can omit pre-compaction calls. Rebuild
          // this request's accounting from immutable history, bounded to its last visible entry.
          const snapshotEnd = event.entries.reduce<EntryId | undefined>(
            (last, entry) => (last === undefined || entry.id > last ? entry.id : last),
            undefined,
          );
          const toolEntries =
            snapshotEnd === undefined ? [] : await entriesFor(owner, receipt, snapshotEnd);
          await emit({
            type: "tools_snapshot",
            tools: toolEntries
              .filter(
                (entry) =>
                  firstEntry !== undefined &&
                  entry.id >= firstEntry &&
                  (submitted.status !== "done" ||
                    submitted.type !== "input" ||
                    entry.id <= submitted.answer),
              )
              .flatMap((entry) => entry.model ?? [])
              .filter((message) => message.role === "toolResult")
              .map((message) => ({ tool: message.toolName, toolCallId: message.toolCallId })),
          });
          for (const tool of event.tools)
            if (tool.status === "running") {
              runningTools.add(tool.callId);
              await emit({
                type: "tool",
                tool: tool.name,
                toolCallId: tool.callId,
                status: "running",
              });
            }
          await setActivity(runningTools.size ? "working" : "thinking");
          const partial =
            event.generation?.message?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("") ?? "";
          emittedText = partial;
          if (partial) {
            await setActivity("responding");
            await emit({ type: "text", text: partial });
          }
        } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          const failed =
            event.type === "tool_execution_end" &&
            event.entry?.model?.some((message) => message.role === "toolResult" && message.isError);
          if (event.type === "tool_execution_start") runningTools.add(event.toolCallId);
          else runningTools.delete(event.toolCallId);
          if (event.type === "tool_execution_start") await setActivity("working");
          await emit({
            type: "tool",
            tool: event.toolName,
            toolCallId: event.toolCallId,
            status:
              event.type === "tool_execution_start" ? "running" : failed ? "error" : "completed",
          });
          // The next phase footer includes this just-completed call, not the previous count.
          if (event.type === "tool_execution_end" && event.toolName === "escalate_model")
            await refreshTaskModel();
          if (event.type === "tool_execution_end")
            await setActivity(runningTools.size ? "working" : "thinking");
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
              await setActivity("responding");
              emittedText += change.delta;
              await emit({ type: "text", text: change.delta });
            }
        } else if (event.type === "message_start") {
          if (event.message.role === "assistant") {
            await refreshTaskModel();
            await setActivity("thinking");
          }
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
          if (completeText.startsWith(emittedText) && completeText.length > emittedText.length) {
            await setActivity("responding");
            await emit({ type: "text", text: completeText.slice(emittedText.length) });
          }
          emittedText = "";
        }
      };
      // Released 1.0.0 stop() detaches, but can resolve while its async listener is still running.
      // This is the owned callback drain, not another observer or execution lifecycle.
      let projectionLine = Promise.resolve();
      // Register ownership before any presentation callback can await or fail.
      const completion = Promise.resolve().then(async () => {
        let settled = false;
        try {
          if (closing) return;
          presentation = await presentationFor(owner, receipt);
          if (submitted.status === "done" || submitted.status === "unanswered")
            await presentation?.reconcile(receipt.authorization);
          else
            await presentation?.start(async () => {
              const current = await submission.status(context);
              return current.status !== "done" && current.status !== "unanswered";
            });
          await emit({
            type: "start",
            requestId: receipt.requestId,
            sessionId: sessionId(owner),
            correlationKey: receipt.request.correlationKey,
            resumed: receipt.resumed,
          });
          await refreshTaskModel();
          await project(stream.snapshot);
          stream.start(async (events) => {
            projectionLine = projectionLine.then(async () => {
              for (const event of events) await project(event);
            });
            await projectionLine;
          });
          await reconcileLogs(owner); // wait can schedule; current actor must already be restored.
          await submission.wait(context);
          settled = true;
          const observedAt = Date.now();
          await stream.stop();
          await projectionLine;
          if (closing) return;
          await presentation?.nativeSettled();
          await observeSettlement(owner, receipt, observedAt);
          const settledReceipt = owner.metadata.receipts.find(
            (item) => item.requestId === receipt.requestId,
          );
          await emit(await doneFrame(owner, settledReceipt ?? receipt));
        } catch {
          if (!closing) await emit({ type: "error", error: "Pi run unavailable" });
        } finally {
          await stream.stop();
          await projectionLine.catch(() => undefined);
          if (!closing && settled) {
            await owner.conversation.commit(async (tx) => {
              const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
              if (metadata.activeRequestId === receipt.requestId) delete metadata.activeRequestId;
            }, context);
            await reload(owner);
          }
          if (closing) await presentation?.stop();
          monitors.delete(receipt.requestId);
        }
      });
      monitors.set(receipt.requestId, { completion, listeners });
    };
    const startAccepted = async (
      owner: ConversationOwner,
      receipt: PiAdmissionReceipt,
    ): Promise<"started" | "deferred" | "retired"> => {
      await reload(owner);
      const current = owner.metadata.receipts.find((item) => item.requestId === receipt.requestId);
      if (!current) throw new Error("Pi admission binding missing");
      receipt = current;
      await reconcileLogs(owner);
      const existing = await submissionFor(owner, receipt.requestId);
      const record = await existing?.status(context);
      if (existing && (record?.status === "done" || record?.status === "unanswered")) {
        if (owner.metadata.activeRequestId === receipt.requestId)
          await monitor(owner, receipt, existing);
        else if (!receipt.observation || receipt.authorization !== "clear") {
          await observeSettlement(owner, receipt);
          await reconcileSettledPresentation(owner, receipt);
        }
        return "started";
      }
      if (receipt.admission.state === "withdrawn") return "retired";
      // Validate frozen support and exact native admission choice before ack, scheduling or tool execution.
      const agent = await runtime.snapshot(AgentDoc, owner.conversation.id, context);
      if (!routing.nativeMatches(receipt, agent))
        throw new Error("Pi saved native model unavailable");
      // A native submission proves the preceding bound ACK succeeded. Its recovery is not a new outbox admission.
      if (receipt.googleAuthSource && !existing) {
        if (
          receipt.googleAuthSource.expiresAtMs <= Date.now() ||
          owner.metadata.receipts.at(-1)?.requestId !== receipt.requestId
        ) {
          await owner.conversation.commit(async (tx) => {
            const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
            const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
            if (stored) stored.admission = { state: "withdrawn", at: Date.now() };
            if (metadata.activeRequestId === receipt.requestId) delete metadata.activeRequestId;
          }, context);
          await reload(owner);
          await reconcileLogs(owner);
          return "retired";
        }
        if (!(await continuationClient.acknowledge(receipt.googleAuthSource.id, receipt.triggerId)))
          return "deferred";
      }
      if (closing) return "deferred"; // A durable admission remains pending; shutdown never starts another model turn.
      await reconcileLogs(owner);
      if (!existing && receipt.admission.state !== "intent")
        throw new Error("Pi native admission input missing");
      const submission =
        existing ??
        (await owner.conversation.submit(
          {
            type: "input",
            content: receipt.admission.state === "intent" ? receipt.admission.prompt : "",
            requestId: receipt.requestId,
            whenBusy: "reject",
          },
          context,
        ));
      await owner.conversation.commit(async (tx) => {
        const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
        const stored = metadata.receipts.find((item) => item.requestId === receipt.requestId);
        if (stored) stored.admission = { state: "submitted" };
      }, context);
      await reload(owner);
      await monitor(owner, receipt, submission);
      return "started";
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
        // Only executable admissions require current resources. Completed history is
        // immutable evidence, not a requirement to keep every retired model configured.
        for (const receipt of owner.metadata.receipts) {
          if ((await executionStatus(owner, receipt)) !== "accepted") continue;
          if (
            owner.metadata.activeRequestId !== receipt.requestId ||
            owner.metadata.receipts.at(-1)?.requestId !== receipt.requestId
          )
            throw new Error("Pi active requester binding invalid");
          if (receipt.modelSelection && !routing.supported(receipt.modelSelection).ok)
            throw new Error("Pi saved model pool unavailable");
        }
        for (const receipt of owner.metadata.receipts) {
          if (!receipt.publication) continue;
          const native = await nativeRecord(owner, receipt.requestId);
          if (
            native?.type !== "input" ||
            native.status !== "done" ||
            native.answer !== receipt.publication.answerEntry
          )
            throw new Error("Pi publication answer binding invalid");
        }
        const active = owner.metadata.receipts.find(
          (receipt) => receipt.requestId === owner.metadata.activeRequestId,
        );
        if (
          active &&
          (await executionStatus(owner, active)) === "accepted" &&
          !routing.nativeMatches(active, await runtime.snapshot(AgentDoc, record.id, context))
        )
          throw new Error("Pi saved native model unavailable");
        remember(owner);
        await reconcileLogs(owner);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    // Commit migration/input retirement only after every binding has passed recovery validation.
    for (const owner of owners.values()) {
      await owner.conversation.commit(async (tx) => {
        const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
        for (const receipt of metadata.receipts) {
          const record = await tx.submissionByRequest(owner.conversation.id, receipt.requestId);
          if (record) receipt.admission = { state: "submitted" };
          if (receipt.publication?.disposition.state === "pending") {
            receipt.publication.disposition = { state: "uncertain" };
            receipt.publication.chunks = receipt.publication.chunks.map((chunk) =>
              chunk.state === "pending" ? { state: "uncertain" } : chunk,
            );
          }
        }
      }, context);
      await reload(owner);
    }
    for (const owner of owners.values())
      for (const receipt of owner.metadata.receipts)
        if (
          (await executionStatus(owner, receipt)) === "accepted" ||
          (receipt.admission.state !== "withdrawn" && !receipt.observation) ||
          (owner.metadata.receipts.at(-1)?.requestId === receipt.requestId &&
            receipt.authorization !== "clear" &&
            (await executionStatus(owner, receipt)) === "completed") ||
          owner.metadata.activeRequestId === receipt.requestId
        ) {
          try {
            await startAccepted(owner, receipt);
          } catch {
            if (!receipt.googleAuthSource) throw new Error("Pi recovery admission failed");
          }
        }
    // A settled reusable conversation must explicitly leave native processing even after a crash.
    for (const owner of owners.values()) {
      const receipt = owner.metadata.receipts.at(-1);
      if (receipt && !owner.metadata.activeRequestId) {
        await reconcileSettledPresentation(owner, receipt);
      }
    }
    runtime.resume();

    const continuationPoller = startGoogleAuthContinuationCoordinator({
      client: continuationClient,
      runtime,
      owners,
      serialAdmission,
      isClosing: () => closing,
      hasMonitor: (requestId) => monitors.has(requestId),
      reload,
      reconcileLogs,
      executionStatus,
      startAccepted,
      fingerprintRequest: fingerprintPiRequest,
      configureReceipt: (tx, id, receipt) => routing.configureReceipt(tx, id, receipt),
      now: Date.now,
    });

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
      const replyProof = request.slackReplyAdmission;
      if (
        replyProof &&
        (replyProof.teamId !== config.slackTeamId ||
          !request.triggerSlackId ||
          !request.messageTs ||
          request.triggerGithubLogin ||
          !request.correlationKey ||
          (request.correlationKey.startsWith("slack:thread:") &&
            request.correlationKey !== `slack:thread:${replyProof.channel}/${replyProof.threadTs}`))
      ) {
        res.status(400).json({ error: "slack_reply_authority_invalid" });
        return;
      }
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
            let receipt = duplicate.metadata.receipts.find((item) => item.requestId === requestId);
            if (!receipt || receipt.fingerprint !== fingerprint)
              return { kind: "error", status: 409, error: "request_id_payload_mismatch" } as const;
            if (
              (await executionStatus(duplicate, receipt)) === "accepted" &&
              receipt.modelSelection &&
              !routing.supported(receipt.modelSelection).ok
            )
              return { kind: "error", status: 409, error: "pi_saved_model_unavailable" } as const;
            const priorMonitor = monitors.get(requestId);
            if (
              !priorMonitor ||
              (priorMonitor.terminal?.type === "done" && priorMonitor.terminal.authWait)
            ) {
              // A terminal frame precedes UI drain and active-authority release. Never replace its
              // presentation or reclaim first publication until that request owner has finished.
              if (priorMonitor?.terminal) {
                await priorMonitor.completion;
                await reload(duplicate);
                receipt =
                  duplicate.metadata.receipts.find((item) => item.requestId === requestId) ??
                  receipt;
              }
              if ((await executionStatus(duplicate, receipt)) === "accepted")
                await startAccepted(duplicate, receipt);
              else if (
                receipt.authorization !== "clear" &&
                (await executionStatus(duplicate, receipt)) === "completed"
              )
                await observeSettlement(duplicate, receipt);
              if ((await executionStatus(duplicate, receipt)) !== "accepted")
                await reconcileSettledPresentation(duplicate, receipt);
              if (priorMonitor?.terminal?.type === "done")
                priorMonitor.terminal = await doneFrame(duplicate, receipt);
            }
            return { kind: "accepted", owner: duplicate, receipt, duplicate: true } as const;
          }
          const selection = selectPiTaskModel({
            pool: routing.pool,
            routingTask: request.routingTask ?? request.prompt,
            overrides: {
              modelProfile: request.modelProfile,
              modelId: request.modelId,
              thinkingLevel: request.thinkingLevel,
              routingTask: request.routingTask,
            },
          });
          if (!selection.ok)
            return { kind: "error", status: 400, error: selection.error.code } as const;
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
          const replyAnchor = replyProof
            ? resolveAnchorForCorrelationKey(
                `slack:thread:${replyProof.channel}/${replyProof.threadTs}`,
              )
            : undefined;
          const replyOwner = replyAnchor
            ? [...owners.values()].find((item) => item.metadata.anchorId === replyAnchor)
            : undefined;
          if (owner && replyAnchor && owner.metadata.anchorId !== replyAnchor)
            return {
              kind: "error",
              status: 409,
              error: "slack_reply_conversation_mismatch",
            } as const;
          owner ??= replyOwner;
          if (owner && owner.metadata.directory !== request.directory)
            return { kind: "error", status: 409, error: "session_directory_mismatch" } as const;
          const resumed = owner !== undefined;
          if (owner) {
            const live = await runtime.snapshot(LiveDoc, owner.conversation.id, context);
            if (live?.run || owner.metadata.activeRequestId) {
              const activeRequestId = owner.metadata.activeRequestId;
              const waitingAdmission =
                !live?.run &&
                owner.metadata.receipts.some(
                  (item) =>
                    item.requestId === activeRequestId &&
                    item.googleAuthSource &&
                    !monitors.has(item.requestId),
                );
              const activeReceipt = owner.metadata.receipts.find(
                (item) => item.requestId === activeRequestId,
              );
              const settled =
                activeReceipt && (await executionStatus(owner, activeReceipt)) !== "accepted";
              if (!request.interrupt && !waitingAdmission && !settled)
                return { kind: "busy", sessionId: sessionId(owner) } as const;
              await reconcileLogs(owner);
              await owner.conversation.abort(context);
              const active = owner.metadata.activeRequestId;
              if (active) {
                const pending = monitors.get(active);
                if (pending) await pending.completion;
                else {
                  const interruptedOwner = owner;
                  const interruptedReceipt = owner.metadata.receipts.find(
                    (item) => item.requestId === active,
                  );
                  const submitted = await submissionFor(owner, active);
                  if (submitted && interruptedReceipt) {
                    await reconcileLogs(owner);
                    await submitted.wait(context);
                    await observeSettlement(owner, interruptedReceipt);
                  }
                  // An admission may have been persisted before submit/monitor failed. Interrupt withdraws that intent too.
                  await owner.conversation.commit(async (tx) => {
                    const metadata = await tx.doc(
                      piConversationMetadataDoc,
                      interruptedOwner.conversation.id,
                    );
                    const receipt = metadata.receipts.find((item) => item.requestId === active);
                    if (
                      receipt &&
                      !(await tx.submissionByRequest(interruptedOwner.conversation.id, active))
                    )
                      receipt.admission = { state: "withdrawn", at: Date.now() };
                    if (metadata.activeRequestId === active) delete metadata.activeRequestId;
                  }, context);
                }
              }
              await reload(owner);
              await reconcileLogs(owner);
            }
          }
          const {
            prompt: admittedPrompt,
            routingTask: _routingTask,
            slackReplyAdmission,
            ...authority
          } = request;
          const receipt: PiAdmissionReceipt = {
            modelSelection: { ...selection.value, history: [...selection.value.history] },
            requestId,
            fingerprint,
            triggerId: mintTriggerId(),
            startedAt: Date.now(),
            resumed,
            request: authority,
            delivery: slackReplyAdmission
              ? { owner: "host", target: slackReplyAdmission }
              : { owner: "tool" },
            ...(config.slackTeamId ? { slackTeamId: config.slackTeamId } : {}),
            admission: { state: "intent", prompt: admittedPrompt },
          };
          if (!owner) {
            const anchorId =
              replyAnchor ??
              (request.correlationKey
                ? (resolveAnchorForCorrelationKey(request.correlationKey) ?? mintAnchor())
                : mintAnchor());
            const metadata: ConversationMetadata = {
              version: 3,
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
                  model: { provider: "codex-lb", modelId: selection.value.modelId },
                  thinkingLevel: selection.value.thinkingLevel,
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
              if (!(await routing.configureReceipt(tx, existingOwner.conversation.id, receipt)))
                throw new Error("Pi model admission unavailable");
            }, context);
            await reload(owner);
          }
          remember(owner);
          await reconcileLogs(owner);
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
          requestId: receipt.requestId,
          sessionId: sessionId(owner),
          correlationKey: receipt.request.correlationKey,
          resumed: receipt.resumed,
        });
        const pending = monitors.get(receipt.requestId);
        if (pending?.terminal) {
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
                    ? `${message.toolName} · ${message.isError ? "error" : "finished"}`
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
        const continuation = owner.metadata.receipts.find(
          (item) => item.googleAuthSource?.originalRequestId === receipt.requestId,
        );
        const selection = current?.modelSelection;
        const lastEntry = entries.at(-1);
        const native = lastEntry
          ? await runtime.snapshotAsOf(AgentDoc, owner.conversation.id, lastEntry.id, context)
          : await runtime.snapshot(AgentDoc, owner.conversation.id, context);
        const modelIdentity = selection
          ? `${selection.modelId} · thinking ${selection.thinkingLevel} · profile ${selection.profile} · ${selection.source}`
          : `${native?.model?.modelId ?? "unavailable"} · thinking ${native?.thinkingLevel ?? "unavailable"} · legacy native choice`;
        const routingHistory = selection
          ? `<h3>Task model routing</h3><pre>${escapePiHtml(JSON.stringify({ profile: selection.profile, modelId: selection.modelId, thinkingLevel: selection.thinkingLevel, source: selection.source, reason: selection.reason, escalationLocked: selection.escalationLocked, promotions: selection.promotions, history: selection.history }, null, 2))}</pre>`
          : "";
        const status = await executionStatus(owner, current ?? receipt);
        let displayStatus: string = status === "completed" ? "Model turn completed" : status;
        const authorization =
          current?.authorization ?? (receipt.request.triggerSlackId ? "unavailable" : "clear");
        if (status === "completed" && authorization !== "clear") {
          displayStatus = continuation
            ? `Google authorization continued in trigger ${continuation.triggerId}`
            : owner.metadata.receipts.at(-1)?.requestId !== receipt.requestId
              ? "Google authorization wait superseded by a newer request"
              : (await continuationClient.observeGoogleAuthWait(
                    sessionId(owner),
                    owner.metadata.anchorId,
                    current ?? receipt,
                  )) === "waiting"
                ? "Waiting for Google authorization · model turn finished, Google operation not completed"
                : "Google authorization wait is no longer confirmed · model turn finished";
        }
        const replyBinding = current ?? receipt;
        const publicationSummary =
          replyBinding.delivery.owner === "tool"
            ? "Slack reply ownership: explicit tools"
            : replyBinding.publication
              ? `Slack answer publication: ${replyBinding.publication.disposition.state} · answer entry ${replyBinding.publication.answerEntry} · ${replyBinding.publication.chunks.filter((chunk) => chunk.state === "confirmed").length}/${replyBinding.publication.chunks.length} chunks confirmed`
              : "Slack answer publication: no issued answer";
        res
          .type("html")
          .send(
            `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="/favicon-v4.svg"><link rel="manifest" href="/site.webmanifest"><title>Neo Pi trigger</title></head><body><h1>Neo Pi trigger</h1><p>${escapePiHtml(displayStatus)} · ${escapePiHtml(sessionId(owner))} · ${escapePiHtml(modelIdentity)}</p><p>${escapePiHtml(publicationSummary)}</p>${routingHistory}${body}${liveTools}<h3>Conversation usage</h3><pre>${escapePiHtml(usage)}</pre></body></html>`,
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
        await continuationPoller.close();
        await admissionLine;
        // Drain completed publication and persist footer cleanup while SQLite is still open.
        for (const owner of owners.values()) await owner.presentation?.stop();
        await Promise.allSettled(
          [...monitors.values()].filter((item) => item.terminal).map((item) => item.completion),
        );
        await runtime.close(context); // Leaves work pending, unlike abort().
        await Promise.allSettled([...monitors.values()].map((item) => item.completion));
        for (const owner of owners.values()) {
          const receipt = owner.metadata.receipts.at(-1);
          if (!receipt) continue;
          await owner.presentation?.stop();
        }
        await ownerLock.release();
      },
    };
  } catch {
    closing = true;
    for (const owner of owners.values()) await owner.presentation?.stop();
    await harness?.close(context).catch(() => undefined);
    await Promise.allSettled([...monitors.values()].map((item) => item.completion));
    await ownerLock.release();
    return { ok: false, error: "pi_startup_failed" };
  }
}
