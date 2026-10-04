import { z } from "zod/v4";
import {
  mintAnchor,
  GenericMcpApprovalSchema,
  buildApprovalButtonValue,
  findLatestMcpApprovalProjection,
  type GenericMcpApproval,
  type McpNativeAuthority,
  type McpApprovalClick,
  type McpApprovalReader,
  type McpApprovalProjection,
  type McpApprovalResolution,
} from "@thor/common";
import { ApprovalStore } from "./approval-store.js";
import type { McpApprovalOwner } from "./mcp-approval-owner.js";
import type { McpServiceCallOutcome } from "./mcp-call-result.js";

/** Validated connection handle remains live and pinned until the dispatch/result window closes. */
export interface GenericMcpPreparedCall {
  readonly server: string;
  readonly tool: string;
  readonly toolRef: string;
  readonly connectionRevision: string;
  readonly catalogFingerprint: string;
  readonly arguments: GenericMcpApproval["arguments"];
  readonly isCurrent: () => boolean;
  readonly dispatch: () => Promise<McpServiceCallOutcome>;
}

const slackReply = z.looseObject({
  ok: z.boolean(),
  team_id: z.string().optional(),
  ts: z.string().optional(),
  channel: z
    .union([
      z.string(),
      z.looseObject({
        id: z.string(),
        is_im: z.boolean().optional(),
        user: z.string().optional(),
        is_shared: z.boolean().optional(),
        is_ext_shared: z.boolean().optional(),
      }),
    ])
    .optional(),
});
const creationFence = "00000000-0000-7000-8000-000000000003";
function failure(
  status: "denied" | "uncertain" | "review_not_supported",
  message: string,
): McpServiceCallOutcome {
  return { status, isError: true, message };
}
function originalRequestCurrent(action: GenericMcpApproval): boolean {
  const latest = findLatestMcpApprovalProjection(action.authority.sessionId);
  const {
    sessionId: _session,
    anchorId,
    triggerId,
    taskId: _task,
    callId: _call,
    ...projection
  } = action.authority;
  return (
    !!latest &&
    latest.anchorId === anchorId &&
    latest.triggerId === triggerId &&
    JSON.stringify(latest.nativeMcp) === JSON.stringify(projection)
  );
}
function readerOwns(action: GenericMcpApproval, reader: McpApprovalReader): boolean {
  const authority = action.authority;
  return (
    JSON.stringify(reader.requester) === JSON.stringify(authority.requester) &&
    reader.teamId === authority.teamId &&
    reader.repositoryDirectory === authority.repositoryDirectory &&
    reader.sourceKey === authority.sourceKey &&
    reader.requestId === authority.requestId &&
    reader.sessionId === authority.sessionId
  );
}
function projectApproval(action: GenericMcpApproval): McpApprovalProjection {
  const status = action.dispatch.status;
  return {
    actionId: action.id,
    server: action.server,
    tool: action.tool,
    disposition:
      status === "confirmed"
        ? action.dispatch.isError
          ? "tool_error"
          : "completed"
        : status === "consumed"
          ? "uncertain"
          : status === "pending" && action.notification.status !== "confirmed"
            ? "uncertain"
            : status,
    channel: action.destination.channel,
    ...(action.notification.status === "confirmed"
      ? { threadTs: action.notification.messageTs }
      : {}),
    repositoryDirectory: action.authority.repositoryDirectory,
    requester: action.destination.userId,
    reader: {
      requester: action.authority.requester,
      teamId: action.authority.teamId,
      repositoryDirectory: action.authority.repositoryDirectory,
      sourceKey: action.authority.sourceKey,
      requestId: action.authority.requestId,
      sessionId: action.authority.sessionId,
    },
  };
}

// Slack credentials stay redacted from constructor custody until the notification HTTP boundary.
class SlackReviewCredential {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[REDACTED]";
  }
}

