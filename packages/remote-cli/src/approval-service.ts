import {
  buildApprovalSlackMessage,
  createLogger,
  ExecResultSchema,
  findAnchorContext,
  logError,
  logInfo,
  logWarn,
  resolveSlackThreadTargetFromTrigger,
  writeToolCallLog,
} from "@thor/common";
import type { ApprovalRequiredEventPayload } from "@thor/common";
import { ApprovalStore, type ApprovalAction } from "./approval-store.ts";
import { postSlackMessageApi } from "./slack-post-message.ts";

const log = createLogger("approval");
const DEFAULT_APPROVALS_DIR = "/workspace/data/approvals";

/**
 * Result shape returned to the `/exec/*` HTTP surface. Structurally identical to
 * the executors' command results; the approval engine speaks in these terms so
 * MCP and local (gh) executors return one vocabulary.
 */
export interface ApprovalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sideEffectAttempted?: boolean;
}

export function ok(stdout = ""): ApprovalExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

export function fail(stderr: string, stdout = ""): ApprovalExecResult {
  return { stdout, stderr, exitCode: 1 };
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * What an executor reports back after attempting (or declining to attempt) the
 * approved side effect. `sideEffectAttempted` distinguishes "we never touched
 * the upstream/CLI" from "we tried and it failed", which drives retry semantics.
 */
export interface ApprovalOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  sideEffectAttempted: boolean;
  /** Exact args the side effect ran with, for the tool-call audit log. */
  effectiveArgs?: Record<string, unknown>;
}

/**
 * Thrown by {@link ApprovalExecutor.resolve} to fail an approval closed at click
 * time (e.g. the integration is no longer reachable, or the originating session
 * binding is gone). The engine persists the action as a `system` rejection
 * instead of executing it.
 */
export class ApprovalSystemRejection extends Error {
  readonly storedReason: string;
  readonly logEvent?: string;
  readonly logToolCall: boolean;

  constructor(
    message: string,
    storedReason: string,
    opts: { logEvent?: string; logToolCall?: boolean } = {},
  ) {
    super(message);
    this.name = "ApprovalSystemRejection";
    this.storedReason = storedReason;
    if (opts.logEvent !== undefined) this.logEvent = opts.logEvent;
    this.logToolCall = opts.logToolCall ?? false;
  }
}

/** Resolution-time plan produced by an executor for an approved action. */
export interface ApprovalPlan {
  /** Context surfaced in audit logs (e.g. resolved MCP profile/target). */
  logContext: { profile?: string; targetKey?: string };
  /** Performs the side effect. Failures here leave the action retryable. */
  execute(): Promise<ApprovalOutcome>;
}

/**
 * The boundary between the generic approval pipeline and the thing that
 * actually performs a write. The engine owns lookup, dedup, Slack, persistence,
 * and audit logging; an executor owns only "given this approved action, do the
 * work". MCP upstreams and the local `gh` CLI each provide one.
 */
export interface ApprovalExecutor {
  /**
   * Prepare to run an approved action. Throw {@link ApprovalSystemRejection} to
   * fail closed before any side effect; return a plan otherwise.
   */
  resolve(action: ApprovalAction): Promise<ApprovalPlan>;
}

export interface CreatePendingInput {
  /** Approval store namespace; also the `upstream`/`proxyName` in the payload. */
  storeName: string;
  tool: string;
  /** Human-facing label used in fail-closed messages (e.g. "gh issue create"). */
  displayName: string;
  args: Record<string, unknown>;
  sessionId: string;
  callId?: string;
  targetKey?: string;
  profile?: string;
}

export interface ApprovalServiceDeps {
  approvalsDir?: string;
  writeToolCallLogFn?: typeof writeToolCallLog;
  slack?: { botToken?: string; apiBaseUrl?: string };
  fetchImpl?: typeof fetch;
}

