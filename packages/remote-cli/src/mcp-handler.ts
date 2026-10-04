import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  McpCallInputSchema,
  buildApprovalSlackMessage,
  validateDisclaimerCompatibleArgs,
  buildThorDisclaimer,
  createLogger,
  ExecResultSchema,
  extractRepoFromCwd,
  findAnchorContext,
  findNativeMcpProjection,
  hasNativeMcpCallProjection,
  type McpNativeAuthority,
  type McpNativeOperation,
  type McpSearchInput,
  type McpCallInput,
  type McpBrokerFailure,
  type McpDiscoveryOutcome,
  type McpDescribeOutcome,
  BrowserOpenAuthenticatedRequestArgsSchema,
  FindLoginItemsArgsSchema,
  getProxyConfig,
  injectApprovalDisclaimer,
  getRunnerBaseUrl,
  ApprovalRequiredEventPayloadSchema,
  interpolateEnv,
  interpolateHeaders,
  logError,
  logInfo,
  logWarn,
  PROXY_NAMES as BUILTIN_PROXY_NAMES,
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
  buildMcpInventory,
  mcpPolicyFingerprint,
  MCP_DISCOVERY_MAX_BYTES,
  type McpInventoryTool,
} from "./mcp-tool-inventory.js";
import {
  mcpCallToExec,
  projectMcpCallResult,
  type McpServiceCallOutcome,
} from "./mcp-call-result.js";
import {
  connectUpstream,
  resolveOnePasswordBrowserUpstream,
  type UpstreamConfig,
  type UpstreamConnection,
} from "./upstream.js";
import { attributionFields, resolveTriggerUser } from "./attribution.js";
import { postSlackMessageApi } from "./slack-post-message.js";
import type { McpCatalogSnapshot } from "./mcp-catalog-files.js";
import { GenericMcpApprovals, type GenericMcpPreparedCall } from "./mcp-generic-approval.js";
import type { McpApprovalOwner } from "./mcp-approval-owner.js";
import type {
  GenericMcpApproval,
  McpApprovalClick,
  McpApprovalReader,
  McpApprovalProjection,
  McpApprovalResolution,
} from "@thor/common";

const log = createLogger("mcp");
const DEFAULT_APPROVALS_DIR = "/workspace/data/approvals";
const CREDENTIAL_BROWSER_APPROVAL_CONSUMED_RESULT = {
  stdout: "",
  stderr:
    "Credential-browser approval was consumed before dispatch; the outcome is unknown and must not be retried.\n",
  exitCode: 1,
} as const;
const LoginPlanApprovalResultSchema = z
  .object({
    login_plan_id: z.uuid(),
    item_id: z.string().regex(/^[a-z0-9]{26}$/),
    title: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    application_origin: z.string().url(),
    credential_origin: z.string().url(),
    callback_origin: z.string().url(),
  })
  .strict();

const builtinApprovalHandlers = new Set([
  "atlassian/createJiraIssue",
  "atlassian/addCommentToJiraIssue",
  "atlassian/editJiraIssue",
  "atlassian/transitionJiraIssue",
  "posthog/create-feature-flag",
  "onepassword-browser/browser_open_authenticated",
]);

function isBuiltinDisclaimerTool(server: string, tool: string): boolean {
  return (
    (server === "atlassian" && ["createJiraIssue", "addCommentToJiraIssue"].includes(tool)) ||
    (server === "posthog" && tool === "create-feature-flag")
  );
}

function buildUpstreamArgs(action: ApprovalAction): Record<string, unknown> {
  if (!isBuiltinDisclaimerTool(action.upstream, action.tool)) return action.args;
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
    logWarn(log, "jira_account_lookup_parse_failed", { reason: "invalid_json" });
    return { ok: false, reason: "lookup_parse_failed" };
  }
  const result = JiraAccountLookupResultSchema.safeParse(parsed);
  if (!result.success) {
    logWarn(log, "jira_account_lookup_parse_failed", { reason: "schema_mismatch" });
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
  readonly inventory: readonly McpInventoryTool[];
  readonly fingerprint: string;
  readonly revision: string;
}

export interface McpExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface McpCommandContext {
  directory?: string;
  sessionId?: string;
  callId?: string;
}

export interface CustomApprovalExecutorInput {
  readonly action: ApprovalAction;
  readonly reviewer: string;
  readonly reason?: string;
}

export interface CustomApprovalExecution {
  /** Secret-free resolution envelope safe for durable approval storage and gateway logs. */
  readonly result: McpExecResult;
  /** True once the private action payload was durably consumed before dispatch. */
  readonly consumed: boolean;
}

export type CustomApprovalExecutor = (
  input: CustomApprovalExecutorInput,
) => Promise<CustomApprovalExecution>;

export interface CustomApprovalStatusReaderInput {
  readonly action: ApprovalAction;
  readonly context: McpCommandContext;
  readonly mode: "status" | "result";
  readonly capability?: string;
}

export type CustomApprovalStatusReader = (
  input: CustomApprovalStatusReaderInput,
) => Promise<McpExecResult>;

export type CustomApprovalReviewerAuthorizer = (input: {
  readonly action: ApprovalAction;
  readonly reviewer: string;
}) => boolean;

export interface McpServiceDeps {
  /** Operator connection checks may inspect approve inventory but cannot prepare or dispatch calls. */
  mode?: "inventory-only";
  /** Immutable operator activation loaded before the production listener starts. */
  catalog?: McpCatalogSnapshot;
  /** Production holds this capability before listen; custom approve cannot activate without it. */
  genericApprovalOwner?: McpApprovalOwner;
  approvalsDir?: string;
  isProduction?: boolean;
  connectUpstreamFn?: typeof connectUpstream;
  writeToolCallLogFn?: typeof writeToolCallLog;
  configLoader?: ConfigLoader;
  fetchImpl?: typeof fetch;
  slack?: { botToken?: string; apiBaseUrl?: string };
  customApprovalExecutors?: Readonly<Record<string, CustomApprovalExecutor>>;
  customApprovalStatusReaders?: Readonly<Record<string, CustomApprovalStatusReader>>;
  customApprovalReviewerAuthorizers?: Readonly<Record<string, CustomApprovalReviewerAuthorizer>>;
}

