import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Harness,
  type Conversation,
  type Tx,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { mintTriggerId } from "@thor/common";
import {
  piConversationMetadataDoc,
  piConversationMetadataSchema,
  type PiTriggerRequest,
} from "./pi-runner-state.js";
import {
  GoogleAuthContinuationSchema,
  GoogleAuthWaitBindingSchema,
  type GoogleAuthContinuation,
} from "@thor/common";
import { z } from "zod";
import type { PiAdmissionReceipt } from "./pi-runner-state.js";

const ReadyOutboxSchema = z.object({ continuations: z.array(GoogleAuthContinuationSchema) });

type GoogleAuthConversationOwner = {
  conversation: Conversation;
  metadata: ReturnType<typeof piConversationMetadataSchema.parse>;
};
const context = BACKGROUND_CONTEXT;

/** Secret-gated outbox client; responses and credentials never enter logs or model input. */
export class GoogleAuthContinuationClient {
  readonly #url: URL;
  readonly #headers: Record<string, string>;
  constructor(remoteCliUrl: string, internalSecret: string) {
    this.#url = new URL("/internal/google-workspace/continuations", remoteCliUrl);
    if (
      !["http:", "https:"].includes(this.#url.protocol) ||
      this.#url.username ||
      this.#url.password
    )
      throw new Error("Google auth continuation broker URL invalid");
    this.#headers = {
      "x-thor-internal-secret": internalSecret,
      "content-type": "application/json",
    };
  }
  /** Unavailable or legacy brokers leave work unconsumed. */
  async ready(signal: AbortSignal): Promise<GoogleAuthContinuation[]> {
    try {
      const response = await fetch(this.#url, {
        headers: this.#headers,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (!response.ok) return [];
      const parsed = ReadyOutboxSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.continuations : [];
    } catch {
      return [];
    }
  }
  /** Google auth wait observation fails closed without a frozen workspace or authoritative broker response. */
  async observeGoogleAuthWait(
    sessionId: string,
    anchorId: string,
    receipt: PiAdmissionReceipt,
  ): Promise<"waiting" | "clear" | "unavailable"> {
    if (!receipt.request.triggerSlackId) return "clear";
    if (!receipt.slackTeamId) return "unavailable";
    try {
      const response = await fetch(new URL("/internal/google-workspace/waits", this.#url), {
        headers: this.#headers,
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return "unavailable";
      const parsed = z
        .strictObject({ waits: z.array(GoogleAuthWaitBindingSchema) })
        .safeParse(await response.json());
      if (!parsed.success) return "unavailable";
      return parsed.data.waits.some(
        (record) =>
          record.sessionId === sessionId &&
          record.anchorId === anchorId &&
          record.triggerId === receipt.triggerId &&
          record.slackUserId === receipt.request.triggerSlackId &&
          record.slackTeamId === receipt.slackTeamId,
      )
        ? "waiting"
        : "clear";
    } catch {
      return "unavailable";
    }
  }

  /** Bind a durable admission to its resumed trigger before any tool can run. */
  async acknowledge(id: string, dispatchTriggerId?: string): Promise<boolean> {
    try {
      const response = await fetch(new URL(`${this.#url.pathname}/${id}/ack`, this.#url), {
        method: "POST",
        headers: this.#headers,
        redirect: "manual",
        body: JSON.stringify(dispatchTriggerId ? { dispatchTriggerId } : {}),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      const acknowledged = z
        .object({ acknowledged: z.literal(true), dispatchTriggerId: z.string().optional() })
        .safeParse(await response.json());
      return (
        acknowledged.success &&
        (!dispatchTriggerId || acknowledged.data.dispatchTriggerId === dispatchTriggerId)
      );
    } catch {
      return false;
    }
  }
}

/** Sequential polling shares the runner's admission lock and awaits shutdown without overlapping requests. */
function startGoogleAuthContinuationPoller(options: {
  client: GoogleAuthContinuationClient;
  admit: (record: GoogleAuthContinuation) => Promise<"ack" | "defer">;
  recover: () => Promise<void>;
}): { close: () => Promise<void> } {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const completion = (async () => {
    while (!stopped) {
      try {
        await options.recover();
        for (const record of await options.client.ready(controller.signal)) {
          if (stopped) break;
          if ((await options.admit(record)) === "ack" && !stopped)
            await options.client.acknowledge(record.id);
        }
      } catch {
        /* Retryable admission failures leave the durable outbox intact. */
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 1000);
          timer.unref();
        });
    }
  })();
  return {
    close: async () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      wake?.();
      await completion;
    },
  };
}

/** The original receipt, not tool output or a user selector, establishes continuation ownership. */
function matchesGoogleAuthOriginal(
  record: GoogleAuthContinuation,
  original: PiAdmissionReceipt,
  identity: { sessionId: string; anchorId: string },
): boolean {
  return (
    !original.googleAuthSource &&
    record.sessionId === identity.sessionId &&
    record.anchorId === identity.anchorId &&
    record.triggerId === original.triggerId &&
    record.slackUserId === original.request.triggerSlackId &&
    record.slackTeamId === original.slackTeamId
  );
}

/** Deterministic identity reserves a namespace that external trigger requests cannot use. */
function googleAuthResumeRequestId(record: GoogleAuthContinuation): string {
  return `google-auth:${record.id}`;
}

/** Own Google continuation admission/recovery while reusing the host's normal submit and log lifecycle. */
export function startGoogleAuthContinuationCoordinator(options: {
  client: GoogleAuthContinuationClient;
  runtime: Harness;
  owners: ReadonlyMap<string, GoogleAuthConversationOwner>;
  serialAdmission: <T>(work: () => Promise<T>) => Promise<T>;
  isClosing: () => boolean;
  hasMonitor: (requestId: string) => boolean;
  reload: (owner: GoogleAuthConversationOwner) => Promise<void>;
  reconcileLogs: (owner: GoogleAuthConversationOwner) => Promise<void>;
  executionStatus: (
    owner: GoogleAuthConversationOwner,
    receipt: PiAdmissionReceipt,
  ) => Promise<"accepted" | "completed" | "aborted" | "error">;
  startAccepted: (
    owner: GoogleAuthConversationOwner,
    receipt: PiAdmissionReceipt,
  ) => Promise<"started" | "deferred" | "retired">;
  fingerprintRequest: (request: PiTriggerRequest) => string;
  /** Adopt the original saved selection in the same native transaction as continuation admission. */
  configureReceipt: (tx: Tx, id: ConversationId, receipt: PiAdmissionReceipt) => Promise<boolean>;
  now: () => number;
}): { close: () => Promise<void> } {
  return startGoogleAuthContinuationPoller({
    client: options.client,
    recover: () =>
      options.serialAdmission(async () => {
        if (options.isClosing()) return;
        for (const owner of options.owners.values()) {
          await options.reload(owner);
          const receipt = owner.metadata.receipts.find(
            (item) => item.requestId === owner.metadata.activeRequestId,
          );
          if (
            receipt?.googleAuthSource &&
            receipt.admission.state !== "withdrawn" &&
            !options.hasMonitor(receipt.requestId)
          ) {
            try {
              await options.startAccepted(owner, receipt);
            } catch {
              /* Broker outage leaves admission durable. */
            }
          }
        }
      }),
    admit: (record) =>
      options.serialAdmission(async () => {
        if (options.isClosing()) return "defer";
        const owner = options.owners.get(record.sessionId);
        if (!owner) return "ack";
        await options.reload(owner);
        const requestId = googleAuthResumeRequestId(record);
        const duplicate = owner.metadata.receipts.find((item) => item.requestId === requestId);
        if (duplicate) {
          // Admission is already durable even if ack or submit failed. Never resurrect superseded work.
          if (duplicate.googleAuthSource?.id !== record.id) return "ack";
          if (
            duplicate.admission.state !== "withdrawn" &&
            owner.metadata.activeRequestId === requestId &&
            !options.hasMonitor(requestId)
          )
            return (await options.startAccepted(owner, duplicate)) === "deferred" ? "defer" : "ack";
          return "ack";
        }
        const original = owner.metadata.receipts.find(
          (item) => item.triggerId === record.triggerId,
        );
        if (
          !original ||
          record.expiresAtMs <= options.now() ||
          !matchesGoogleAuthOriginal(record, original, {
            sessionId: `pi-${owner.metadata.anchorId}`,
            anchorId: owner.metadata.anchorId,
          }) ||
          owner.metadata.receipts.at(-1)?.requestId !== original.requestId ||
          ["aborted", "error"].includes(await options.executionStatus(owner, original))
        )
          return "ack";
        const live = await options.runtime.snapshot(LiveDoc, owner.conversation.id, context);
        if (live?.run || owner.metadata.activeRequestId || options.hasMonitor(original.requestId))
          return "defer";
        const request = {
          ...original.request,
          prompt: "Continue only the original task after Google authorization.",
          stream: false,
        };
        const receipt: PiAdmissionReceipt = {
          requestId,
          fingerprint: options.fingerprintRequest(request),
          triggerId: mintTriggerId(),
          startedAt: options.now(),
          resumed: true,
          request: original.request,
          delivery: original.delivery,
          admission: { state: "intent", prompt: request.prompt },
          slackTeamId: record.slackTeamId,
          googleAuthSource: { ...record, originalRequestId: original.requestId },
          ...(original.modelSelection ? { modelSelection: original.modelSelection } : {}),
          ...(original.escalationCalls ? { escalationCalls: original.escalationCalls } : {}),
        };
        await owner.conversation.commit(async (tx) => {
          const metadata = await tx.doc(piConversationMetadataDoc, owner.conversation.id);
          if (!(await options.configureReceipt(tx, owner.conversation.id, receipt)))
            throw new Error("Pi Google continuation model unavailable");
          metadata.receipts.push(receipt);
          metadata.activeRequestId = requestId;
        }, context);
        await options.reload(owner);
        await options.reconcileLogs(owner);
        return (await options.startAccepted(owner, receipt)) === "deferred" ? "defer" : "ack";
      }),
  });
}