export interface ApprovalService {
  /**
   * Register a store namespace and the executor that performs its side effects.
   * Producers (the MCP service, CLI wiring) self-register; only registered
   * stores are consulted by lookup/status/list and resolved on approval.
   */
  register(storeName: string, executor: ApprovalExecutor): void;
  createPending(input: CreatePendingInput): Promise<ApprovalExecResult>;
  resolve(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<ApprovalExecResult>;
  /** Backs the `approval status <id>` / `approval list` command surface. */
  executeApproval(args: string[]): ApprovalExecResult;
}

interface ApprovalLookup {
  upstreamName: string;
  action: ApprovalAction;
  store: ApprovalStore;
}

export function createApprovalService(deps: ApprovalServiceDeps = {}): ApprovalService {
  const approvalsDir = deps.approvalsDir ?? DEFAULT_APPROVALS_DIR;
  const writeToolCallLogFn = deps.writeToolCallLogFn ?? writeToolCallLog;
  const slackConfig = deps.slack;
  const fetchImpl = deps.fetchImpl;
  const stores = new Map<string, ApprovalStore>();
  const executors = new Map<string, ApprovalExecutor>();
  const resolving = new Map<
    string,
    {
      decision: "approved" | "rejected";
      reviewer: string;
      reason?: string;
      promise: Promise<ApprovalExecResult>;
    }
  >();

  function register(storeName: string, executor: ApprovalExecutor): void {
    executors.set(storeName, executor);
  }

  function getStore(name: string): ApprovalStore {
    const existing = stores.get(name);
    if (existing) return existing;
    const store = new ApprovalStore(`${approvalsDir}/${name}`, name);
    stores.set(name, store);
    return store;
  }

  function thorIds(input: { sessionId?: string; callId?: string }): Record<string, string> {
    return {
      ...(input.sessionId && { sessionId: input.sessionId }),
      ...(input.callId && { callId: input.callId }),
    };
  }

  function findApproval(actionId: string): ApprovalLookup | undefined {
    for (const upstreamName of executors.keys()) {
      const store = getStore(upstreamName);
      const action = store.get(actionId);
      if (action) {
        return { upstreamName, action, store };
      }
    }
    return undefined;
  }

  async function postSlackApprovalMessage(input: {
    action: ApprovalAction;
    upstreamName: string;
    channel: string;
    threadTs: string;
  }): Promise<{ ts: string } | { error: string }> {
    const slackMessage = buildApprovalSlackMessage({
      actionId: input.action.id,
      tool: input.action.tool as ApprovalRequiredEventPayload["tool"],
      args: input.action.args,
      upstreamName: input.upstreamName,
      threadTs: input.threadTs,
    });
    const result = await postSlackMessageApi(
      {
        channel: input.channel,
        threadTs: input.threadTs,
        text: slackMessage.text,
        blocks: slackMessage.blocks,
      },
      {
        fetch: fetchImpl,
        env: {
          SLACK_BOT_TOKEN: slackConfig?.botToken,
          SLACK_API_BASE_URL: slackConfig?.apiBaseUrl,
        },
      },
    );
    return "error" in result ? result : { ts: result.ts };
  }

  async function createPending(input: CreatePendingInput): Promise<ApprovalExecResult> {
    const { storeName, tool, displayName, args, sessionId, callId, targetKey, profile } = input;
    const store = getStore(storeName);
    const anchorContext = findAnchorContext(sessionId);
    if (!anchorContext.ok) {
      return fail(
        `Approval required for "${displayName}": no Thor anchor for session ${sessionId} (${anchorContext.reason})`,
      );
    }
    const slackTarget = resolveSlackThreadTargetFromTrigger(sessionId);
    if ("error" in slackTarget) {
      return fail(`Approval required for "${displayName}": ${slackTarget.error}`);
    }
    const action = store.buildPending(
      tool,
      args,
      {
        sessionId,
        trigger: {
          anchorId: anchorContext.anchorId,
          ...(anchorContext.triggerId ? { triggerId: anchorContext.triggerId } : {}),
        },
      },
      { provider: "slack", channel: slackTarget.channel, threadTs: slackTarget.threadTs },
    );
    const slackPost = await postSlackApprovalMessage({
      action,
      upstreamName: storeName,
      channel: slackTarget.channel,
      threadTs: slackTarget.threadTs,
    });
    if ("error" in slackPost) {
      store.rejectLoaded(action, "system", slackPost.error);
      return fail(`Approval required for "${displayName}": ${slackPost.error}`);
    }
    action.notification = {
      provider: "slack",
      channel: slackTarget.channel,
      threadTs: slackTarget.threadTs,
      messageTs: slackPost.ts,
      postedAt: new Date().toISOString(),
    };
    store.update(action);
    logInfo(log, "tool_call_pending_approval", {
      upstream: storeName,
      tool,
      ...(targetKey !== undefined ? { targetKey } : {}),
      ...(profile !== undefined ? { profile } : {}),
      actionId: action.id,
      ...thorIds({ sessionId, callId }),
    });
    writeToolCallLogFn({ tool, decision: "pending", targetKey, profile, args });
    return ok(
      stringify({
        type: "approval_required",
        actionId: action.id,
        proxyName: storeName,
        tool,
        args,
        command: `approval status ${action.id}`,
      }),
    );
  }

  function storedApprovedResult(action: ApprovalAction): ApprovalExecResult {
    const parsed = ExecResultSchema.safeParse(action.result);
    if (!parsed.success) {
      return fail(
        `Stored approved result for approval action ${action.id} is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async function resolveOnce(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<ApprovalExecResult> {
    let lookup: ApprovalLookup | undefined;
    try {
      lookup = findApproval(actionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Failed to load approval action ${actionId}: ${message}`);
    }
    if (!lookup) {
      return fail(`No approval action found with ID: ${actionId}`);
    }

    if (lookup.action.status !== "pending") {
      if (lookup.action.status !== decision) {
        return fail(
          `Approval action ${actionId} is already ${lookup.action.status}; cannot resolve as ${decision}`,
        );
      }
      if (lookup.action.status === "approved") {
        return storedApprovedResult(lookup.action);
      }
      return ok(stringify(lookup.action));
    }

    if (decision === "rejected") {
      const rejected = lookup.store.rejectLoaded(lookup.action, reviewer, reason);
      logInfo(log, "tool_call_rejected", {
        upstream: lookup.upstreamName,
        tool: rejected.tool,
        actionId: rejected.id,
        reviewer,
      });
      writeToolCallLogFn({ tool: rejected.tool, decision: "rejected", args: rejected.args });
      return ok(stringify(rejected));
    }

    const pendingAction = lookup.action;
    const executor = executors.get(lookup.upstreamName);
    if (!executor) {
      return fail(`No executor registered for approval store "${lookup.upstreamName}"`);
    }
    const start = Date.now();
    let plan: ApprovalPlan;
    try {
      plan = await executor.resolve(pendingAction);
    } catch (err) {
      if (err instanceof ApprovalSystemRejection) {
        const rejected = lookup.store.rejectLoaded(pendingAction, "system", err.storedReason);
        if (err.logEvent) {
          logWarn(log, err.logEvent, {
            upstream: lookup.upstreamName,
            tool: rejected.tool,
            actionId: rejected.id,
            error: err.message,
          });
        }
        if (err.logToolCall) {
          writeToolCallLogFn({
            tool: rejected.tool,
            decision: "rejected",
            args: rejected.args,
            error: err.message,
          });
        }
        return fail(err.message, stringify(rejected));
      }
      throw err;
    }

    const outcome = await plan.execute();
    const durationMs = Date.now() - start;
    const { profile, targetKey } = plan.logContext;

    const baseLogFields = {
      upstream: lookup.upstreamName,
      tool: pendingAction.tool,
      ...(targetKey !== undefined ? { targetKey } : {}),
      ...(profile !== undefined ? { profile } : {}),
      durationMs,
      actionId: pendingAction.id,
    };

    if (outcome.ok) {
      logInfo(log, "tool_call_approved", baseLogFields);
      writeToolCallLogFn({
        tool: pendingAction.tool,
        decision: "approved",
        targetKey,
        profile,
        args: outcome.effectiveArgs ?? pendingAction.args,
        durationMs,
        result: outcome.stdout,
      });
      const execResult: ApprovalExecResult = {
        stdout: outcome.stdout,
        stderr: "",
        exitCode: 0,
        sideEffectAttempted: outcome.sideEffectAttempted,
      };
      lookup.store.approveLoaded(pendingAction, execResult, reviewer, reason);
      return execResult;
    }

    logError(log, "tool_call_approved", outcome.stderr, baseLogFields);
    writeToolCallLogFn({
      tool: pendingAction.tool,
      decision: "approved",
      targetKey,
      profile,
      args: outcome.effectiveArgs ?? pendingAction.args,
      durationMs,
      error: outcome.stderr,
    });
    pendingAction.error = outcome.stderr;
    lookup.store.update(pendingAction);
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: 1,
      sideEffectAttempted: outcome.sideEffectAttempted,
    };
  }

