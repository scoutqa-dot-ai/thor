import {
  computeSlackAlias,
  createLogger,
  extractRepoFromCwd,
  getProxyConfig,
  formatThorMeta,
  isProxyName,
  getRepoUpstreams,
  interpolateHeaders,
  isAliasableMcpTool,
  logError,
  logInfo,
  logWarn,
  PROXY_NAMES,
  type ConfigLoader,
  type ProxyConfig,
  type WorkspaceConfig,
  writeToolCallLog,
  findActiveTrigger,
} from "@thor/common";
import { ApprovalStore, type ApprovalAction } from "./approval-store.js";
import {
  classifyTool,
  PolicyDriftError,
  PolicyOverlapError,
  validatePolicy,
} from "./policy-mcp.js";
import { unwrapResult } from "./unwrap-result.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";

const log = createLogger("mcp");
const DEFAULT_APPROVALS_DIR = "/workspace/data/approvals";
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const RUNNER_BASE_URL = (process.env.RUNNER_BASE_URL || "").replace(/\/$/, "");

function addDisclaimerToApprovalArgs(tool: string, args: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
  if (tool !== "createJiraIssue" && tool !== "addCommentToJiraIssue") return args;
  if (!sessionId) return args;
  const active = findActiveTrigger(sessionId);
  if (!active.ok) throw new Error(`Cannot create approval: no single active trigger for this session (${active.reason})`);
  const url = `${RUNNER_BASE_URL}/runner/v/${active.sessionId}/${active.triggerId}`;
  const field = tool === "createJiraIssue" ? "description" : "commentBody";
  if (typeof args[field] !== "string") throw new Error(`Cannot create approval: ${tool}.${field} must be a string for disclaimer injection`);
  return { ...args, [field]: `${args[field]}\n\n---\n[View Thor trigger](${url})` };
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
}

export interface McpCommandContext {
  directory?: string;
  sessionId?: string;
  callId?: string;
}

export interface McpServiceDeps {
  getConfig: ConfigLoader;
  approvalsDir?: string;
  isProduction?: boolean;
  connectUpstreamFn?: typeof connectUpstream;
  writeToolCallLogFn?: typeof writeToolCallLog;
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
  connectConfiguredUpstreams(): Promise<void>;
  closeAll(): Promise<void>;
  executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult>;
  executeApproval(args: string[]): Promise<McpExecResult>;
}

