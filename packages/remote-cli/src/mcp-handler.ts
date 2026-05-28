import { z } from "zod";

import {
  appendCorrelationAlias,
  approvalToolRequiresDisclaimer,
  buildApprovalSlackMessage,
  validateDisclaimerCompatibleArgs,
  buildThorDisclaimer,
  computeSlackCorrelationKey,
  createLogger,
  ExecResultSchema,
  extractRepoFromCwd,
  findAnchorContext,
  getProxyConfig,
  injectApprovalDisclaimer,
  isProxyName,
  getRunnerBaseUrl,
  ApprovalRequiredEventPayloadSchema,
  GhIssueCreateApprovalArgsSchema,
  interpolateHeaders,
  logError,
  logInfo,
  logWarn,
  PROXY_NAMES,
  resolveSlackThreadTargetFromTrigger,
  WORKSPACE_CONFIG_PATH,
  createConfigLoader,
  type ProxyConfig,
  type ConfigLoader,
  writeToolCallLog,
} from "@thor/common";
import type { ApprovalRequiredEventPayload } from "@thor/common";
import { ApprovalStore, type ApprovalAction } from "./approval-store.js";
import {
  classifyTool,
  PolicyDriftError,
  PolicyOverlapError,
  validatePolicy,
} from "./policy-mcp.js";
import { unwrapResult } from "./unwrap-result.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { attributionFields, resolveTriggerUser } from "./attribution.js";
import { postSlackMessageApi } from "./slack-post-message.js";
import { execCommand } from "./exec.js";
import { registerCreatedIssueCorrelationAlias } from "./gh-issue-alias.js";

const log = createLogger("mcp");
const DEFAULT_APPROVALS_DIR = "/workspace/data/approvals";
export const GH_APPROVAL_STORE = "gh";
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function buildUpstreamArgs(action: ApprovalAction): Record<string, unknown> {
  if (!approvalToolRequiresDisclaimer(action.tool)) return action.args;
  const trigger = action.origin?.trigger;
  if (!trigger) {
    throw new Error(
      `Approval action ${action.id} is missing origin.trigger for disclaimer injection`,
    );
  }
  const { footer } = buildThorDisclaimer(trigger, getRunnerBaseUrl());
  return injectApprovalDisclaimer(action.tool, action.args, footer);
}