/** Native access requires current host evidence; legacy CLI scope cannot upgrade itself. */
export type McpAccessContext =
  | { readonly kind: "native"; readonly authority: McpNativeAuthority }
  | { readonly kind: "cli"; readonly command: McpCommandContext };

function brokerFailure(status: McpBrokerFailure["status"], message: string): McpBrokerFailure {
  return { status, isError: true, message };
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

function safeCustomApprovalAction(action: ApprovalAction): Record<string, unknown> {
  return {
    id: action.id,
    upstream: action.upstream,
    status: action.status,
    tool: action.tool,
    args: action.args,
    createdAt: action.createdAt,
    ...(action.resolvedAt ? { resolvedAt: action.resolvedAt } : {}),
    ...(action.reviewer ? { reviewer: action.reviewer } : {}),
    ...(action.reason ? { reason: action.reason } : {}),
  };
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

/** One broker owns filtered MCP discovery, exact dispatch and existing built-in approval preparation. */
export interface McpService {
  /** Filtered observational discovery with complete schemas and revision-bound pagination. */
  searchTools(input: McpSearchInput, context: McpAccessContext): Promise<McpDiscoveryOutcome>;
  /** Exact lookup never selects a fuzzy or hidden name. */
  describeTool(
    server: string,
    name: string,
    context: McpAccessContext,
  ): Promise<McpDescribeOutcome>;
  /** Exact call revalidates policy, schema and native authority before any effect. No call retry. */
  callTool(input: McpCallInput, context: McpAccessContext): Promise<McpServiceCallOutcome>;
  /** Signed Slack gateway evidence, independently authenticated at the HTTP edge. */
  resolvePrivateApproval(click: McpApprovalClick): Promise<McpApprovalResolution>;
  /** Authenticated scoped projections never fall back to legacy raw records. */
  readPrivateApproval(id: string, reader: McpApprovalReader): McpApprovalProjection | undefined;
  /** Authenticated scope-filtered list, independent of active aliases. */
  listPrivateApprovals(reader: McpApprovalReader): McpApprovalProjection[];
  getHealth(): Record<string, unknown>;
  warmUpstreams(): Promise<void>;
  closeAll(): Promise<void>;
  executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult>;
  executeApproval(args: string[], context?: McpCommandContext): Promise<McpExecResult>;
}

/** Create the shared MCP owner; native context is checked independently of transport authentication. */
export function createMcpService(deps: McpServiceDeps): McpService {
  const proxyNames = deps.catalog ? Object.keys(deps.catalog.policies) : [...BUILTIN_PROXY_NAMES];
  const lookupProxy = (name: string) => getProxyConfig(name, deps.catalog?.policies);
  const hasActiveProxy = (name: string) => !!lookupProxy(name);
  const approvalsDir = deps.approvalsDir ?? DEFAULT_APPROVALS_DIR;
  const connectUpstreamFn = deps.connectUpstreamFn ?? connectUpstream;
  const writeToolCallLogFn = deps.writeToolCallLogFn ?? writeToolCallLog;
  const getConfig = deps.configLoader ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const fetchImpl = deps.fetchImpl;
  const slackConfig = deps.slack;
  const genericApprovals = deps.genericApprovalOwner
    ? new GenericMcpApprovals(deps.genericApprovalOwner, slackConfig ?? {}, fetchImpl)
    : undefined;
  for (const name of proxyNames) {
    if (
      BUILTIN_PROXY_NAMES.some((builtin) => builtin === name) &&
      lookupProxy(name)?.approve.some((tool) => !builtinApprovalHandlers.has(`${name}/${tool}`))
    )
      throw new Error("MCP builtin approval policy has no qualified handler");
    if (
      !BUILTIN_PROXY_NAMES.some((builtin) => builtin === name) &&
      lookupProxy(name)?.approve.length &&
      !genericApprovals &&
      deps.mode !== "inventory-only"
    )
      throw new Error("MCP custom approve requires private state ownership");
  }
  const instances = new Map<string, ProxyInstance>();
  const activatedInventories = new Map<string, string>();
  const connecting = new Map<string, Promise<ProxyInstance | undefined>>();
  const startupCancellation = new AbortController();
  const approvalStores = new Map<string, ApprovalStore>();
  let closed = false;
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

  function resolveUpstreamConfig(name: string, proxyDef: ProxyConfig): UpstreamConfig | undefined {
    const custom = deps.catalog?.customUpstream(name);
    if (custom) return custom;
    if (proxyDef.upstream.transport === "onepassword-browser") {
      return resolveOnePasswordBrowserUpstream();
    }
    if (proxyDef.upstream.transport === "kali-api") {
      return { kind: "kali-api", url: interpolateEnv(proxyDef.upstream.url) };
    }
    return {
      kind: "http",
      url: interpolateEnv(proxyDef.upstream.url),
      headers: interpolateHeaders(proxyDef.upstream.headers),
    };
  }

  async function connectInstance(
    name: string,
    proxyDef: ProxyConfig,
    upstreamConfig: UpstreamConfig,
  ): Promise<ProxyInstance | undefined> {
    let disconnected = false;
    let candidate: ProxyInstance | undefined;
    const onDisconnect = () => {
      disconnected = true;
      if (candidate && instances.get(name) === candidate) instances.delete(name);
    };
    let upstream: UpstreamConnection | undefined;
    try {
      upstream = await connectUpstreamFn(
        name,
        upstreamConfig,
        onDisconnect,
        startupCancellation.signal,
      );
      const revision = `${deps.genericApprovalOwner?.activationId ?? "legacy"}:${randomUUID()}`;
      const inventory = buildMcpInventory(name, proxyDef, upstream, revision);
      // A reconnect may re-establish transport, not silently adopt changed permitted schemas.
      const signature = createHash("sha256")
        .update(
          JSON.stringify(
            inventory.map((tool) => ({
              ...tool.descriptor,
              toolRef: undefined,
              outputSchema: tool.outputValidator?.schema,
            })),
          ),
        )
        .digest("hex");
      const activated = activatedInventories.get(name);
      if (deps.catalog && activated && activated !== signature)
        throw new Error("MCP activated inventory drift");
      if (closed || disconnected) {
        await upstream.client.close();
        return undefined;
      }
      if (deps.catalog) activatedInventories.set(name, signature);
      candidate = {
        name,
        upstream,
        inventory,
        revision,
        fingerprint: mcpPolicyFingerprint(proxyDef),
        approvalStore: getApprovalStore(name),
      };
      return candidate;
    } catch {
      await upstream?.client.close().catch(() => undefined);
      logWarn(log, "mcp_inventory_unavailable", {
        server: name,
        reason: "connection_or_inventory_unsupported",
      });
      return undefined;
    }
  }

  async function getInstance(name: string): Promise<ProxyInstance | undefined> {
    if (closed) return undefined;
    const proxyDef = lookupProxy(name);
    if (!proxyDef) return undefined;
    const existing = instances.get(name);
    if (existing?.fingerprint === mcpPolicyFingerprint(proxyDef)) return existing;
    if (existing) {
      instances.delete(name);
      await existing.upstream.client.close().catch(() => undefined);
    }
    const pending = connecting.get(name);
    if (pending) return pending;
    let upstreamConfig: UpstreamConfig | undefined;
    try {
      upstreamConfig = resolveUpstreamConfig(name, proxyDef);
    } catch {
      return undefined;
    }
    if (!upstreamConfig) return undefined;
    const promise = connectInstance(name, proxyDef, upstreamConfig);
    connecting.set(name, promise);
    try {
      const instance = await promise;
      if (instance && !closed) instances.set(name, instance);
      return closed ? undefined : instance;
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
    const result = await executeUpstreamCall({
      instance,
      toolName: JIRA_ACCOUNT_LOOKUP_TOOL,
      args: { cloudId, searchString: email },
      logEvent: "jira_account_lookup",
      decision: "allowed",
    });
    if (result.exitCode !== 0) {
      return { ok: false, reason: "upstream_disconnected" };
    }
    return parseJiraAccountLookupStdout(result.stdout);
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

  function commandContext(
    access: McpAccessContext,
    operation: McpNativeOperation,
  ): McpCommandContext | McpBrokerFailure {
    if (access.kind === "cli") {
      const invalid = validateRepoDirectory(access.command.directory);
      return invalid ? brokerFailure("denied", invalid.stderr) : access.command;
    }
    const claimed = access.authority;
    const projected = findNativeMcpProjection(claimed.sessionId);
    if (
      !projected ||
      (projected.nativeMcp.requester.source === "slack" && !projected.nativeMcp.teamId) ||
      projected.anchorId !== claimed.anchorId ||
      projected.triggerId !== claimed.triggerId ||
      projected.nativeMcp.requestId !== claimed.requestId ||
      projected.nativeMcp.directory !== claimed.directory ||
      projected.nativeMcp.repositoryDirectory !== claimed.repositoryDirectory ||
      projected.nativeMcp.teamId !== claimed.teamId ||
      projected.nativeMcp.sourceKey !== claimed.sourceKey ||
      JSON.stringify(projected.nativeMcp.requester) !== JSON.stringify(claimed.requester) ||
      !hasNativeMcpCallProjection(claimed, operation)
    )
      return brokerFailure(
        "denied",
        "MCP native authority denied: current admission does not match.",
      );
    return {
      directory: projected.nativeMcp.directory,
      sessionId: claimed.sessionId,
      callId: claimed.callId,
    };
  }

  async function describeTool(
    server: string,
    name: string,
    access: McpAccessContext,
  ): Promise<McpDescribeOutcome> {
    const context = commandContext(access, "mcp_search");
    if ("status" in context) return context;
    if (!hasActiveProxy(server))
      return brokerFailure("denied", "MCP tool unavailable or not permitted.");
    const instance = await getInstance(server);
    if (!instance)
      return brokerFailure("unavailable", "MCP server unavailable or inventory unsupported.");
    const tool = instance.inventory.find((entry) => entry.descriptor.name === name);
    const current = commandContext(access, "mcp_search");
    if ("status" in current) return current;
    return tool
      ? { status: "ok", value: tool.descriptor }
      : brokerFailure("denied", "MCP tool unavailable or not permitted.");
  }

  async function searchTools(
    input: McpSearchInput,
    access: McpAccessContext,
  ): Promise<McpDiscoveryOutcome> {
    const context = commandContext(access, "mcp_search");
    if ("status" in context) return context;
    if (input.server && !hasActiveProxy(input.server))
      return brokerFailure("denied", "MCP server unavailable or not permitted.");
    const names = input.server ? [input.server] : proxyNames;
    const selected = await Promise.all(names.map((name) => getInstance(name)));
    const current = commandContext(access, "mcp_search");
    if ("status" in current) return current;
    const servers = names.map((server, index) => ({
      server,
      available: !!selected[index],
      ...(selected[index] ? { visibleTools: selected[index].inventory.length } : {}),
    }));
    if (input.exactName) {
      if (!input.server) return brokerFailure("denied", "MCP exact lookup requires a server.");
      // Reuse this search's snapshot, including failure; exact lookup must not silently
      // reconnect and spend another inventory budget when the first attempt was unavailable.
      const instance = selected[0];
      if (!instance)
        return brokerFailure("unavailable", "MCP server unavailable or inventory unsupported.");
      const tool = instance.inventory.find((entry) => entry.descriptor.name === input.exactName);
      return tool
        ? { status: "ok", value: { servers, tools: [tool.descriptor] } }
        : brokerFailure("denied", "MCP tool unavailable or not permitted.");
    }
    const stamp = createHash("sha256")
      .update(
        JSON.stringify([
          input.server,
          input.query,
          input.limit,
          selected.map((instance) => instance?.revision),
        ]),
      )
      .digest("hex");
    let offset = 0;
    if (input.cursor) {
      const cursor = z
        .strictObject({ stamp: z.string(), offset: z.number().int().nonnegative() })
        .safeParse(
          (() => {
            try {
              return JSON.parse(Buffer.from(input.cursor, "base64url").toString());
            } catch {
              return undefined;
            }
          })(),
        );
      if (!cursor.success || cursor.data.stamp !== stamp)
        return brokerFailure("stale", "MCP discovery changed; search again without a cursor.");
      offset = cursor.data.offset;
    }
    if (!input.query && !input.server) return { status: "ok", value: { servers, tools: [] } };
    const query = input.query.toLowerCase();
    const matches = selected
      .flatMap((instance) => instance?.inventory.map((entry) => entry.descriptor) ?? [])
      .filter(
        (tool) =>
          !query ||
          tool.name.toLowerCase().includes(query) ||
          tool.description?.toLowerCase().includes(query),
      )
      .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
    if (offset > matches.length)
      return brokerFailure("stale", "MCP discovery cursor invalid; search again.");
    const tools: typeof matches = [];
    let bytes = 0;
    for (const tool of matches.slice(offset, offset + input.limit)) {
      const size = Buffer.byteLength(JSON.stringify(tool));
      if (bytes + size > MCP_DISCOVERY_MAX_BYTES) break;
      tools.push(tool);
      bytes += size;
    }
    const next = offset + tools.length;
    return {
      status: "ok",
      value: {
        servers,
        tools,
        ...(next < matches.length
          ? { cursor: Buffer.from(JSON.stringify({ stamp, offset: next })).toString("base64url") }
          : {}),
      },
    };
  }

  function isCurrentMcpInstance(instance: ProxyInstance): boolean {
    const config = lookupProxy(instance.name);
    return (
      instances.get(instance.name) === instance &&
      !!config &&
      instance.fingerprint === mcpPolicyFingerprint(config)
    );
  }

  async function callExactTool(
    input: McpCallInput,
    access: McpAccessContext,
  ): Promise<McpServiceCallOutcome> {
    let context = commandContext(access, "mcp_call");
    if (deps.mode === "inventory-only")
      return brokerFailure("denied", "MCP inventory-only owner cannot execute tools.");
    if ("status" in context) return context;
    const server = input.toolRef.split(".")[0];
    if (!hasActiveProxy(server))
      return brokerFailure(
        "stale",
        "MCP tool reference stale or unavailable; rediscover before calling.",
      );
    const instance = await getInstance(server);
    if (!instance)
      return brokerFailure("unavailable", "MCP server unavailable or inventory unsupported.");
    const tool = instance.inventory.find((entry) => entry.descriptor.toolRef === input.toolRef);
    if (!tool)
      return brokerFailure(
        "stale",
        "MCP tool reference stale or unavailable; rediscover before calling.",
      );
    if (!tool.validator.validate(input.arguments))
      return {
        ...brokerFailure("invalid_arguments", `Invalid arguments for "${tool.descriptor.name}"`),
        issues: tool.validator.validate.errors?.map((issue) => ({
          path: issue.instancePath,
          keyword: issue.keyword,
        })),
      };
    // Connection/policy and authority are checked after observational work, immediately before preparation/dispatch.
    context = commandContext(access, "mcp_call");
    if ("status" in context) return context;
    if (!isCurrentMcpInstance(instance))
      return brokerFailure("stale", "MCP tool reference changed before dispatch; rediscover.");
    return callVisibleTool(instance, tool, input.arguments, context, access);
  }

  interface UpstreamCallOpts {
    instance: ProxyInstance;
    toolName: string;
    args: Record<string, unknown>;
    logEvent: string;
    decision: "allowed" | "blocked" | "pending" | "approved" | "rejected";
    extraLogFields?: Record<string, unknown>;
    sessionId?: string;
    onSuccess?: (rawResult: unknown) => void;
    onError?: (message: string) => void;
  }

  function outboundArgs(
    instance: ProxyInstance,
    args: Record<string, unknown>,
    sessionId: string | undefined,
  ): Record<string, unknown> {
    if (instance.name !== "onepassword-browser") return args;
    if (!sessionId) throw new Error("Missing Neo session id for 1Password browser request");
    if (args.item_title !== undefined) {
      const {
        item_title: approvedItemTitle,
        application_origin: _applicationOrigin,
        credential_origin: _credentialOrigin,
        callback_origin: _callbackOrigin,
        ...publicArgs
      } = args;
      return {
        ...publicArgs,
        _approved_item_title: approvedItemTitle,
        _thor_session_id: sessionId,
      };
    }
    return { ...args, _thor_session_id: sessionId };
  }

  async function dispatchUpstreamCall(opts: UpstreamCallOpts): Promise<McpServiceCallOutcome> {
    const { instance, toolName, args, logEvent, decision, extraLogFields } = opts;
    const start = Date.now();
    let callArgs: Record<string, unknown>;
    try {
      callArgs = outboundArgs(instance, args, opts.sessionId);
    } catch {
      return brokerFailure("denied", "MCP call denied: required broker context is missing.");
    }
    let raw: unknown;
    try {
      // This is the dispatch boundary. Any exception from the transport or SDK after entry is uncertain.
      raw = await instance.upstream.client.callTool({ name: toolName, arguments: callArgs });
    } catch {
      const message =
        "MCP transport failed after dispatch; the outcome is uncertain. Do not retry automatically.";
      logWarn(log, "mcp_call_uncertain", {
        upstream: instance.name,
        tool: toolName,
        ...extraLogFields,
      });
      opts.onError?.(message);
      writeToolCallLogFn({
        tool: toolName,
        decision,
        durationMs: Date.now() - start,
        error: message,
      });
      return brokerFailure("uncertain", message);
    }
    const outputValidator = instance.inventory.find(
      (tool) => tool.descriptor.name === toolName,
    )?.outputValidator;
    const projected = projectMcpCallResult(raw, outputValidator);
    logInfo(log, logEvent, {
      upstream: instance.name,
      tool: toolName,
      durationMs: Date.now() - start,
      ...extraLogFields,
    });
    // Ordinary audit records contain no argument, result or vendor-error copies.
    writeToolCallLogFn({ tool: toolName, decision, durationMs: Date.now() - start });
    opts.onSuccess?.(raw);
    return projected;
  }

  async function executeUpstreamCall(opts: UpstreamCallOpts): Promise<McpExecResult> {
    return mcpCallToExec(await dispatchUpstreamCall(opts));
  }

  async function prepareBrowserOpenApprovalArgs(
    instance: ProxyInstance,
    args: Record<string, unknown>,
    context: McpCommandContext,
  ): Promise<Record<string, unknown> | McpExecResult> {
    const request = BrowserOpenAuthenticatedRequestArgsSchema.safeParse(args);
    if (!request.success) {
      return fail('Invalid arguments for "browser_open_authenticated"');
    }
    if (!context.sessionId) {
      return fail('Approval required for "browser_open_authenticated": missing Neo session id');
    }

    const resolved = await executeUpstreamCall({
      instance,
      toolName: "_resolve_login_plan",
      args: {
        login_plan_id: request.data.login_plan_id,
        item_id: request.data.item_id,
      },
      logEvent: "credential_browser_approval_preflight",
      decision: "allowed",
      sessionId: context.sessionId,
      extraLogFields: getThorIds(context),
    });
    if (resolved.exitCode !== 0) {
      return fail("Cannot prepare authenticated browser approval: login plan validation failed");
    }

    let rawResolved: unknown;
    try {
      rawResolved = JSON.parse(resolved.stdout);
    } catch {
      return fail("Cannot prepare authenticated browser approval: invalid login plan response");
    }
    const parsedResolved = LoginPlanApprovalResultSchema.safeParse(rawResolved);
    if (!parsedResolved.success) {
      return fail("Cannot prepare authenticated browser approval: invalid login plan response");
    }
    if (
      parsedResolved.data.login_plan_id !== request.data.login_plan_id ||
      parsedResolved.data.item_id !== request.data.item_id ||
      parsedResolved.data.callback_origin !== parsedResolved.data.application_origin
    ) {
      return fail("Cannot prepare authenticated browser approval: login plan binding mismatch");
    }

    return {
      ...request.data,
      item_title: parsedResolved.data.title,
      application_origin: parsedResolved.data.application_origin,
      credential_origin: parsedResolved.data.credential_origin,
      callback_origin: parsedResolved.data.callback_origin,
    };
  }

  function genericPreparedCall(
    instance: ProxyInstance,
    tool: McpInventoryTool,
    args: GenericMcpApproval["arguments"],
  ): GenericMcpPreparedCall {
    return {
      server: instance.name,
      tool: tool.descriptor.name,
      toolRef: tool.descriptor.toolRef,
      connectionRevision: instance.revision,
      catalogFingerprint: instance.fingerprint,
      arguments: args,
      isCurrent: () => isCurrentMcpInstance(instance),
      dispatch: () =>
        dispatchUpstreamCall({
          instance,
          toolName: tool.descriptor.name,
          args,
          logEvent: "generic_mcp_approved",
          decision: "approved",
        }),
    };
  }

  function genericRevisionCurrent(action: GenericMcpApproval): boolean {
    const instance = instances.get(action.server);
    return (
      !!instance &&
      isCurrentMcpInstance(instance) &&
      instance.revision === action.connectionRevision &&
      instance.fingerprint === action.catalogFingerprint &&
      instance.inventory.some(
        (tool) =>
          tool.descriptor.toolRef === action.toolRef && tool.descriptor.policy === "approve",
      )
    );
  }

  async function prepareStoredGeneric(
    action: GenericMcpApproval,
  ): Promise<GenericMcpPreparedCall | undefined> {
    const instance = await getInstance(action.server);
    if (
      !instance ||
      instance.revision !== action.connectionRevision ||
      instance.fingerprint !== action.catalogFingerprint
    )
      return undefined;
    const tool = instance.inventory.find(
      (tool) =>
        tool.descriptor.toolRef === action.toolRef &&
        tool.descriptor.name === action.tool &&
        tool.descriptor.policy === "approve",
    );
    if (
      !tool ||
      !tool.validator.validate(action.arguments) ||
      !tool.validator.validate(action.effectiveArguments)
    )
      return undefined;
    return genericPreparedCall(instance, tool, action.effectiveArguments);
  }

  async function callVisibleTool(
    instance: ProxyInstance,
    tool: McpInventoryTool,
    args: Record<string, unknown>,
    context: McpCommandContext,
    access: McpAccessContext,
  ): Promise<McpServiceCallOutcome> {
    const toolInfo = tool.descriptor;
    if (toolInfo.policy === "approve" && deps.catalog?.customUpstream(instance.name)) {
      if (!genericApprovals || access.kind !== "native")
        return brokerFailure(
          "denied",
          "MCP generic approval requires authenticated host Slack context, not CLI attribution.",
        );
      const parsed = McpCallInputSchema.safeParse({ toolRef: toolInfo.toolRef, arguments: args });
      if (!parsed.success)
        return brokerFailure("invalid_arguments", "MCP generic business arguments invalid.");
      return genericApprovals.prepare(
        genericPreparedCall(instance, tool, parsed.data.arguments),
        access.authority,
        () => !("status" in commandContext(access, "mcp_call")),
      );
    }

    if (instance.name === "onepassword-browser" && toolInfo.name === "find_login_items") {
      const findArgs = FindLoginItemsArgsSchema.safeParse(args);
      if (!findArgs.success) {
        return brokerFailure("invalid_arguments", 'Invalid arguments for "find_login_items"');
      }
      args = findArgs.data;
    }
    if (instance.name === "onepassword-browser" && toolInfo.name === "browser_open_authenticated") {
      const prepared = await prepareBrowserOpenApprovalArgs(instance, args, context);
      if (isExecResult(prepared)) return brokerFailure("denied", prepared.stderr);
      args = prepared;
    }
    if (toolInfo.policy === "approve") {
      const approvalRequired = ApprovalRequiredEventPayloadSchema.safeParse({
        type: "approval_required",
        actionId: "_pending",
        proxyName: instance.name,
        tool: toolInfo.name,
        args,
      });
      if (!approvalRequired.success) {
        return {
          ...brokerFailure(
            "invalid_arguments",
            `Invalid approval arguments for "${toolInfo.name}": ${approvalRequired.error.issues.map((issue) => issue.path.join("/")).join(", ")}`,
          ),
          issues: approvalRequired.error.issues.map((issue) => ({
            path: issue.path.join("/"),
            keyword: issue.code,
          })),
        };
      }
      const approvalArgs = approvalRequired.data.args;
      const formatError = isBuiltinDisclaimerTool(instance.name, toolInfo.name)
        ? validateDisclaimerCompatibleArgs(toolInfo.name, approvalArgs)
        : undefined;
      if (formatError) return brokerFailure("invalid_arguments", formatError);
      if (!context.sessionId) {
        return brokerFailure(
          "denied",
          `Approval required for "${toolInfo.name}": missing Neo session id`,
        );
      }
      const anchorContext = findAnchorContext(context.sessionId);
      if (!anchorContext.ok) {
        return brokerFailure(
          "denied",
          `Approval required for "${toolInfo.name}": no Neo anchor for session ${context.sessionId} (${anchorContext.reason})`,
        );
      }
      const slackTarget = resolveSlackThreadTargetFromTrigger(context.sessionId);
      if ("error" in slackTarget) {
        return brokerFailure(
          "denied",
          `Approval required for "${toolInfo.name}": ${slackTarget.error}`,
        );
      }
      const current = commandContext(access, "mcp_call");
      if ("status" in current) return current;
      if (!isCurrentMcpInstance(instance))
        return brokerFailure("stale", "MCP tool reference changed before approval; rediscover.");
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
        return brokerFailure(
          "unavailable",
          `Approval required for "${toolInfo.name}": notification failed`,
        );
      }
      action.notification = {
        provider: "slack",
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
        messageTs: slackPost.ts,
        postedAt: new Date().toISOString(),
      };
      try {
        instance.approvalStore.update(action);
      } catch {
        return brokerFailure(
          "uncertain",
          "MCP approval was published but its record could not be saved. Do not retry automatically.",
        );
      }
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolInfo.name,
        actionId: action.id,
        ...getThorIds(context),
      });
      writeToolCallLogFn({ tool: toolInfo.name, decision: "pending" });
      const approvalEvent: ApprovalRequiredEventPayload = {
        ...approvalRequired.data,
        actionId: action.id,
      };
      return {
        status: "pending_approval",
        isError: false,
        actionId: action.id,
        server: instance.name,
        tool: toolInfo.name,
        approvalEvent,
      };
    }

    const current = commandContext(access, "mcp_call");
    if ("status" in current) return current;
    if (!isCurrentMcpInstance(instance))
      return brokerFailure("stale", "MCP tool reference changed before dispatch; rediscover.");
    return dispatchUpstreamCall({
      instance,
      toolName: toolInfo.name,
      args,
      logEvent: "tool_call",
      decision: "allowed",
      extraLogFields: getThorIds(context),
      sessionId: context.sessionId,
    });
  }

  function findApproval(actionId: string): ApprovalLookup | undefined {
    const approvalNames = new Set([
      // Catalog additions use private generic records, never shared legacy approval records.
      // Disabled built-ins retain historical status lookup, without regaining execution.
      ...BUILTIN_PROXY_NAMES,
      ...Object.keys(deps.customApprovalExecutors ?? {}),
      ...Object.keys(deps.customApprovalStatusReaders ?? {}),
      ...Object.keys(deps.customApprovalReviewerAuthorizers ?? {}),
    ]);
    for (const upstreamName of approvalNames) {
      const store = getApprovalStore(upstreamName);
      const action = store.get(actionId);
      if (action) {
        return { upstreamName, action, store };
      }
    }
    return undefined;
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
    const reviewerAuthorizer = deps.customApprovalReviewerAuthorizers?.[lookup.upstreamName];
    if (reviewerAuthorizer && !reviewerAuthorizer({ action: lookup.action, reviewer })) {
      return fail(`Approval action ${actionId} is not owned by this reviewer`);
    }

    if (lookup.action.status !== "pending") {
      if (lookup.action.status !== decision) {
        return fail(
          `Approval action ${actionId} is already ${lookup.action.status}; cannot resolve as ${decision}`,
        );
      }
      if (lookup.action.status === "approved") {
        if (
          deps.customApprovalExecutors?.[lookup.upstreamName] &&
          lookup.action.reviewer !== reviewer
        ) {
          return fail(`Approval action ${actionId} was approved by a different reviewer`);
        }
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
      writeToolCallLogFn({ tool: rejected.tool, decision: "rejected" });
      return ok(stringify(rejected));
    }

    const pendingAction = lookup.action;
    if (deps.mode === "inventory-only")
      return fail("MCP inventory-only owner cannot resolve approvals.");
    const customExecutor = deps.customApprovalExecutors?.[lookup.upstreamName];
    if (customExecutor) {
      const execution = await customExecutor({ action: pendingAction, reviewer, reason });
      if (execution.consumed) {
        try {
          lookup.store.approveLoaded(pendingAction, execution.result, reviewer, reason);
        } catch {
          return fail("Approval was consumed but its durable status could not be updated");
        }
        logInfo(log, "tool_call_approved", {
          upstream: lookup.upstreamName,
          tool: pendingAction.tool,
          actionId: pendingAction.id,
          reviewer,
          sessionId: pendingAction.origin?.sessionId,
          exitCode: execution.result.exitCode,
        });
        writeToolCallLogFn({
          tool: pendingAction.tool,
          decision: "approved",
          args: pendingAction.args,
        });
      }
      return execution.result;
    }

    const instance = await getInstance(lookup.upstreamName);
    if (!instance) {
      return fail(`Unknown upstream "${lookup.upstreamName}".`);
    }

    // Historical proof is not manufactured: only the unchanged qualified typed handler and
    // currently approved inventory can resolve a legacy pending record.
    if (
      !builtinApprovalHandlers.has(`${instance.name}/${pendingAction.tool}`) ||
      !instance.inventory.some(
        (tool) =>
          tool.descriptor.name === pendingAction.tool && tool.descriptor.policy === "approve",
      ) ||
      !ApprovalRequiredEventPayloadSchema.safeParse({
        type: "approval_required",
        actionId: pendingAction.id,
        proxyName: instance.name,
        tool: pendingAction.tool,
        args: pendingAction.args,
      }).success
    )
      return fail(
        "Legacy MCP approval no longer has a valid qualified handler; request fresh review.",
      );

    let upstreamArgs: Record<string, unknown>;
    try {
      upstreamArgs = buildUpstreamArgs(pendingAction);
      if (instance.name === "atlassian" && pendingAction.tool === "createJiraIssue") {
        upstreamArgs = await withJiraAttribution(
          upstreamArgs,
          pendingAction.origin?.sessionId,
          instance,
        );
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (
      instance.name === "onepassword-browser" &&
      pendingAction.tool === "browser_open_authenticated"
    ) {
      try {
        lookup.store.approveLoaded(
          pendingAction,
          CREDENTIAL_BROWSER_APPROVAL_CONSUMED_RESULT,
          reviewer,
          reason,
        );
      } catch {
        return fail("Failed to persist single-use credential-browser approval");
      }
    }
    const outcome = await dispatchUpstreamCall({
      instance,
      toolName: pendingAction.tool,
      args: upstreamArgs,
      logEvent: "tool_call_approved",
      decision: "approved",
      sessionId: pendingAction.origin?.sessionId,
      extraLogFields: { actionId: pendingAction.id },
      onError: (message) => {
        pendingAction.error = message;
        lookup.store.update(pendingAction);
      },
    });
    const result = mcpCallToExec(outcome);
    // Browser consumption fences redispatch, not confirmed error persistence. A completed
    // isError result replaces the unknown placeholder just like a confirmed success does.
    if (pendingAction.status === "approved" && outcome.status !== "completed") return result;
    // A returned dispatched error/uncertainty is a consumed approval, not another pending
    // opportunity to execute. Generic pre-dispatch crash fencing remains a separate owner.
    if (outcome.status === "completed" || outcome.status === "uncertain") {
      try {
        lookup.store.approveLoaded(pendingAction, result, reviewer, reason);
      } catch {
        return fail(
          "MCP approved dispatch outcome could not be saved. Do not retry automatically.",
        );
      }
    }
    return result;
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
    searchTools,
    describeTool,
    callTool: callExactTool,
    async resolvePrivateApproval(click): Promise<McpApprovalResolution> {
      try {
        if (genericApprovals?.contains(click.actionId))
          return genericApprovals.resolve(click, prepareStoredGeneric);
        return {
          status: "denied",
          message: "MCP generic approval not found; legacy resolution is a separate operation.",
        };
      } catch {
        return { status: "denied", message: "MCP approval record invalid or unavailable." };
      }
    },
    readPrivateApproval: (id, reader) => genericApprovals?.read(id, reader, genericRevisionCurrent),
    listPrivateApprovals: (reader) => genericApprovals?.list(reader, genericRevisionCurrent) ?? [],
    getHealth(): Record<string, unknown> {
      return {
        configured: proxyNames.length,
        connected: proxyNames.filter((name) => instances.has(name)).length,
        instances: Object.fromEntries(
          proxyNames.map((name) => [
            name,
            {
              connected: instances.has(name),
              tools: instances.get(name)?.inventory.length ?? 0,
            },
          ]),
        ),
      };
    },

    async warmUpstreams(): Promise<void> {
      const results = await Promise.allSettled(proxyNames.map((name) => getInstance(name)));
      for (let index = 0; index < proxyNames.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          logWarn(log, "upstream_connect_failed", {
            name: proxyNames[index],
            reason: "unavailable",
          });
        }
      }
    },

    async closeAll(): Promise<void> {
      closed = true;
      startupCancellation.abort();
      await genericApprovals?.close();
      await Promise.allSettled([...connecting.values()]);
      await Promise.allSettled(
        [...instances.values()].map((instance) => instance.upstream.client.close()),
      );
      instances.clear();
      deps.genericApprovalOwner?.release();
    },

    async executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult> {
      if (args[0] === "resolve") {
        try {
          if (genericApprovals?.contains(args[1]))
            return fail(
              "MCP generic approval requires authenticated signed Slack gateway evidence.",
            );
        } catch {
          return fail("MCP generic approval record unavailable.");
        }
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
        const invalid = validateRepoDirectory(context.directory);
        if (invalid) return invalid;
        return ok(
          stringify({
            upstreams: proxyNames.map((name) => ({
              name,
              toolCount: instances.get(name)?.inventory.length ?? 0,
              connected: instances.has(name),
            })),
          }),
        );
      }

      const failure = validateRepoDirectory(context.directory);
      if (failure) return failure;

      const upstreamName = args[0];
      if (!hasActiveProxy(upstreamName)) {
        return fail(
          `Unknown upstream "${upstreamName}". ${suggestMatch(
            upstreamName,
            proxyNames.slice(),
          )}Available upstreams: ${proxyNames.join(", ")}\n`,
        );
      }

      const instance = await getInstance(upstreamName);
      if (!instance) return fail(`Unknown upstream "${upstreamName}" or inventory unsupported.`);
      const tools = instance.inventory;

      if (args.length === 1) {
        return ok(
          tools.map((tool) => tool.descriptor.name).join("\n") + (tools.length > 0 ? "\n" : ""),
        );
      }

      const resolvedTool = tools.find((tool) => tool.descriptor.name === args[1]);
      if (!resolvedTool)
        return fail(
          `Unknown tool "${args[1]}" on upstream "${upstreamName}". ${suggestMatch(
            args[1],
            tools.map((tool) => tool.descriptor.name),
          )}Available tools: ${tools.map((tool) => tool.descriptor.name).join(", ")}`,
        );

      if (args.length === 2 || (args.length === 3 && args[2] === "--help")) {
        const { name, description, inputSchema, policy } = resolvedTool.descriptor;
        return ok(stringify({ name, description, inputSchema, classification: policy }));
      }

      let raw: unknown;
      try {
        raw = JSON.parse(args[2]);
      } catch {
        return fail(
          `Invalid JSON argument for "${resolvedTool.descriptor.name}"\n\n[hint] Input schema:\n${JSON.stringify(resolvedTool.descriptor.inputSchema, null, 2)}\n`,
        );
      }
      const input = McpCallInputSchema.safeParse({
        toolRef: resolvedTool.descriptor.toolRef,
        arguments: raw,
      });
      if (!input.success)
        return fail(
          `Invalid arguments for "${resolvedTool.descriptor.name}": expected a JSON object`,
        );
      return mcpCallToExec(await callExactTool(input.data, { kind: "cli", command: context }));
    },

    async executeApproval(args: string[], context: McpCommandContext = {}): Promise<McpExecResult> {
      if ((args[0] === "status" || args[0] === "result") && args[1]) {
        try {
          if (genericApprovals?.contains(args[1]))
            return fail(
              "MCP generic approval read denied: CLI attribution is not reader authority.",
            );
        } catch {
          return fail("MCP generic approval read denied.");
        }
      }
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        return fail(
          "Usage:\n  approval status <action-id>\n  approval result <action-id> <capability>\n  approval list\n",
        );
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
        const customStatusReader = deps.customApprovalStatusReaders?.[lookup.upstreamName];
        if (customStatusReader) {
          return customStatusReader({ action: lookup.action, context, mode: "status" });
        }
        return ok(stringify(lookup.action));
      }

      if (args[0] === "result") {
        if (!args[1] || !args[2]) {
          return fail("Usage: approval result <action-id> <capability>\n");
        }
        let lookup: ApprovalLookup | undefined;
        try {
          lookup = findApproval(args[1]);
        } catch {
          return fail("Approval result is unavailable\n");
        }
        const customStatusReader = lookup
          ? deps.customApprovalStatusReaders?.[lookup.upstreamName]
          : undefined;
        if (!lookup || lookup.action.status !== "approved" || !customStatusReader) {
          return fail("Approval result is unavailable\n");
        }
        return customStatusReader({
          action: lookup.action,
          context,
          mode: "result",
          capability: args[2],
        });
      }

      if (args[0] === "list") {
        const approvalNames = new Set([
          ...BUILTIN_PROXY_NAMES,
          ...Object.keys(deps.customApprovalExecutors ?? {}),
          ...Object.keys(deps.customApprovalStatusReaders ?? {}),
          ...Object.keys(deps.customApprovalReviewerAuthorizers ?? {}),
        ]);
        const approvals = [...approvalNames].flatMap((upstreamName) => {
          const actions = getApprovalStore(upstreamName).listPending();
          if (!deps.customApprovalStatusReaders?.[upstreamName]) return actions;
          return actions
            .filter((action) => action.origin?.sessionId === context.sessionId)
            .map(safeCustomApprovalAction);
        });
        return ok(stringify({ approvals }));
      }

      return fail(
        `Unknown subcommand: ${args[0]}\nUsage:\n  approval status <action-id>\n  approval result <action-id> <capability>\n  approval list\n`,
      );
    },
  };
}