  async function resolve(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<ApprovalExecResult> {
    const inFlight = resolving.get(actionId);
    if (inFlight) {
      if (inFlight.decision !== decision) {
        return fail(
          `Approval action ${actionId} is already resolving as ${inFlight.decision}; cannot also resolve as ${decision}`,
        );
      }
      if (inFlight.reviewer !== reviewer || inFlight.reason !== reason) {
        return fail(
          `Approval action ${actionId} is already resolving for reviewer ${inFlight.reviewer}; cannot also resolve as ${reviewer}`,
        );
      }
      return inFlight.promise;
    }

    const promise = resolveOnce(actionId, decision, reviewer, reason);
    resolving.set(actionId, { decision, reviewer, reason, promise });
    try {
      return await promise;
    } finally {
      resolving.delete(actionId);
    }
  }

  function status(actionId: string): ApprovalExecResult {
    let lookup: ApprovalLookup | undefined;
    try {
      lookup = findApproval(actionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Failed to load approval action ${actionId}: ${message}`);
    }
    if (!lookup) {
      return fail(`No approval action found with ID: ${actionId}\n`);
    }
    return ok(stringify(lookup.action));
  }

  function list(): ApprovalExecResult {
    const approvals = [...executors.keys()].flatMap((upstreamName) =>
      getStore(upstreamName).listPending(),
    );
    return ok(stringify({ approvals }));
  }

  function executeApproval(args: string[]): ApprovalExecResult {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      return fail("Usage:\n  approval status <action-id>\n  approval list\n");
    }
    if (args[0] === "status") {
      if (!args[1]) {
        return fail("Usage: approval status <action-id>\n");
      }
      return status(args[1]);
    }
    if (args[0] === "list") {
      return list();
    }
    return fail(
      `Unknown subcommand: ${args[0]}\nUsage:\n  approval status <action-id>\n  approval list\n`,
    );
  }

  return { register, createPending, resolve, executeApproval };
}