type JiraLookupResult = { ok: true; accountId: string } | { ok: false; reason: string };
const JIRA_ACCOUNT_LOOKUP_TOOL = "lookupJiraAccountId";
const JiraAccountLookupUserSchema = z.object({ accountId: z.string().min(1) }).passthrough();
const JiraAccountLookupResultSchema = z
  .object({
    data: z
      .object({
        users: z
          .object({
            users: z.array(JiraAccountLookupUserSchema),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function parseJiraAccountLookupStdout(stdout: string): JiraLookupResult {
  stdout = stdout.trim();
  if (!stdout) return { ok: false, reason: "lookup_no_match" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    logWarn(log, "jira_account_lookup_parse_failed", {
      reason: "invalid_json",
      raw: stdout,
    });
    return { ok: false, reason: "lookup_parse_failed" };
  }
  const result = JiraAccountLookupResultSchema.safeParse(parsed);
  if (!result.success) {
    logWarn(log, "jira_account_lookup_parse_failed", {
      reason: "schema_mismatch",
      raw: parsed,
    });
    return { ok: false, reason: "lookup_parse_failed" };
  }
  const ids = [...new Set(result.data.data.users.users.map((user) => user.accountId))];
  if (ids.length === 0) return { ok: false, reason: "lookup_no_match" };
  if (ids.length > 1) return { ok: false, reason: "lookup_multiple_matches" };
  return { ok: true, accountId: ids[0] };
}

interface ProxyInstance {
  name: string;
  upstream: UpstreamConnection;
  approvalStore: ApprovalStore;
}

export interface McpExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sideEffectAttempted?: boolean;
}

export interface McpCommandContext {
  directory?: string;
  sessionId?: string;
  callId?: string;
}

export interface McpServiceDeps {
  approvalsDir?: string;
  isProduction?: boolean;
  connectUpstreamFn?: typeof connectUpstream;
  writeToolCallLogFn?: typeof writeToolCallLog;
  configLoader?: ConfigLoader;
  fetchImpl?: typeof fetch;
  slack?: { botToken?: string; apiBaseUrl?: string };
  execCommandFn?: typeof execCommand;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  classification?: string;
}

interface ApprovalLookup {
  upstreamName: string;
  action: ApprovalAction;
  store: ApprovalStore;
}

function ok(stdout = ""): McpExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, stdout = ""): McpExecResult {
  return { stdout, stderr, exitCode: 1 };
}

function isExecResult(value: unknown): value is McpExecResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "stdout" in value &&
    "stderr" in value &&
    "exitCode" in value
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function fuzzyMatch(input: string, candidates: string[]): string[] {
  const lower = input.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()),
  );
}

function suggestMatch(input: string, candidates: string[]): string {
  const matches = fuzzyMatch(input, candidates);
  if (matches.length > 0) {
    return `Did you mean "${matches[0]}"? `;
  }
  return "";
}

export interface McpService {
  getHealth(): Record<string, unknown>;
  warmUpstreams(): Promise<void>;
  closeAll(): Promise<void>;
  executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult>;
  executeApproval(args: string[]): Promise<McpExecResult>;
  requestGhIssueCreateApproval(input: {
    cwd: string;
    args: string[];
    sessionId?: string;
    callId?: string;
  }): Promise<McpExecResult>;
}

export function createMcpService(deps: McpServiceDeps): McpService {
  const approvalsDir = deps.approvalsDir ?? DEFAULT_APPROVALS_DIR;
  const connectUpstreamFn = deps.connectUpstreamFn ?? connectUpstream;
  const writeToolCallLogFn = deps.writeToolCallLogFn ?? writeToolCallLog;
  const getConfig = deps.configLoader ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const fetchImpl = deps.fetchImpl;
  const slackConfig = deps.slack;
  const execCommandFn = deps.execCommandFn ?? execCommand;
  const instances = new Map<string, ProxyInstance>();
  const connecting = new Map<string, Promise<ProxyInstance>>();
  const approvalStores = new Map<string, ApprovalStore>();
  const resolvingApprovals = new Map<
    string,
    {
      decision: "approved" | "rejected";
      reviewer: string;
      reason?: string;
      promise: Promise<McpExecResult>;
    }
  >();

  function getThorIds(context: McpCommandContext): { sessionId?: string; callId?: string } {
    return {
      ...(context.sessionId && { sessionId: context.sessionId }),
      ...(context.callId && { callId: context.callId }),
    };
  }

  function getApprovalStore(name: string): ApprovalStore {
    const existing = approvalStores.get(name);
    if (existing) return existing;
    const store = new ApprovalStore(`${approvalsDir}/${name}`, name);
    approvalStores.set(name, store);
    return store;
  }

  function approvalStoreNames(): string[] {
    return [...PROXY_NAMES, GH_APPROVAL_STORE];
  }

  function parseGhIssueDisplay(args: string[]): {
    title?: string;
    bodyPreview?: string;
    labels?: string[];
    assignees?: string[];
  } {
    const values = (names: string[]) => {
      const found: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const name = names.find((n) => arg === n || arg.startsWith(`${n}=`));
        if (!name) continue;
        if (arg === name && i + 1 < args.length) found.push(args[++i]);
        else if (arg.startsWith(`${name}=`)) found.push(arg.slice(name.length + 1));
      }
      return found;
    };
    const title = values(["--title", "-t"])[0];
    const body = values(["--body", "-b"])[0];
    const labels = values(["--label", "-l"]).flatMap((v) => v.split(",").filter(Boolean));
    const assignees = values(["--assignee", "-a"]).flatMap((v) => v.split(",").filter(Boolean));
    return {
      ...(title ? { title } : {}),
      ...(body ? { bodyPreview: body.length > 700 ? `${body.slice(0, 700)}…` : body } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(assignees.length > 0 ? { assignees } : {}),
    };
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

  async function connectInstance(name: string, proxyDef: ProxyConfig): Promise<ProxyInstance> {
    const interpolatedHeaders = interpolateHeaders(proxyDef.upstream.headers);
    const upstreamConfig = {
      url: proxyDef.upstream.url,
      headers: interpolatedHeaders,
    };

    function scheduleReconnect(attempt: number): void {
      const instance = instances.get(name);
      if (!instance) return;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        logError(
          log,
          "upstream_reconnect_exhausted",
          `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`,
          {
            name,
          },
        );
        instances.delete(name);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      logInfo(log, "upstream_reconnecting", { name, attempt, delayMs: delay });
      setTimeout(() => {
        connectUpstreamFn(name, upstreamConfig, () => scheduleReconnect(1))
          .then((newUpstream) => {
            instance.upstream = newUpstream;
            logInfo(log, "upstream_reconnected", { name, afterAttempt: attempt });
          })
          .catch((err) => {
            logError(
              log,
              "upstream_reconnect_failed",
              err instanceof Error ? err.message : String(err),
              { name, attempt },
            );
            scheduleReconnect(attempt + 1);
          });
      }, delay);
    }

    logInfo(log, "connecting_upstream", { name, url: proxyDef.upstream.url });
    const upstream = await connectUpstreamFn(name, upstreamConfig, () => scheduleReconnect(1));

    const allToolNames = upstream.tools.map((tool) => tool.name);
    try {
      validatePolicy(proxyDef.allow, proxyDef.approve ?? [], allToolNames);
    } catch (err) {
      if (err instanceof PolicyDriftError) {
        if (deps.isProduction) {
          logWarn(log, "policy_drift", { name, orphans: err.orphans });
        } else {
          throw err;
        }
      } else if (err instanceof PolicyOverlapError) {
        throw err;
      } else {
        throw err;
      }
    }

    logInfo(log, "upstream_ready", {
      name,
      upstreamTools: allToolNames.length,
      allow: proxyDef.allow.length,
      approve: (proxyDef.approve ?? []).length,
    });

    return {
      name,
      upstream,
      approvalStore: getApprovalStore(name),
    };
  }

  async function getInstance(name: string): Promise<ProxyInstance | undefined> {
    const proxyDef = getProxyConfig(name);
    if (!proxyDef) {
      instances.delete(name);
      return undefined;
    }

    const existing = instances.get(name);
    if (existing) return existing;

    const pending = connecting.get(name);
    if (pending) return pending;

    const promise = connectInstance(name, proxyDef);
    connecting.set(name, promise);
    try {
      const instance = await promise;
      instances.set(name, instance);
      return instance;
    } finally {
      connecting.delete(name);
    }
  }

  async function lookupJiraAccountIdViaUpstream(
    instance: ProxyInstance,
    cloudId: string,
    email: string,
  ): Promise<JiraLookupResult> {
    if (!instance.upstream.tools.some((tool) => tool.name === JIRA_ACCOUNT_LOOKUP_TOOL)) {
      return { ok: false, reason: "tool_unavailable" };
    }
    const start = Date.now();
    const args = { cloudId, searchString: email };
    try {
      const result = await instance.upstream.client.callTool({
        name: JIRA_ACCOUNT_LOOKUP_TOOL,
        arguments: args,
      });
      const durationMs = Date.now() - start;
      logInfo(log, "jira_account_lookup", {
        upstream: instance.name,
        tool: JIRA_ACCOUNT_LOOKUP_TOOL,
        durationMs,
      });
      writeToolCallLogFn({
        tool: JIRA_ACCOUNT_LOOKUP_TOOL,
        decision: "allowed",
        args,
        result,
        durationMs,
      });
      return parseJiraAccountLookupStdout(unwrapResult(result));
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "jira_account_lookup", message, {
        upstream: instance.name,
        tool: JIRA_ACCOUNT_LOOKUP_TOOL,
        durationMs,
      });
      writeToolCallLogFn({
        tool: JIRA_ACCOUNT_LOOKUP_TOOL,
        decision: "allowed",
        args,
        durationMs,
        error: message,
      });
      return { ok: false, reason: "upstream_disconnected" };
    }
  }

  function validateRepoDirectory(directory?: string): McpExecResult | undefined {
    if (!directory) {
      return fail("Missing required field: directory");
    }
    if (!extractRepoFromCwd(directory)) {
      return fail(
        `Cannot determine repo from directory: ${directory}. Expected /workspace/repos/<repo> (worktrees are not allowed for MCP authz)`,
      );
    }
    return undefined;
  }

  async function listVisibleTools(upstreamName: string): Promise<ToolInfo[] | McpExecResult> {
    if (!isProxyName(upstreamName)) {
      return fail(
        `Unknown upstream "${upstreamName}". Available upstreams: ${PROXY_NAMES.join(", ")}`,
      );
    }

    const instance = await getInstance(upstreamName);
    if (!instance) {
      return fail(`Unknown upstream "${upstreamName}".`);
    }

    const proxyDef = getProxyConfig(upstreamName);
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    return instance.upstream.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        classification: classifyTool(allow, approve, tool.name),
      }))
      .filter((tool) => tool.classification !== "hidden");
  }

  function resolveTool(
    tools: ToolInfo[],
    input: string,
    upstreamName: string,
  ): ToolInfo | McpExecResult {
    const exact = tools.find((tool) => tool.name === input);
    if (exact) return exact;

    const matches = fuzzyMatch(
      input,
      tools.map((tool) => tool.name),
    );
    if (matches.length === 1) {
      return tools.find((tool) => tool.name === matches[0])!;
    }

    return fail(
      `Unknown tool "${input}" on upstream "${upstreamName}". ${suggestMatch(
        input,
        tools.map((tool) => tool.name),
      )}Available tools: ${tools.map((tool) => tool.name).join(", ")}`,
    );
  }

  async function listUpstreams(directory?: string): Promise<McpExecResult> {
    const failure = validateRepoDirectory(directory);
    if (failure) return failure;

    const upstreams = PROXY_NAMES.map((name) => {
      const instance = instances.get(name);
      return {
        name,
        toolCount: instance?.upstream.tools.length ?? 0,
        connected: instances.has(name),
      };
    });

    return ok(stringify({ upstreams }));
  }

  function parseJsonArgs(
    jsonArg: string,
    toolInfo: ToolInfo,
  ): Record<string, unknown> | McpExecResult {
    try {
      const parsed = JSON.parse(jsonArg);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      let stderr = `Invalid JSON argument: ${jsonArg}\n`;
      if (toolInfo.inputSchema) {
        stderr += `\n[hint] Input schema for "${toolInfo.name}":\n${JSON.stringify(toolInfo.inputSchema, null, 2)}\n`;
      }
      return fail(stderr);
    }
  }

  interface UpstreamCallOpts {
    instance: ProxyInstance;
    toolName: string;
    args: Record<string, unknown>;
    sessionId?: string;
    inputSchema?: unknown;
  }

  /**
   * Direct (non-approval) MCP tool invocation. Logs, writes the worklog, and
   * formats stderr with an input-schema hint so the calling agent can fix
   * malformed input. Approval execution goes through {@link ApprovalExecutor}
   * instead; the resolver owns those audit and wire-shape concerns.
   */
  async function executeDirectMcpCall(opts: UpstreamCallOpts): Promise<McpExecResult> {
    const { instance, toolName, args, inputSchema } = opts;
    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: toolName,
        arguments: args,
      });
      const duration = Date.now() - start;
      const stdout = unwrapResult(result);

      if (isMcpToolError(result)) {
        // MCP-spec error envelope; surface the same as an SDK throw so the
        // agent's stderr/exitCode signal is consistent regardless of how
        // the upstream signalled failure.
        logError(log, "tool_call", stdout, {
          upstream: instance.name,
          tool: toolName,
          durationMs: duration,
          ...getThorIds({ sessionId: opts.sessionId }),
        });
        writeToolCallLogFn({
          tool: toolName,
          decision: "allowed",
          args,
          durationMs: duration,
          error: stdout,
        });
        let stderr = `${stdout}\n`;
        if (inputSchema) {
          stderr += `\n[hint] Input schema for "${toolName}":\n${JSON.stringify(inputSchema, null, 2)}\n`;
        }
        return fail(stderr);
      }

      logInfo(log, "tool_call", {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...getThorIds({ sessionId: opts.sessionId }),
      });
      writeToolCallLogFn({
        tool: toolName,
        decision: "allowed",
        args,
        result: stdout,
        durationMs: duration,
      });

      if (toolName === "post_message" && opts.sessionId) {
        const correlationKey = computeSlackCorrelationKey(args, stdout);
        if (correlationKey) {
          try {
            appendCorrelationAlias(opts.sessionId, correlationKey);
            logInfo(log, "alias_registered", {
              sessionId: opts.sessionId,
              correlationKey,
              source: "mcp:post_message",
            });
          } catch (err) {
            logError(
              log,
              "alias_registration_error",
              err instanceof Error ? err.message : String(err),
              {
                sessionId: opts.sessionId,
                correlationKey,
              },
            );
          }
        }
      }
      return ok(stdout);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...getThorIds({ sessionId: opts.sessionId }),
      });
      writeToolCallLogFn({
        tool: toolName,
        decision: "allowed",
        args,
        durationMs: duration,
        error: message,
      });

      let stderr = `${message}\n`;
      if (inputSchema) {
        stderr += `\n[hint] Input schema for "${toolName}":\n${JSON.stringify(inputSchema, null, 2)}\n`;
      }
      return fail(stderr);
    }
  }

  async function callTool(
    upstreamName: string,
    toolInfo: ToolInfo,
    args: Record<string, unknown>,
    context: McpCommandContext,
  ): Promise<McpExecResult> {
    const instance = await getInstance(upstreamName);
    if (!instance) {
      return fail(`Unknown upstream "${upstreamName}".`);
    }

    if (toolInfo.classification === "approve") {
      const approvalRequired = ApprovalRequiredEventPayloadSchema.safeParse({
        type: "approval_required",
        actionId: "_pending",
        proxyName: instance.name,
        tool: toolInfo.name,
        args,
      });
      if (!approvalRequired.success) {
        return fail(
          `Invalid approval arguments for "${toolInfo.name}": ${approvalRequired.error.message}`,
        );
      }
      const approvalArgs = approvalRequired.data.args;
      const formatError = validateDisclaimerCompatibleArgs(toolInfo.name, approvalArgs);
      if (formatError) return fail(formatError);
      if (!context.sessionId) {
        return fail(`Approval required for "${toolInfo.name}": missing Thor session id`);
      }
      const anchorContext = findAnchorContext(context.sessionId);
      if (!anchorContext.ok) {
        return fail(
          `Approval required for "${toolInfo.name}": no Thor anchor for session ${context.sessionId} (${anchorContext.reason})`,
        );
      }
      const slackTarget = resolveSlackThreadTargetFromTrigger(context.sessionId);
      if ("error" in slackTarget) {
        return fail(`Approval required for "${toolInfo.name}": ${slackTarget.error}`);
      }
      const action = instance.approvalStore.buildPending(
        toolInfo.name,
        approvalArgs,
        {
          sessionId: context.sessionId,
          trigger: {
            anchorId: anchorContext.anchorId,
            ...(anchorContext.triggerId ? { triggerId: anchorContext.triggerId } : {}),
          },
        },
        {
          provider: "slack",
          channel: slackTarget.channel,
          threadTs: slackTarget.threadTs,
        },
      );
      const slackPost = await postSlackApprovalMessage({
        action,
        upstreamName: instance.name,
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
      });
      if ("error" in slackPost) {
        instance.approvalStore.rejectLoaded(action, "system", slackPost.error);
        return fail(`Approval required for "${toolInfo.name}": ${slackPost.error}`);
      }
      action.notification = {
        provider: "slack",
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
        messageTs: slackPost.ts,
        postedAt: new Date().toISOString(),
      };
      instance.approvalStore.update(action);
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolInfo.name,
        actionId: action.id,
        ...getThorIds(context),
      });
      writeToolCallLogFn({ tool: toolInfo.name, decision: "pending", args: approvalArgs });
      const approvalEvent: ApprovalRequiredEventPayload = {
        ...approvalRequired.data,
        actionId: action.id,
      };
      return ok(
        stringify({
          ...approvalEvent,
          command: `approval status ${action.id}`,
        }),
      );
    }

    return executeDirectMcpCall({
      instance,
      toolName: toolInfo.name,
      args,
      sessionId: context.sessionId,
      inputSchema: toolInfo.inputSchema,
    });
  }

  function findApproval(actionId: string): ApprovalLookup | undefined {
    for (const upstreamName of approvalStoreNames()) {
      const store = getApprovalStore(upstreamName);
      const action = store.get(actionId);
      if (action) {
        return { upstreamName, action, store };
      }
    }
    return undefined;
  }

  /**
   * Outcome shape returned by every approval executor. The resolver consumes
   * this to decide audit logging, store transitions, and the wire shape sent
   * back to the gateway — executors do not write the worklog or touch the
   * approval store themselves.
   */
  interface ApprovalExecutionOutcome {
    ok: boolean;
    stdout: string;
    stderr: string;
    /**
     * True iff the executor issued a side-effecting write that may have taken
     * effect (MCP request was sent; gh subprocess ran to non-zero exit).
     * False for short-circuits before the write (bad stored args, args build
     * failure).
     */
    sideEffectAttempted: boolean;
    /**
     * The args the executor actually sent to the upstream after disclaimer
     * injection / attribution. Logged to the worklog so audit trails reflect
     * what was sent, not the pre-attribution args from the approval store.
     * Falls back to the action's stored args when the executor didn't reach
     * the side-effect stage.
     */
    effectiveArgs?: Record<string, unknown>;
  }

  function isMcpToolError(result: unknown): boolean {
    return (
      typeof result === "object" &&
      result !== null &&
      (result as { isError?: unknown }).isError === true
    );
  }

  interface ApprovalExecutor {
    run(action: ApprovalAction): Promise<ApprovalExecutionOutcome>;
  }

  function createMcpApprovalExecutor(instance: ProxyInstance): ApprovalExecutor {
    return {
      async run(action: ApprovalAction): Promise<ApprovalExecutionOutcome> {
        let upstreamArgs: Record<string, unknown>;
        try {
          upstreamArgs = buildUpstreamArgs(action);
          if (action.tool === "createJiraIssue") {
            upstreamArgs = await withJiraAttribution(
              upstreamArgs,
              action.origin?.sessionId,
              instance,
            );
          }
        } catch (err) {
          return {
            ok: false,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            sideEffectAttempted: false,
          };
        }

        try {
          const result = await instance.upstream.client.callTool({
            name: action.tool,
            arguments: upstreamArgs,
          });
          const text = unwrapResult(result);
          if (isMcpToolError(result)) {
            // MCP-spec error envelope: the SDK call succeeded but the tool
            // reported a semantic failure. Treat as a side-effect-attempted
            // failure so the gateway routes it through the same "do not
            // replay" guidance as SDK throws.
            return {
              ok: false,
              stdout: "",
              stderr: text,
              sideEffectAttempted: true,
              effectiveArgs: upstreamArgs,
            };
          }
          return {
            ok: true,
            stdout: text,
            stderr: "",
            sideEffectAttempted: true,
            effectiveArgs: upstreamArgs,
          };
        } catch (err) {
          return {
            ok: false,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            sideEffectAttempted: true,
            effectiveArgs: upstreamArgs,
          };
        }
      },
    };
  }

  function createGhIssueCreateApprovalExecutor(): ApprovalExecutor {
    return {
      async run(action: ApprovalAction): Promise<ApprovalExecutionOutcome> {
        const parsed = GhIssueCreateApprovalArgsSchema.safeParse(action.args);
        if (!parsed.success) {
          return {
            ok: false,
            stdout: "",
            stderr: `Stored gh issue create approval action ${action.id} is invalid: ${parsed.error.message}`,
            sideEffectAttempted: false,
          };
        }
        const result = await execCommandFn("gh", parsed.data.args, parsed.data.cwd);
        if (result.exitCode !== 0) {
          return {
            ok: false,
            stdout: result.stdout,
            stderr: result.stderr || `gh exited with code ${result.exitCode}`,
            sideEffectAttempted: true,
          };
        }
        registerCreatedIssueCorrelationAlias(
          action.origin?.sessionId,
          parsed.data.cwd,
          result.stdout,
        );
        return {
          ok: true,
          stdout: result.stdout,
          stderr: "",
          sideEffectAttempted: true,
        };
      },
    };
  }

  function storedApprovedResult(action: ApprovalAction): McpExecResult {
    const parsed = ExecResultSchema.safeParse(action.result);
    if (!parsed.success) {
      return fail(
        `Stored approved result for approval action ${action.id} is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async function resolveApprovalAction(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<McpExecResult> {
    const inFlight = resolvingApprovals.get(actionId);
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

    const promise = resolveApprovalActionOnce(actionId, decision, reviewer, reason);
    resolvingApprovals.set(actionId, { decision, reviewer, reason, promise });
    try {
      return await promise;
    } finally {
      resolvingApprovals.delete(actionId);
    }
  }

  async function resolveApprovalActionOnce(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<McpExecResult> {
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

    let executor: ApprovalExecutor;
    if (lookup.upstreamName === GH_APPROVAL_STORE) {
      executor = createGhIssueCreateApprovalExecutor();
    } else {
      const instance = await getInstance(lookup.upstreamName);
      if (!instance) {
        return fail(`Unknown upstream "${lookup.upstreamName}".`);
      }
      executor = createMcpApprovalExecutor(instance);
    }

    const pendingAction = lookup.action;
    const start = Date.now();
    const outcome = await executor.run(pendingAction);
    const durationMs = Date.now() - start;

    const baseLogFields = {
      upstream: lookup.upstreamName,
      tool: pendingAction.tool,
      durationMs,
      actionId: pendingAction.id,
    };

    if (outcome.ok) {
      logInfo(log, "tool_call_approved", baseLogFields);
      writeToolCallLogFn({
        tool: pendingAction.tool,
        decision: "approved",
        args: outcome.effectiveArgs ?? pendingAction.args,
        durationMs,
        result: outcome.stdout,
      });
      const execResult: McpExecResult = {
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

  async function withJiraAttribution(
    args: Record<string, unknown>,
    sessionId: string | undefined,
    instance: ProxyInstance,
  ): Promise<Record<string, unknown>> {
    const resolved = resolveTriggerUser(sessionId, getConfig);
    if (args.assignee_account_id !== undefined) {
      logInfo(log, "attribution_applied", {
        surface: "jira",
        outcome: "skipped_existing_assignee",
        ...attributionFields(resolved.actor, resolved.user),
      });
      return args;
    }
    if (!("user" in resolved) || !resolved.user) {
      logInfo(log, "attribution_applied", {
        surface: "jira",
        outcome: resolved.reason ?? "skipped_no_user_record",
        ...attributionFields(resolved.actor),
      });
      return args;
    }
    const cloudId =
      typeof args.cloudId === "string" && args.cloudId.length > 0 ? args.cloudId : undefined;
    if (!cloudId) {
      logInfo(log, "attribution_applied", {
        surface: "jira",
        outcome: "api_rejected",
        reason: "lookup_missing_cloud_id",
        ...attributionFields(resolved.actor, resolved.user),
      });
      return args;
    }
    let lookup: JiraLookupResult;
    try {
      lookup = await lookupJiraAccountIdViaUpstream(instance, cloudId, resolved.user.email);
    } catch {
      logInfo(log, "attribution_applied", {
        surface: "jira",
        outcome: "api_rejected",
        reason: "lookup_error",
        ...attributionFields(resolved.actor, resolved.user),
      });
      return args;
    }
    if (!lookup.ok) {
      logInfo(log, "attribution_applied", {
        surface: "jira",
        outcome: "api_rejected",
        reason: lookup.reason,
        ...attributionFields(resolved.actor, resolved.user),
      });
      return args;
    }
    logInfo(log, "attribution_applied", {
      surface: "jira",
      outcome: "applied",
      ...attributionFields(resolved.actor, resolved.user),
    });
    return { ...args, assignee_account_id: lookup.accountId };
  }

  return {
    getHealth(): Record<string, unknown> {
      return {
        configured: PROXY_NAMES.length,
        connected: PROXY_NAMES.filter((name) => instances.has(name)).length,
        instances: Object.fromEntries(
          PROXY_NAMES.map((name) => [
            name,
            {
              connected: instances.has(name),
              tools: instances.get(name)?.upstream.tools.length ?? 0,
            },
          ]),
        ),
      };
    },

    async warmUpstreams(): Promise<void> {
      const results = await Promise.allSettled(PROXY_NAMES.map((name) => getInstance(name)));
      for (let index = 0; index < PROXY_NAMES.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          logError(log, "upstream_connect_failed", result.reason, { name: PROXY_NAMES[index] });
        }
      }
    },

    async closeAll(): Promise<void> {
      await Promise.allSettled(
        [...instances.values()].map((instance) => instance.upstream.client.close()),
      );
    },

    async executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult> {
      if (args[0] === "resolve") {
        if (args.length < 4) {
          return fail("Usage: mcp resolve <action-id> <approved|rejected> <reviewer> [reason]\n");
        }
        const decision = args[2];
        if (decision !== "approved" && decision !== "rejected") {
          return fail('decision must be "approved" or "rejected"\n');
        }
        const reviewer = args[3];
        const reason = args[4];
        return resolveApprovalAction(args[1], decision, reviewer, reason);
      }

      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        return listUpstreams(context.directory);
      }

      const failure = validateRepoDirectory(context.directory);
      if (failure) return failure;

      const upstreamName = args[0];
      if (!isProxyName(upstreamName)) {
        return fail(
          `Unknown upstream "${upstreamName}". ${suggestMatch(
            upstreamName,
            PROXY_NAMES.slice(),
          )}Available upstreams: ${PROXY_NAMES.join(", ")}\n`,
        );
      }

      const tools = await listVisibleTools(upstreamName);
      if (!Array.isArray(tools)) return tools;

      if (args.length === 1) {
        return ok(tools.map((tool) => tool.name).join("\n") + (tools.length > 0 ? "\n" : ""));
      }

      const resolvedTool = resolveTool(tools, args[1], upstreamName);
      if ("exitCode" in resolvedTool) return resolvedTool;

      if (args.length === 2 || (args.length === 3 && args[2] === "--help")) {
        return ok(stringify(resolvedTool));
      }

      const parsedArgs = parseJsonArgs(args[2], resolvedTool);
      if (isExecResult(parsedArgs)) return parsedArgs;

      return callTool(upstreamName, resolvedTool, parsedArgs, context);
    },

    async executeApproval(args: string[]): Promise<McpExecResult> {
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        return fail("Usage:\n  approval status <action-id>\n  approval list\n");
      }

      if (args[0] === "status") {
        if (!args[1]) {
          return fail("Usage: approval status <action-id>\n");
        }
        let lookup: ApprovalLookup | undefined;
        try {
          lookup = findApproval(args[1]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return fail(`Failed to load approval action ${args[1]}: ${message}`);
        }
        if (!lookup) {
          return fail(`No approval action found with ID: ${args[1]}\n`);
        }
        return ok(stringify(lookup.action));
      }

      if (args[0] === "list") {
        const approvals = approvalStoreNames().flatMap((upstreamName) =>
          getApprovalStore(upstreamName).listPending(),
        );
        return ok(stringify({ approvals }));
      }

      return fail(
        `Unknown subcommand: ${args[0]}\nUsage:\n  approval status <action-id>\n  approval list\n`,
      );
    },

    async requestGhIssueCreateApproval(input): Promise<McpExecResult> {
      if (!input.sessionId) {
        return fail('Approval required for "gh issue create": missing Thor session id');
      }
      const anchorContext = findAnchorContext(input.sessionId);
      if (!anchorContext.ok) {
        return fail(
          `Approval required for "gh issue create": no Thor anchor for session ${input.sessionId} (${anchorContext.reason})`,
        );
      }
      const slackTarget = resolveSlackThreadTargetFromTrigger(input.sessionId);
      if ("error" in slackTarget) {
        return fail(`Approval required for "gh issue create": ${slackTarget.error}`);
      }
      const store = getApprovalStore(GH_APPROVAL_STORE);
      const args = GhIssueCreateApprovalArgsSchema.parse({
        cwd: input.cwd,
        args: input.args,
        ...parseGhIssueDisplay(input.args),
      });
      const action = store.buildPending(
        "ghIssueCreate",
        args,
        {
          sessionId: input.sessionId,
          trigger: {
            anchorId: anchorContext.anchorId,
            ...(anchorContext.triggerId ? { triggerId: anchorContext.triggerId } : {}),
          },
        },
        { provider: "slack", channel: slackTarget.channel, threadTs: slackTarget.threadTs },
      );
      const slackPost = await postSlackApprovalMessage({
        action,
        upstreamName: GH_APPROVAL_STORE,
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
      });
      if ("error" in slackPost) {
        store.rejectLoaded(action, "system", slackPost.error);
        return fail(`Approval required for "gh issue create": ${slackPost.error}`);
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
        upstream: GH_APPROVAL_STORE,
        tool: action.tool,
        actionId: action.id,
        sessionId: input.sessionId,
        ...(input.callId ? { callId: input.callId } : {}),
      });
      writeToolCallLogFn({ tool: action.tool, decision: "pending", args });
      const approvalEvent: ApprovalRequiredEventPayload = {
        type: "approval_required",
        actionId: action.id,
        proxyName: GH_APPROVAL_STORE,
        tool: "ghIssueCreate",
        args,
      };
      return ok(stringify({ ...approvalEvent, command: `approval status ${action.id}` }));
    },
  };
}