/** Generic review/dispatch owns only new versioned records; specialized legacy handlers stay separate. */
export class GenericMcpApprovals {
  readonly #botToken: SlackReviewCredential | undefined;
  readonly #apiBaseUrl: string;
  private readonly store: ApprovalStore;
  private readonly pendingWindows = new Set<Promise<unknown>>();
  private closed = false;
  /** Only the existing MCP owner wires private state and Slack configuration here. */
  constructor(
    private readonly owner: McpApprovalOwner,
    slack: { botToken?: string; apiBaseUrl?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new ApprovalStore(owner.root, "genericMcp");
    this.#botToken = slack.botToken ? new SlackReviewCredential(slack.botToken) : undefined;
    this.#apiBaseUrl = (slack.apiBaseUrl ?? "https://slack.com/api").replace(/\/$/, "");
  }
  private async slackApi(method: string, body: Record<string, unknown>) {
    if (!this.#botToken) return undefined;
    try {
      const response = await this.fetchImpl(`${this.#apiBaseUrl}/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#botToken.reveal()}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return undefined;
      const parsed = slackReply.safeParse(await response.json());
      return parsed.success && parsed.data.ok ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  private async privateDestination(authority: McpNativeAuthority) {
    if (authority.requester.source !== "slack" || !authority.teamId) return undefined;
    const auth = await this.slackApi("auth.test", {});
    if (auth?.team_id !== authority.teamId) return undefined;
    const opened = await this.slackApi("conversations.open", { users: authority.requester.id });
    if (!opened?.channel || typeof opened.channel === "string") return undefined;
    const info = await this.slackApi("conversations.info", { channel: opened.channel.id });
    const channel = info?.channel;
    if (
      !channel ||
      typeof channel === "string" ||
      !channel.is_im ||
      channel.user !== authority.requester.id ||
      channel.is_shared ||
      channel.is_ext_shared ||
      !/^D[A-Z0-9]+$/.test(channel.id) ||
      channel.id !== opened.channel.id
    )
      return undefined;
    return { teamId: authority.teamId, userId: authority.requester.id, channel: channel.id };
  }
  /** Full plain-text arguments fit one Slack section or review is unsupported, never truncated. */
  async prepare(
    call: GenericMcpPreparedCall,
    authority: McpNativeAuthority,
    currentAuthority: () => boolean,
  ): Promise<McpServiceCallOutcome> {
    const review = `Neo MCP approval (expires in 15 minutes)\nRepository: ${authority.repositoryDirectory}\n${call.server}/${call.tool}\n${JSON.stringify(call.arguments, null, 2)}`;
    if (review.length > 2800)
      return failure(
        "review_not_supported",
        "MCP approval review_not_supported: full arguments exceed private review budget.",
      );
    if (
      this.closed ||
      authority.requester.source !== "slack" ||
      !authority.teamId ||
      !authority.sourceKey?.startsWith("slack:thread:")
    )
      return failure("denied", "MCP generic review requires the trusted Slack requester.");
    const window = this.store.withGenericLock(
      creationFence,
      async (): Promise<McpServiceCallOutcome> => {
        // Same host tool call cannot resend a card after receipt loss or broker reconstruction.
        const existing = this.store
          .listGeneric()
          .find(
            (action) =>
              action.authority.sessionId === authority.sessionId &&
              action.authority.requestId === authority.requestId &&
              action.authority.callId === authority.callId,
          );
        if (existing) {
          if (
            existing.activationId !== this.owner.activationId ||
            existing.toolRef !== call.toolRef ||
            JSON.stringify(existing.arguments) !== JSON.stringify(call.arguments) ||
            !currentAuthority() ||
            !call.isCurrent() ||
            !originalRequestCurrent(existing) ||
            Date.parse(existing.expiresAt) <= Date.now()
          )
            return failure("denied", "MCP approval authority changed; request fresh review.");
          return existing.notification.status === "confirmed" &&
            existing.dispatch.status === "pending"
            ? {
                status: "pending_approval",
                isError: false,
                actionId: existing.id,
                server: call.server,
                tool: call.tool,
              }
            : failure(
                "uncertain",
                "MCP approval already has a durable disposition; do not retry automatically.",
              );
        }
        const destination = await this.privateDestination(authority);
        if (this.closed || !destination || !currentAuthority() || !call.isCurrent())
          return failure(
            "denied",
            "MCP private requester review unavailable or authority changed.",
          );
        const now = new Date();
        const action = GenericMcpApprovalSchema.parse({
          version: 1,
          operation: "genericMcp",
          id: mintAnchor(),
          dateSegment: now.toISOString().slice(0, 10),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
          server: call.server,
          tool: call.tool,
          arguments: structuredClone(call.arguments),
          effectiveArguments: structuredClone(call.arguments),
          preparationVersion: 1,
          activationId: this.owner.activationId,
          connectionRevision: call.connectionRevision,
          catalogFingerprint: call.catalogFingerprint,
          toolRef: call.toolRef,
          authority,
          destination,
          notification: { status: "intent" },
          dispatch: { status: "pending" },
        });
        // No network publication before intent + private destination are durable.
        this.store.updateGeneric(action);
        const value = buildApprovalButtonValue({
          actionId: action.id,
          upstreamName: "genericMcp",
          threadTs: "0",
        });
        const receipt = await this.slackApi("chat.postMessage", {
          channel: destination.channel,
          text: "Private MCP approval requested",
          blocks: [
            { type: "section", text: { type: "plain_text", text: review, emoji: false } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Approve" },
                  action_id: "approval_approve",
                  value,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Reject" },
                  action_id: "approval_reject",
                  value,
                },
              ],
            },
          ],
        });
        if (!receipt?.ts || receipt.channel !== destination.channel) {
          action.notification = { status: "uncertain" };
          this.store.updateGeneric(action);
          return failure(
            "uncertain",
            "MCP approval delivery unconfirmed; do not resend automatically.",
          );
        }
        action.notification = { status: "confirmed", messageTs: receipt.ts };
        if (
          this.closed ||
          !currentAuthority() ||
          !call.isCurrent() ||
          Date.parse(action.expiresAt) <= Date.now()
        ) {
          action.dispatch = { status: "rejected", reason: "stale" };
          this.store.updateGeneric(action);
          return failure(
            "denied",
            "MCP approval authority changed during private publication; request fresh review.",
          );
        }
        this.store.updateGeneric(action);
        return {
          status: "pending_approval",
          isError: false,
          actionId: action.id,
          server: action.server,
          tool: action.tool,
        };
      },
    );
    this.pendingWindows.add(window);
    try {
      const result = await window;
      return result.status === "ok"
        ? result.value
        : failure("denied", "MCP approval preparation already in progress.");
    } catch {
      return failure(
        "uncertain",
        "MCP approval persistence unavailable; do not retry automatically.",
      );
    } finally {
      this.pendingWindows.delete(window);
    }
  }
  /** CLI never gets reader scope: generic IDs cannot fall through to raw historical rendering. */
  contains(id: string): boolean {
    return !!this.store.getGeneric(id);
  }
  /** Authenticated scope equality applies to every historical read, including removed servers. */
  read(
    id: string,
    reader: McpApprovalReader,
    revisionCurrent: (action: GenericMcpApproval) => boolean,
  ): McpApprovalProjection | undefined {
    const action = this.store.getGeneric(id);
    return action && readerOwns(action, reader)
      ? this.projectCurrentApproval(action, revisionCurrent)
      : undefined;
  }
  /** List filters stored authority, not current catalog visibility or forgeable command context. */
  list(
    reader: McpApprovalReader,
    revisionCurrent: (action: GenericMcpApproval) => boolean,
  ): McpApprovalProjection[] {
    return this.store
      .listGeneric()
      .filter((action) => readerOwns(action, reader))
      .map((action) => this.projectCurrentApproval(action, revisionCurrent));
  }

  private projectCurrentApproval(
    action: GenericMcpApproval,
    revisionCurrent: (action: GenericMcpApproval) => boolean,
  ): McpApprovalProjection {
    const projection = projectApproval(action);
    if (
      action.dispatch.status === "pending" &&
      (action.activationId !== this.owner.activationId ||
        Date.parse(action.expiresAt) <= Date.now() ||
        !originalRequestCurrent(action) ||
        !revisionCurrent(action))
    )
      return { ...projection, disposition: "rejected" };
    return projection;
  }
  /** Claim is durably consumed before upstream I/O; a missing receipt remains uncertain forever. */
  async resolve(
    click: McpApprovalClick,
    prepare: (action: GenericMcpApproval) => Promise<GenericMcpPreparedCall | undefined>,
  ): Promise<McpApprovalResolution> {
    if (this.closed) return { status: "denied", message: "MCP approvals closed." };
    const window = this.store.withGenericLock(
      click.actionId,
      async (): Promise<McpApprovalResolution> => {
        const action = this.store.getGeneric(click.actionId);
        if (
          !action ||
          action.destination.userId !== click.userId ||
          action.destination.teamId !== click.teamId ||
          action.destination.channel !== click.channel ||
          action.notification.status !== "confirmed" ||
          action.notification.messageTs !== click.messageTs
        )
          return { status: "denied", message: "MCP approval reader or private delivery denied." };
        if (action.dispatch.status !== "pending")
          return { status: "generic", value: projectApproval(action) };
        if (
          !originalRequestCurrent(action) ||
          action.activationId !== this.owner.activationId ||
          Date.parse(action.expiresAt) <= Date.now()
        ) {
          action.dispatch = {
            status: "rejected",
            reason: Date.parse(action.expiresAt) <= Date.now() ? "expired" : "stale",
          };
          this.store.updateGeneric(action);
          return { status: "generic", value: projectApproval(action) };
        }
        if (click.decision === "rejected") {
          action.dispatch = { status: "rejected", reason: "human" };
          this.store.updateGeneric(action);
          return { status: "generic", value: projectApproval(action) };
        }
        const call = await prepare(action);
        const destination = await this.privateDestination(action.authority);
        if (
          this.closed ||
          !call ||
          !call.isCurrent() ||
          !originalRequestCurrent(action) ||
          Date.parse(action.expiresAt) <= Date.now() ||
          !destination ||
          JSON.stringify(destination) !== JSON.stringify(action.destination)
        ) {
          action.dispatch = { status: "rejected", reason: "stale" };
          this.store.updateGeneric(action);
          return { status: "generic", value: projectApproval(action) };
        }
        const claimedAt = new Date().toISOString();
        action.dispatch = { status: "consumed", claimedAt };
        this.store.updateGeneric(action);
        // Last synchronous check pins this exact validated live snapshot through the I/O window.
        if (
          this.closed ||
          !call.isCurrent() ||
          !originalRequestCurrent(action) ||
          Date.parse(action.expiresAt) <= Date.now()
        )
          return { status: "generic", value: projectApproval(action) };
        const result = await call.dispatch();
        if (result.status === "completed") {
          action.dispatch = { status: "confirmed", claimedAt, isError: result.isError };
          this.store.updateGeneric(action);
        }
        return { status: "generic", value: projectApproval(action) };
      },
    );
    this.pendingWindows.add(window);
    try {
      const result = await window;
      return result.status === "ok"
        ? result.value
        : {
            status: "busy",
            message: "MCP approval dispatch in progress; no new dispatch granted.",
          };
    } catch {
      return {
        status: "denied",
        message:
          "MCP approval storage unavailable; dispatch may be uncertain. Do not retry mutation.",
      };
    } finally {
      this.pendingWindows.delete(window);
    }
  }
  /** Shutdown drains claimed windows before the lifetime kernel fence can be released. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pendingWindows]);
  }
}