export function createMcpService(deps: McpServiceDeps): McpService {
  const approvalsDir = deps.approvalsDir ?? DEFAULT_APPROVALS_DIR;
  const connectUpstreamFn = deps.connectUpstreamFn ?? connectUpstream;
  const writeToolCallLogFn = deps.writeToolCallLogFn ?? writeToolCallLog;
  const instances = new Map<string, ProxyInstance>();
  const connecting = new Map<string, Promise<ProxyInstance>>();
  const approvalStores = new Map<string, ApprovalStore>();

  function getConfig(): WorkspaceConfig {
    return deps.getConfig();
  }

  function getThorIds(context: McpCommandContext): { sessionId?: string; callId?: string } {
    return {
      ...(context.sessionId && { sessionId: context.sessionId }),
      ...(context.callId && { callId: context.callId }),
    };
  }

  function getConfiguredUpstreamNames(): string[] {
    const enabled = new Set<string>();
    for (const repo of Object.values(getConfig().repos)) {
      for (const upstreamName of repo.proxies ?? []) {
        if (isProxyName(upstreamName)) {
          enabled.add(upstreamName);
        }
      }
    }
    return PROXY_NAMES.filter((name) => enabled.has(name));
  }

  function getApprovalStore(name: string): ApprovalStore {
    const existing = approvalStores.get(name);
    if (existing) return existing;
    const store = new ApprovalStore(`${approvalsDir}/${name}`, name);
    approvalStores.set(name, store);
    return store;
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

  function getRepoFromDirectory(directory?: string): string | McpExecResult {
    if (!directory) {
      return fail("Missing required field: directory");
    }
    const repo = extractRepoFromCwd(directory);
    if (!repo) {
      return fail(
        `Cannot determine repo from directory: ${directory}. Expected /workspace/repos/<repo> (worktrees are not allowed for MCP authz)`,
      );
    }
    return repo;
  }

  function getAllowedUpstreamsForRepo(repo: string): string[] | McpExecResult {
    const config = getConfig();
    const allowed = getRepoUpstreams(config, repo);
    if (allowed === undefined) {
      return fail(`Repo "${repo}" not found in config`);
    }
    return allowed.filter(isProxyName);
  }

  async function listVisibleTools(
    upstreamName: string,
    repo: string,
  ): Promise<ToolInfo[] | McpExecResult> {
    const allowed = getAllowedUpstreamsForRepo(repo);
    if (!Array.isArray(allowed)) return allowed;
    if (!allowed.includes(upstreamName)) {
      return fail(
        `Unknown upstream "${upstreamName}". Available upstreams: ${allowed.join(", ") || "(none)"}`,
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
    const repo = getRepoFromDirectory(directory);
    if (typeof repo !== "string") return repo;

    const allowed = getAllowedUpstreamsForRepo(repo);
    if (!Array.isArray(allowed)) return allowed;

    const upstreams = allowed.map((name) => {
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
    logEvent: string;
    decision: "allowed" | "blocked" | "pending" | "approved" | "rejected";
    extraLogFields?: Record<string, unknown>;
    inputSchema?: unknown;
    onSuccess?: (rawResult: unknown) => void;
    onError?: (message: string) => void;
  }

  async function executeUpstreamCall(opts: UpstreamCallOpts): Promise<McpExecResult> {
    const { instance, toolName, args, logEvent, decision, extraLogFields, inputSchema } = opts;
    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: toolName,
        arguments: args,
      });
      const duration = Date.now() - start;
      logInfo(log, logEvent, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...extraLogFields,
      });
      writeToolCallLogFn({ tool: toolName, decision, args, result, durationMs: duration });
      opts.onSuccess?.(result);

      let stdout = unwrapResult(result);
      if (isAliasableMcpTool(toolName)) {
        const alias = computeSlackAlias(args, stdout);
        if (alias) stdout += formatThorMeta(alias);
      }
      return ok(stdout);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, logEvent, message, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...extraLogFields,
      });
      writeToolCallLogFn({ tool: toolName, decision, args, durationMs: duration, error: message });
      opts.onError?.(message);

      let stderr = `Error calling "${toolName}": ${message}\n`;
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
      let approvalArgs: Record<string, unknown>;
      try {
        approvalArgs = addDisclaimerToApprovalArgs(toolInfo.name, args, context.sessionId);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const action = instance.approvalStore.create(toolInfo.name, approvalArgs);
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolInfo.name,
        actionId: action.id,
        ...getThorIds(context),
      });
      writeToolCallLogFn({ tool: toolInfo.name, decision: "pending", args: approvalArgs });
      const approvalText = `Approval required for \`${toolInfo.name}\`. Run: approval status ${action.id}`;
      const approvalMeta = formatThorMeta({
        type: "approval",
        actionId: action.id,
        proxyName: instance.name,
        tool: toolInfo.name,
      });
      return ok(`${approvalText}${approvalMeta}`);
    }

    return executeUpstreamCall({
      instance,
      toolName: toolInfo.name,
      args,
      logEvent: "tool_call",
      decision: "allowed",
      extraLogFields: getThorIds(context),
      inputSchema: toolInfo.inputSchema,
    });
  }

  function findApproval(actionId: string): ApprovalLookup | undefined {
    for (const upstreamName of getConfiguredUpstreamNames()) {
      const store = getApprovalStore(upstreamName);
      const action = store.get(actionId);
      if (action) {
        return { upstreamName, action, store };
      }
    }
    return undefined;
  }

  async function resolveApprovalAction(
    actionId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | undefined,
  ): Promise<McpExecResult> {
    const lookup = findApproval(actionId);
    if (!lookup) {
      return fail(`No approval action found with ID: ${actionId}`);
    }

    if (lookup.action.status !== "pending") {
      return fail("Not found or already resolved");
    }
    const action = lookup.store.resolveLoaded(lookup.action, decision, reviewer, reason);

    if (decision === "rejected") {
      logInfo(log, "tool_call_rejected", {
        upstream: lookup.upstreamName,
        tool: action.tool,
        actionId: action.id,
        reviewer,
      });
      writeToolCallLogFn({ tool: action.tool, decision: "rejected", args: action.args });
      return ok(stringify(action));
    }

    const instance = await getInstance(lookup.upstreamName);
    if (!instance) {
      return fail(`Unknown upstream "${lookup.upstreamName}".`);
    }

    return executeUpstreamCall({
      instance,
      toolName: action.tool,
      args: action.args,
      logEvent: "tool_call_approved",
      decision: "approved",
      extraLogFields: { actionId: action.id },
      onSuccess: (rawResult) => {
        action.result = rawResult;
        lookup.store.update(action);
      },
      onError: (message) => {
        action.error = message;
        lookup.store.update(action);
      },
    });
  }

  return {
    getHealth(): Record<string, unknown> {
      try {
        const upstreamNames = getConfiguredUpstreamNames();
        return {
          configured: upstreamNames.length,
          connected: upstreamNames.filter((name) => instances.has(name)).length,
          instances: Object.fromEntries(
            upstreamNames.map((name) => [
              name,
              {
                connected: instances.has(name),
                tools: instances.get(name)?.upstream.tools.length ?? 0,
              },
            ]),
          ),
        };
      } catch (err) {
        return {
          configured: "unavailable",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async connectConfiguredUpstreams(): Promise<void> {
      let upstreamNames: string[] = [];
      try {
        upstreamNames = getConfiguredUpstreamNames();
      } catch (err) {
        logWarn(log, "config_not_available", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const results = await Promise.allSettled(upstreamNames.map((name) => getInstance(name)));
      for (let index = 0; index < upstreamNames.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          logError(log, "upstream_connect_failed", result.reason, { name: upstreamNames[index] });
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

      const repo = getRepoFromDirectory(context.directory);
      if (typeof repo !== "string") return repo;

      const upstreams = getAllowedUpstreamsForRepo(repo);
      if (!Array.isArray(upstreams)) return upstreams;
      const upstreamName = args[0];
      if (!upstreams.includes(upstreamName)) {
        return fail(
          `Unknown upstream "${upstreamName}". ${suggestMatch(
            upstreamName,
            upstreams,
          )}Available upstreams: ${upstreams.join(", ") || "(none)"}\n`,
        );
      }

      const tools = await listVisibleTools(upstreamName, repo);
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
        const lookup = findApproval(args[1]);
        if (!lookup) {
          return fail(`No approval action found with ID: ${args[1]}\n`);
        }
        return ok(stringify(lookup.action));
      }

      if (args[0] === "list") {
        const approvals = getConfiguredUpstreamNames().flatMap((upstreamName) =>
          getApprovalStore(upstreamName).listPending(),
        );
        return ok(stringify({ approvals }));
      }

      return fail(
        `Unknown subcommand: ${args[0]}\nUsage:\n  approval status <action-id>\n  approval list\n`,
      );
    },
  };
}
