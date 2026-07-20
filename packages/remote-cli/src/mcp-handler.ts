import { z } from "zod";

import {
  appendCorrelationAlias,
  approvalToolRequiresDisclaimer,
  validateDisclaimerCompatibleArgs,
  buildThorDisclaimer,
  computeSlackCorrelationKey,
  createLogger,
  errorMessage,
  getAvailableProxyNames,
  injectApprovalDisclaimer,
  isProxyName,
  getRunnerBaseUrl,
  ApprovalRequiredEventPayloadSchema,
  logError,
  logInfo,
  logWarn,
  PROXY_NAMES,
  resolveAtlassianCloudId,
  resolveProxyConfig,
  resolveSessionAnchorId,
  resolveStrictProfileForSession,
  WORKSPACE_CONFIG_PATH,
  createConfigLoader,
  type ConfigLoader,
  type ProxyName,
  writeToolCallLog,
} from "@thor/common";
import type { ApprovalAction } from "./approval-store.ts";
import { classifyTool, PolicyDriftError, validatePolicy } from "./policy-mcp.ts";
import {
  ApprovalSystemRejection,
  fail,
  ok,
  stringify,
  type ApprovalExecResult,
  type ApprovalExecutor,
  type ApprovalOutcome,
  type ApprovalPlan,
  type ApprovalService,
} from "./approval-service.ts";
import { unwrapResult } from "./unwrap-result.ts";
import { connectUpstream, upstreamTarget, type UpstreamConnection } from "./upstream.ts";
import { attributionFields, resolveTriggerUser } from "./attribution.ts";

const log = createLogger("mcp");
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const PROFILE_DENIAL_MESSAGE = "Integration not available in this thread context";

class ProfileRoutingDenialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRoutingDenialError";
  }
}

function profileDenialMessage(err: unknown): string {
  return err instanceof ProfileRoutingDenialError ? PROFILE_DENIAL_MESSAGE : errorMessage(err);
}

function buildUpstreamArgs(action: ApprovalAction): Record<string, unknown> {
  if (!approvalToolRequiresDisclaimer(action.tool)) return action.args;
  const formatError = validateDisclaimerCompatibleArgs(action.tool, action.args);
  if (formatError) throw new Error(formatError);
  const trigger = action.origin?.trigger;
  if (!trigger) {
    throw new Error(
      `Approval action ${action.id} is missing origin.trigger for disclaimer injection`,
    );
  }
  const { footer } = buildThorDisclaimer(trigger, getRunnerBaseUrl());
  return injectApprovalDisclaimer(action.tool, action.args, footer);
}

function withoutCloudId(args: Record<string, unknown>): Record<string, unknown> {
  const { cloudId: _cloudId, ...rest } = args;
  return rest;
}

function sanitizeAtlassianInputSchema(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return inputSchema;
  }
  const schema = inputSchema as Record<string, unknown>;
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? withoutCloudId(schema.properties as Record<string, unknown>)
      : schema.properties;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field) => field !== "cloudId")
    : schema.required;
  return {
    ...schema,
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
  };
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
  targetKey: string;
  upstream: UpstreamConnection;
}

type McpExecResult = ApprovalExecResult;

interface McpCommandContext {
  sessionId?: string;
  callId?: string;
}

