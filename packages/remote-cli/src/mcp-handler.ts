import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  computeSlackAlias,
  createLogger,
  extractRepoFromCwd,
  formatThorMeta,
  getRepoUpstreams,
  interpolateHeaders,
  isAliasableMcpTool,
  logError,
  logInfo,
  logWarn,
  type ConfigLoader,
  type ProxyConfig,
  type WorkspaceConfig,
  writeToolCallLog,
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
  cwd?: string;
  directory?: string;
  sessionId?: string;
  callId?: string;
  resolveSecret?: string;
}

export interface McpServiceDeps {
  getConfig: ConfigLoader;
  approvalsDir?: string;
  isProduction?: boolean;
  resolveSecret?: string;
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
    return Object.keys(getConfig().proxies ?? {});
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
    const config = getConfig();
    const proxyDef = config.proxies?.[name];
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
    return allowed.filter((name) => config.proxies?.[name]);
  }

  async function listVisibleTools(
    upstreamName: string,
    repo: string,
  ): Promise<ToolInfo[] | McpExecResult> {
    const config = getConfig();
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

    const proxyDef = config.proxies?.[upstreamName];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    return instance.upstream.tools
      .filter((tool) => classifyTool(allow, approve, tool.name) !== "hidden")
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        classification: classifyTool(allow, approve, tool.name),
      }));
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
      const action = instance.approvalStore.create(toolInfo.name, args);
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolInfo.name,
        actionId: action.id,
        ...getThorIds(context),
      });
      writeToolCallLogFn({ tool: toolInfo.name, decision: "pending", args });
      const approvalText = `Approval required for \`${toolInfo.name}\`. Run: approval status ${action.id}`;
      const approvalMeta = formatThorMeta({
        type: "approval",
        actionId: action.id,
        proxyName: instance.name,
        tool: toolInfo.name,
      });
      return ok(`${approvalText}${approvalMeta}`);
    }

    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: toolInfo.name,
        arguments: args,
      });
      const duration = Date.now() - start;
      logInfo(log, "tool_call", {
        upstream: instance.name,
        tool: toolInfo.name,
        durationMs: duration,
        ...getThorIds(context),
      });
      writeToolCallLogFn({
        tool: toolInfo.name,
        decision: "allowed",
        args,
        result,
        durationMs: duration,
      });

      let stdout = unwrapResult(result);
      if (isAliasableMcpTool(toolInfo.name)) {
        const alias = computeSlackAlias(args, stdout);
        if (alias) stdout += formatThorMeta(alias);
      }
      return ok(stdout);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, {
        upstream: instance.name,
        tool: toolInfo.name,
        durationMs: duration,
        ...getThorIds(context),
      });
      writeToolCallLogFn({
        tool: toolInfo.name,
        decision: "allowed",
        args,
        durationMs: duration,
        error: message,
      });

      let stderr = `Error calling "${toolInfo.name}": ${message}\n`;
      if (toolInfo.inputSchema) {
        stderr += `\n[hint] Input schema for "${toolInfo.name}":\n${JSON.stringify(toolInfo.inputSchema, null, 2)}\n`;
      }
      return fail(stderr);
    }
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

    const action = lookup.store.resolve(actionId, decision, reviewer, reason);
    if (!action) {
      return fail("Not found or already resolved");
    }

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

    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: action.tool,
        arguments: action.args,
      });
      const duration = Date.now() - start;
      action.result = result;
      lookup.store.update(action);
      logInfo(log, "tool_call_approved", {
        upstream: lookup.upstreamName,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
      });
      writeToolCallLogFn({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        result,
        durationMs: duration,
      });

      let stdout = unwrapResult(result);
      if (isAliasableMcpTool(action.tool)) {
        const alias = computeSlackAlias(action.args, stdout);
        if (alias) stdout += formatThorMeta(alias);
      }
      return ok(stdout);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      action.error = message;
      lookup.store.update(action);
      logError(log, "tool_call_approved_failed", message, {
        upstream: lookup.upstreamName,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
      });
      writeToolCallLogFn({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        durationMs: duration,
        error: message,
      });
      return fail(`Error calling "${action.tool}": ${message}\n`);
    }
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
      for (const instance of instances.values()) {
        await instance.upstream.client.close();
      }
    },

    async executeMcp(args: string[], context: McpCommandContext): Promise<McpExecResult> {
      if (args[0] === "resolve") {
        if (!deps.resolveSecret || context.resolveSecret !== deps.resolveSecret) {
          return fail("Unknown subcommand: resolve\n");
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