export interface McpServiceDeps {
  isProduction?: boolean;
  connectUpstreamFn?: typeof connectUpstream;
  writeToolCallLogFn?: typeof writeToolCallLog;
  configLoader?: ConfigLoader;
  // Approval-engine settings. createRemoteCliApp reads these from the same
  // `mcp` config blob to build the shared ApprovalService that the MCP service
  // and CLI approvals register into.
  approvalsDir?: string;
  fetchImpl?: typeof fetch;
  slack?: { botToken?: string; apiBaseUrl?: string };
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  classification?: string;
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

function requireBoundSessionId(input: {
  sessionId: string | undefined;
  missingMessage: string;
  invalidMessage: (sessionId: string) => string;
}): string {
  if (!input.sessionId) {
    throw new ProfileRoutingDenialError(input.missingMessage);
  }
  if (!resolveSessionAnchorId(input.sessionId)) {
    throw new ProfileRoutingDenialError(input.invalidMessage(input.sessionId));
  }
  return input.sessionId;
}

interface McpService {
  getHealth(): Record<string, unknown>;
  warmUpstreams(): Promise<void>;
  closeAll(): Promise<void>;
  executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult>;
}

/**
 * Builds the MCP command service and registers every MCP proxy store with the
 * shared approval engine (all proxies share one MCP executor that re-resolves
 * the upstream per action at click time).
 */
export function createMcpService(
  deps: McpServiceDeps,
  approvalService: ApprovalService,
): McpService {
  const connectUpstreamFn = deps.connectUpstreamFn ?? connectUpstream;
  const writeToolCallLogFn = deps.writeToolCallLogFn ?? writeToolCallLog;
  const getConfig = deps.configLoader ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const instances = new Map<string, ProxyInstance>();
  const connecting = new Map<string, Promise<ProxyInstance>>();
  // Set by closeAll() so a disconnect during shutdown does not respawn an
  // upstream (for stdio that would orphan a child process nothing will reap).
  let closing = false;

  function getThorIds(context: McpCommandContext): { sessionId?: string; callId?: string } {
    return {
      ...(context.sessionId && { sessionId: context.sessionId }),
      ...(context.callId && { callId: context.callId }),
    };
  }

  function resolveProfileForContext(context: McpCommandContext): { profile: string | undefined } {
    const sessionId = requireBoundSessionId({
      sessionId: context.sessionId,
      missingMessage:
        "missing Thor session id for MCP routing; use the mcp wrapper so x-thor-session-id is sent",
      invalidMessage: (sessionId) =>
        `invalid Thor session id for MCP routing; no Thor session binding for ${sessionId}`,
    });

    const config = getConfig();
    const resolved = resolveStrictProfileForSession(config, sessionId);
    if (!resolved.ok) throw new ProfileRoutingDenialError(resolved.error);
    return { profile: resolved.profile };
  }

  async function connectInstance(
    name: ProxyName,
    proxyDef: NonNullable<ReturnType<typeof resolveProxyConfig>>,
  ): Promise<ProxyInstance> {
    const upstreamConfig = proxyDef.upstream;

    function scheduleReconnect(attempt: number): void {
      if (closing) return;
      const instance = instances.get(proxyDef.target.key);
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
        instances.delete(proxyDef.target.key);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      logInfo(log, "upstream_reconnecting", { name, attempt, delayMs: delay });
      const reconnectTimer = setTimeout(() => {
        if (closing) return;
        connectUpstreamFn(name, upstreamConfig, () => scheduleReconnect(1))
          .then((newUpstream) => {
            instance.upstream = newUpstream;
            logInfo(log, "upstream_reconnected", { name, afterAttempt: attempt });
          })
          .catch((err) => {
            logWarn(log, "upstream_reconnect_failed", { name, attempt, error: errorMessage(err) });
            scheduleReconnect(attempt + 1);
          });
      }, delay);
      reconnectTimer.unref?.();
    }

    if (proxyDef.upstream.kind === "stdio" && proxyDef.upstream.command !== "bwrap") {
      logWarn(log, "mcp_sandbox_disabled", {
        name,
        targetKey: proxyDef.target.key,
        reason: "THOR_MCP_DISABLE_SANDBOX=1 — stdio MCP server runs unsandboxed",
      });
    }
    logInfo(log, "connecting_upstream", {
      name,
      targetKey: proxyDef.target.key,
      profile: proxyDef.target.profile,
      transport: proxyDef.upstream.kind,
      target: upstreamTarget(proxyDef.upstream),
    });
    const upstream = await connectUpstreamFn(name, upstreamConfig, () => scheduleReconnect(1));

    const allToolNames = upstream.tools.map((tool) => tool.name);
    async function closeUpstreamOnSetupFailure(err: unknown): Promise<never> {
      await upstream.client.close().catch((closeErr) => {
        logError(
          log,
          "upstream_close_failed",
          closeErr instanceof Error ? closeErr.message : String(closeErr),
          { name, targetKey: proxyDef.target.key },
        );
      });
      throw err;
    }

    try {
      validatePolicy(proxyDef.allow, proxyDef.approve ?? [], allToolNames);
    } catch (err) {
      const tolerated = err instanceof PolicyDriftError && deps.isProduction;
      if (tolerated) {
        logWarn(log, "policy_drift", { name, orphans: err.orphans });
      } else {
        await closeUpstreamOnSetupFailure(err);
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
      targetKey: proxyDef.target.key,
      upstream,
    };
  }

  async function getInstance(name: string, profile?: string): Promise<ProxyInstance | undefined> {
    if (!isProxyName(name)) return undefined;
    let proxyDef: ReturnType<typeof resolveProxyConfig>;
    try {
      proxyDef = resolveProxyConfig(name, profile);
    } catch (err) {
      logWarn(log, "proxy_resolution_failed", {
        name,
        profile,
        error: errorMessage(err),
      });
      throw err;
    }
    if (!proxyDef) {
      return undefined;
    }
    const instanceKey = proxyDef.target.key;

    const existing = instances.get(instanceKey);
    if (existing) return existing;

    const pending = connecting.get(instanceKey);
    if (pending) return pending;

    const promise = connectInstance(name, proxyDef);
    connecting.set(instanceKey, promise);
    try {
      const instance = await promise;
      instances.set(instanceKey, instance);
      return instance;
    } finally {
      connecting.delete(instanceKey);
    }
  }

  /**
   * Re-resolve the profile for an approval action at click time. Approval
   * actions are write-capable, so a missing or stale Thor session binding fails
   * closed instead of falling back to global credentials.
   */
  function resolveProfileForAction(action: ApprovalAction): { profile: string | undefined } {
    const sessionId = requireBoundSessionId({
      sessionId: action.origin?.sessionId,
      missingMessage: `approval action ${action.id} is missing Thor session id for approval routing`,
      invalidMessage: (sessionId) =>
        `invalid Thor session id for approval routing; no Thor session binding for ${sessionId}`,
    });

    const config = getConfig();
    const resolved = resolveStrictProfileForSession(config, sessionId);
    if (!resolved.ok) throw new ProfileRoutingDenialError(resolved.error);
    return { profile: resolved.profile };
  }

  async function lookupJiraAccountIdViaUpstream(
    instance: ProxyInstance,
    email: string,
    profile: string | undefined,
  ): Promise<JiraLookupResult> {
    if (!instance.upstream.tools.some((tool) => tool.name === JIRA_ACCOUNT_LOOKUP_TOOL)) {
      return { ok: false, reason: "tool_unavailable" };
    }
    const outcome = await callUpstreamWithLogging(
      instance,
      JIRA_ACCOUNT_LOOKUP_TOOL,
      { searchString: email },
      { logEvent: "jira_account_lookup", decision: "allowed", profile },
    );
    if (!outcome.ok) return { ok: false, reason: "upstream_disconnected" };
    return parseJiraAccountLookupStdout(outcome.text);
  }

  async function listVisibleTools(
    upstreamName: string,
    profile?: string,
  ): Promise<ToolInfo[] | McpExecResult> {
    if (!isProxyName(upstreamName)) {
      return fail(
        `Unknown upstream "${upstreamName}". Available upstreams: ${PROXY_NAMES.join(", ")}`,
      );
    }

    let instance: ProxyInstance | undefined;
    try {
      instance = await getInstance(upstreamName, profile);
    } catch (err) {
      return fail(errorMessage(err));
    }
    if (!instance) {
      return fail(`Upstream "${upstreamName}" is not configured for this thread/profile.`);
    }

    const proxyDef = resolveProxyConfig(upstreamName, profile);
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    return instance.upstream.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema:
          upstreamName === "atlassian"
            ? sanitizeAtlassianInputSchema(tool.inputSchema)
            : tool.inputSchema,
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

  async function listUpstreams(profile?: string): Promise<McpExecResult> {
    try {
      const upstreams = getAvailableProxyNames(profile);
      return ok(upstreams.join("\n") + (upstreams.length > 0 ? "\n" : ""));
    } catch (err) {
      return fail(errorMessage(err));
    }
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

  type UpstreamCallOutcome =
    | { ok: true; text: string; durationMs: number }
    | { ok: false; message: string; durationMs: number };

  function outboundArgs(
    instance: ProxyInstance,
    args: Record<string, unknown>,
    profile: string | undefined,
  ): Record<string, unknown> {
    if (instance.name !== "atlassian") return args;
    // Intentionally inject for every Atlassian call. The deterministic e2e
    // exercises atlassianUserInfo, whose schema has no cloudId, so a future
    // upstream rejection of extra cloudId fails there and we can revisit.
    const cloudId = resolveAtlassianCloudId(profile).value;
    if (!cloudId) {
      throw new Error("Atlassian cloud ID is not configured");
    }
    return { ...args, cloudId };
  }

  async function callUpstreamWithLogging(
    instance: ProxyInstance,
    toolName: string,
    args: Record<string, unknown>,
    opts: {
      logEvent: string;
      decision: "allowed" | "blocked" | "pending" | "approved" | "rejected";
      targetKey?: string;
      profile?: string;
      extraLogFields?: Record<string, unknown>;
      onSuccess?: (rawResult: unknown) => void;
      onError?: (message: string) => void;
    },
  ): Promise<UpstreamCallOutcome> {
    const {
      logEvent,
      decision,
      targetKey,
      profile,
      extraLogFields = {},
      onSuccess,
      onError,
    } = opts;
    const baseLog = {
      upstream: instance.name,
      tool: toolName,
      targetKey: targetKey ?? instance.targetKey,
      ...(profile !== undefined ? { profile } : {}),
      ...extraLogFields,
    };
    const start = Date.now();
    // Logged so the audit trail records the effective payload sent upstream
    // (including any server-side injected fields such as the Atlassian cloudId).
    let callArgs = args;
    try {
      callArgs = outboundArgs(instance, args, profile);
      const result = await instance.upstream.client.callTool({
        name: toolName,
        arguments: callArgs,
      });
      const durationMs = Date.now() - start;
      const text = unwrapResult(result);
      if (isMcpToolError(result)) {
        logError(log, logEvent, text, { ...baseLog, durationMs });
        writeToolCallLogFn({
          tool: toolName,
          decision,
          targetKey: targetKey ?? instance.targetKey,
          profile,
          args: callArgs,
          durationMs,
          error: text,
        });
        onError?.(text);
        return { ok: false, message: text, durationMs };
      }
      logInfo(log, logEvent, { ...baseLog, durationMs });
      writeToolCallLogFn({
        tool: toolName,
        decision,
        targetKey: targetKey ?? instance.targetKey,
        profile,
        args: callArgs,
        result: text,
        durationMs,
      });
      onSuccess?.(result);
      return { ok: true, text, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, logEvent, message, { ...baseLog, durationMs });
      writeToolCallLogFn({
        tool: toolName,
        decision,
        targetKey: targetKey ?? instance.targetKey,
        profile,
        args: callArgs,
        durationMs,
        error: message,
      });
      onError?.(message);
      return { ok: false, message, durationMs };
    }
  }

  interface UpstreamCallOpts {
    instance: ProxyInstance;
    toolName: string;
    args: Record<string, unknown>;
    profile?: string;
    sessionId?: string;
    inputSchema?: unknown;
  }

  async function executeDirectMcpCall(opts: UpstreamCallOpts): Promise<McpExecResult> {
    const { instance, toolName, args, sessionId, inputSchema } = opts;
    const outcome = await callUpstreamWithLogging(instance, toolName, args, {
      logEvent: "tool_call",
      decision: "allowed",
      profile: opts.profile,
      extraLogFields: getThorIds({ sessionId }),
    });
    if (!outcome.ok) {
      let stderr = `${outcome.message}\n`;
      if (inputSchema) {
        stderr += `\n[hint] Input schema for "${toolName}":\n${JSON.stringify(inputSchema, null, 2)}\n`;
      }
      return fail(stderr);
    }
    if (toolName === "post_message" && sessionId) {
      const correlationKey = computeSlackCorrelationKey(args, outcome.text);
      if (correlationKey) {
        try {
          appendCorrelationAlias(sessionId, correlationKey);
          logInfo(log, "alias_registered", {
            sessionId,
            correlationKey,
            source: "mcp:post_message",
          });
        } catch (err) {
          logError(
            log,
            "alias_registration_error",
            err instanceof Error ? err.message : String(err),
            { sessionId, correlationKey },
          );
        }
      }
    }
    return ok(outcome.text);
  }

  async function callTool(
    upstreamName: string,
    toolInfo: ToolInfo,
    args: Record<string, unknown>,
    context: McpCommandContext,
  ): Promise<McpExecResult> {
    let instance: ProxyInstance | undefined;
    let profile: string | undefined;
    try {
      ({ profile } = resolveProfileForContext(context));
      instance = await getInstance(upstreamName, profile);
    } catch (err) {
      return fail(profileDenialMessage(err));
    }
    if (!instance) {
      return fail(`Upstream "${upstreamName}" is not configured for this thread/profile.`);
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
      return approvalService.createPending({
        storeName: instance.name,
        tool: toolInfo.name,
        displayName: toolInfo.name,
        args: approvalArgs,
        sessionId: context.sessionId,
        ...(context.callId ? { callId: context.callId } : {}),
        targetKey: instance.targetKey,
        ...(profile !== undefined ? { profile } : {}),
      });
    }

    return executeDirectMcpCall({
      instance,
      toolName: toolInfo.name,
      args,
      profile,
      sessionId: context.sessionId,
      inputSchema: toolInfo.inputSchema,
    });
  }

  function isMcpToolError(result: unknown): boolean {
    return (
      typeof result === "object" &&
      result !== null &&
      (result as { isError?: unknown }).isError === true
    );
  }

  async function runMcpApproval(
    instance: ProxyInstance,
    action: ApprovalAction,
    profile: string | undefined,
  ): Promise<ApprovalOutcome> {
    let upstreamArgs: Record<string, unknown>;
    try {
      upstreamArgs = buildUpstreamArgs(action);
      if (action.tool === "createJiraIssue") {
        upstreamArgs = await withJiraAttribution(
          upstreamArgs,
          action.origin?.sessionId,
          instance,
          profile,
        );
      }
      upstreamArgs = outboundArgs(instance, upstreamArgs, profile);
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
  }

  /**
   * MCP executor: a write to a configured upstream. Re-resolves the Thor profile
   * and reconnects the upstream at click time so a stale session binding or a
   * down integration fails the approval closed instead of executing.
   */
  const mcpExecutor: ApprovalExecutor = {
    async resolve(action): Promise<ApprovalPlan> {
      let profile: string | undefined;
      try {
        profile = resolveProfileForAction(action).profile;
      } catch (err) {
        const outwardMessage = profileDenialMessage(err);
        throw new ApprovalSystemRejection(
          outwardMessage,
          `profile re-resolution failed at approval time: ${outwardMessage}`,
          { logEvent: "tool_call_rejected_profile_ambiguous", logToolCall: true },
        );
      }

      let instance: ProxyInstance | undefined;
      try {
        instance = await getInstance(action.upstream, profile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApprovalSystemRejection(
          message,
          `integration unavailable at approval time: ${message}`,
          { logToolCall: true },
        );
      }
      if (!instance) {
        const message = `Upstream "${action.upstream}" is not configured for the resolved profile.`;
        throw new ApprovalSystemRejection(message, message);
      }

      const resolvedInstance = instance;
      return {
        logContext: {
          ...(profile !== undefined ? { profile } : {}),
          targetKey: resolvedInstance.targetKey,
        },
        execute: () => runMcpApproval(resolvedInstance, action, profile),
      };
    },
  };

  for (const name of PROXY_NAMES) {
    approvalService.register(name, mcpExecutor);
  }

  async function withJiraAttribution(
    args: Record<string, unknown>,
    sessionId: string | undefined,
    instance: ProxyInstance,
    profile: string | undefined,
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
    let lookup: JiraLookupResult;
    try {
      lookup = await lookupJiraAccountIdViaUpstream(instance, resolved.user.email, profile);
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
      const configured = new Set(getAvailableProxyNames());
      try {
        const config = getConfig();
        for (const profileName of Object.keys(config.profiles ?? {})) {
          for (const name of getAvailableProxyNames(profileName)) configured.add(name);
        }
      } catch {
        // Best-effort only; health falls back to global-only visibility when config cannot be loaded.
      }
      return {
        configured: configured.size,
        connected: new Set([...instances.values()].map((instance) => instance.name)).size,
        connectedTargets: instances.size,
        instances: Object.fromEntries(
          PROXY_NAMES.map((name) => {
            const matching = [...instances.values()].filter((instance) => instance.name === name);
            return [
              name,
              {
                connected: matching.length > 0,
                tools: matching.reduce(
                  (max, instance) => Math.max(max, instance.upstream.tools.length),
                  0,
                ),
              },
            ];
          }),
        ),
      };
    },

    async warmUpstreams(): Promise<void> {
      const names = getAvailableProxyNames();
      const results = await Promise.allSettled(names.map((name) => getInstance(name)));
      for (let index = 0; index < names.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          logError(log, "upstream_connect_failed", result.reason, { name: names[index] });
        }
      }
    },

    async closeAll(): Promise<void> {
      closing = true;
      await Promise.allSettled(
        [...instances.values()].map((instance) => instance.upstream.client.close()),
      );
    },

    async executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult> {
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        try {
          const { profile } = resolveProfileForContext(context);
          return listUpstreams(profile);
        } catch (err) {
          return fail(profileDenialMessage(err));
        }
      }

      const upstreamName = args[0];
      if (!isProxyName(upstreamName)) {
        return fail(
          `Unknown upstream "${upstreamName}". ${suggestMatch(
            upstreamName,
            PROXY_NAMES.slice(),
          )}Available upstreams: ${PROXY_NAMES.join(", ")}\n`,
        );
      }

      let profile: string | undefined;
      try {
        profile = resolveProfileForContext(context).profile;
      } catch (err) {
        return fail(profileDenialMessage(err));
      }
      const tools = await listVisibleTools(upstreamName, profile);
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
  };
}
