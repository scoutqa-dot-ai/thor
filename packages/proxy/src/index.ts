import express, { type Request, type Response } from "express";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyTool, validatePolicy, PolicyDriftError, PolicyOverlapError } from "./policy.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { ApprovalStore } from "./approval-store.js";
import {
  writeToolCallLog,
  createLogger,
  logInfo,
  logWarn,
  logError,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  interpolateHeaders,
  extractRepoFromCwd,
  getRepoProxies,
  type ProxyConfig,
} from "@thor/common";

const log = createLogger("proxy");

const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const APPROVALS_DIR = process.env.APPROVALS_DIR || "data/approvals";

const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

// --- Per-upstream instance ---

interface ProxyInstance {
  name: string;
  upstream: UpstreamConnection;
  approvalStore: ApprovalStore;
}

const instances = new Map<string, ProxyInstance>();
const connecting = new Map<string, Promise<ProxyInstance>>();

/** Get or lazily connect to an upstream by name. */
async function getInstance(name: string): Promise<ProxyInstance | undefined> {
  // Check config first — if upstream was removed, don't serve it
  const config = getConfig();
  const proxyDef = config.proxies?.[name];
  if (!proxyDef) {
    // Clean up cached instance if upstream was removed from config
    instances.delete(name);
    return undefined;
  }

  // Already connected
  const existing = instances.get(name);
  if (existing) return existing;

  // Connection in progress
  const pending = connecting.get(name);
  if (pending) return pending;

  // Connect
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

async function connectInstance(name: string, proxyDef: ProxyConfig): Promise<ProxyInstance> {
  const interpolatedHeaders = interpolateHeaders(proxyDef.upstream.headers);
  const upstreamConfig = {
    url: proxyDef.upstream.url,
    headers: interpolatedHeaders,
  };

  const MAX_RECONNECT_ATTEMPTS = 5;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30_000;

  function scheduleReconnect(attempt: number) {
    const instance = instances.get(name);
    if (!instance) return;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      logError(
        log,
        "upstream_reconnect_exhausted",
        `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`,
        { name },
      );
      instances.delete(name);
      return;
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    logInfo(log, "upstream_reconnecting", { name, attempt, delayMs: delay });
    setTimeout(() => {
      connectUpstream(name, upstreamConfig, () => scheduleReconnect(1))
        .then((newUpstream) => {
          instance.upstream = newUpstream;
          logInfo(log, "upstream_reconnected", { name, afterAttempt: attempt });
        })
        .catch((err) => {
          logError(
            log,
            "upstream_reconnect_failed",
            err instanceof Error ? err.message : String(err),
            {
              name,
              attempt,
            },
          );
          scheduleReconnect(attempt + 1);
        });
    }, delay);
  }

  logInfo(log, "connecting_upstream", { name, url: proxyDef.upstream.url });
  const upstream = await connectUpstream(name, upstreamConfig, () => scheduleReconnect(1));

  // Validate policy against upstream tools
  const allToolNames = upstream.tools.map((t) => t.name);
  try {
    validatePolicy(proxyDef.allow, proxyDef.approve ?? [], allToolNames);
  } catch (err) {
    if (err instanceof PolicyDriftError) {
      if (IS_PRODUCTION) {
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
    // Primary: data/approvals/{upstream}/{date}/{id}.json
    // TODO: Remove legacy fallback once all in-flight approvals have drained (safe after 2026-05-01)
    approvalStore: new ApprovalStore(`${APPROVALS_DIR}/${name}`, [APPROVALS_DIR]),
  };
}

// --- Express app ---
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const config = getConfig();
  const proxyNames = Object.keys(config.proxies ?? {});
  const connected = proxyNames.filter((n) => instances.has(n));
  res.json({
    status: "ok",
    service: "proxy",
    upstreams: proxyNames.length,
    connected: connected.length,
    instances: Object.fromEntries(
      proxyNames.map((n) => [
        n,
        {
          connected: instances.has(n),
          tools: instances.get(n)?.upstream.tools.length ?? 0,
        },
      ]),
    ),
  });
});

// --- Sessionless CLI endpoints ---

/** Extract Thor tracing IDs from request headers. */
function thorIds(req: Request): { sessionId?: string; callId?: string } {
  const sessionId = req.headers["x-thor-session-id"] as string | undefined;
  const callId = req.headers["x-thor-call-id"] as string | undefined;
  return {
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
  };
}

/** Extract and validate repo from x-thor-directory header. */
function extractRepo(req: Request, res: Response): string | null {
  const directory = req.headers["x-thor-directory"] as string | undefined;
  if (!directory) {
    res.status(400).json({ error: "Missing required header: x-thor-directory" });
    return null;
  }
  const repo = extractRepoFromCwd(directory);
  if (!repo) {
    res.status(400).json({
      error: `Cannot determine repo from directory: ${directory}. Expected /workspace/repos/<repo>`,
    });
    return null;
  }
  return repo;
}

/** Check if a repo has access to a specific upstream. Returns true or sends 403. */
function checkRepoAccess(
  res: Response,
  config: ReturnType<typeof getConfig>,
  repo: string,
  upstreamName: string,
): boolean {
  const allowed = getRepoProxies(config, repo);
  if (allowed === undefined) {
    res.status(404).json({ error: `Repo "${repo}" not found in config` });
    return false;
  }
  if (!allowed.includes(upstreamName)) {
    res.status(403).json({
      error: `Repo "${repo}" does not have access to upstream "${upstreamName}"`,
    });
    return false;
  }
  return true;
}

// GET /upstreams — list upstreams available to the repo
app.get("/upstreams", (req, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const config = getConfig();
  const allowed = getRepoProxies(config, repo);
  if (allowed === undefined) {
    res.status(404).json({ error: `Repo "${repo}" not found in config` });
    return;
  }

  const upstreams = allowed
    .filter((name) => config.proxies?.[name])
    .map((name) => {
      const instance = instances.get(name);
      return {
        name,
        toolCount: instance?.upstream.tools.length ?? 0,
        connected: instances.has(name),
      };
    });

  res.json({ upstreams });
});

// GET /approval/:id — search across all upstream approval stores
app.get("/approval/:id", async (req, res) => {
  try {
    const actionId = req.params.id;

    // Search across all connected instances
    for (const instance of instances.values()) {
      const action = instance.approvalStore.get(actionId);
      if (action) {
        res.json(action);
        return;
      }
    }

    // Also try connecting to all configured upstreams and checking
    const config = getConfig();
    for (const name of Object.keys(config.proxies ?? {})) {
      if (instances.has(name)) continue; // already checked
      const instance = await getInstance(name);
      if (instance) {
        const action = instance.approvalStore.get(actionId);
        if (action) {
          res.json(action);
          return;
        }
      }
    }

    res.status(404).json({ error: `No approval action found with ID: ${actionId}` });
  } catch (err) {
    logError(log, "approval_lookup_error", err, { id: req.params.id, ...thorIds(req) });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /approvals — list pending approvals across all upstreams
app.get("/approvals", (_req, res) => {
  const pending: Array<{ upstream: string } & Record<string, unknown>> = [];
  for (const instance of instances.values()) {
    for (const action of instance.approvalStore.listPending()) {
      pending.push({ upstream: instance.name, ...action });
    }
  }
  res.json({ approvals: pending });
});

// GET /:upstream/tools — list tools for an upstream (validates repo access)
app.get("/:upstream/tools", async (req: Request<{ upstream: string }>, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const upstreamName = req.params.upstream;
  const config = getConfig();

  if (!checkRepoAccess(res, config, repo, upstreamName)) return;

  try {
    const instance = await getInstance(upstreamName);
    if (!instance) {
      res.status(404).json({ error: `Unknown upstream: ${upstreamName}` });
      return;
    }

    const proxyDef = config.proxies?.[upstreamName];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    const tools = instance.upstream.tools
      .filter((t) => classifyTool(allow, approve, t.name) !== "hidden")
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        classification: classifyTool(allow, approve, t.name),
      }));

    res.json({ tools });
  } catch (err) {
    logError(log, "tools_list_error", err, { upstream: upstreamName, ...thorIds(req) });
    if (!res.headersSent) {
      res.status(502).json({ error: `Upstream "${upstreamName}" is unreachable` });
    }
  }
});

// POST /:upstream/tools/call — call a tool (validates repo access)
app.post("/:upstream/tools/call", async (req: Request<{ upstream: string }>, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const upstreamName = req.params.upstream;
  const config = getConfig();

  if (!checkRepoAccess(res, config, repo, upstreamName)) return;

  const { name: toolName, arguments: toolArgs } = req.body as {
    name?: string;
    arguments?: Record<string, unknown>;
  };

  if (!toolName || typeof toolName !== "string") {
    res.status(400).json({ error: "Missing required field: name" });
    return;
  }

  try {
    const instance = await getInstance(upstreamName);
    if (!instance) {
      res.status(404).json({ error: `Unknown upstream: ${upstreamName}` });
      return;
    }

    const proxyDef = config.proxies?.[upstreamName];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];
    const args = toolArgs ?? {};

    const classification = classifyTool(allow, approve, toolName);
    if (classification === "hidden") {
      res.json({
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      } satisfies CallToolResult);
      return;
    }

    if (classification === "approve") {
      const action = instance.approvalStore.create(toolName, args);
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolName,
        actionId: action.id,
        ...thorIds(req),
      });
      writeToolCallLog({ tool: toolName, decision: "pending", args });
      res.json({
        content: [
          {
            type: "text",
            text: `Approval required for \`${toolName}\`. Run: approval status ${action.id}`,
          },
          {
            type: "text",
            text: JSON.stringify({
              type: "approval_required",
              actionId: action.id,
              proxyName: instance.name,
              tool: toolName,
            }),
          },
        ],
        isError: false,
      } satisfies CallToolResult);
      return;
    }

    // classification === "allow"
    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: toolName,
        arguments: args,
      });
      const duration = Date.now() - start;
      logInfo(log, "tool_call", {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...thorIds(req),
      });
      writeToolCallLog({ tool: toolName, decision: "allowed", args, result, durationMs: duration });
      res.json(result);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...thorIds(req),
      });
      writeToolCallLog({
        tool: toolName,
        decision: "allowed",
        args,
        durationMs: duration,
        error: message,
      });
      res.status(502).json({
        content: [{ type: "text", text: `Error calling "${toolName}": ${message}` }],
        isError: true,
      } satisfies CallToolResult);
    }
  } catch (err) {
    logError(log, "tools_call_error", err, { upstream: upstreamName, ...thorIds(req) });
    if (!res.headersSent) {
      res.status(502).json({ error: `Upstream "${upstreamName}" is unreachable` });
    }
  }
});

// --- Approval endpoints: /:upstream/approval/:id ---

app.get("/:upstream/approval/:id", async (req, res) => {
  const instance = await getInstance(req.params.upstream);
  if (!instance) {
    res.status(404).json({ error: `Unknown upstream: ${req.params.upstream}` });
    return;
  }
  const action = instance.approvalStore.get(req.params.id);
  if (!action) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(action);
});

app.post("/:upstream/approval/:id/resolve", async (req, res) => {
  const instance = await getInstance(req.params.upstream);
  if (!instance) {
    res.status(404).json({ error: `Unknown upstream: ${req.params.upstream}` });
    return;
  }

  const { decision, reviewer, reason } = req.body as {
    decision?: string;
    reviewer?: string;
    reason?: string;
  };

  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    return;
  }

  const action = instance.approvalStore.resolve(req.params.id, decision, reviewer, reason);
  if (!action) {
    res.status(404).json({ error: "Not found or already resolved" });
    return;
  }

  if (decision === "approved") {
    const start = Date.now();
    try {
      const result = await instance.upstream.client.callTool({
        name: action.tool,
        arguments: action.args,
      });
      const duration = Date.now() - start;
      action.result = result;
      instance.approvalStore.update(action);
      logInfo(log, "tool_call_approved", {
        upstream: instance.name,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
      });
      writeToolCallLog({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        result,
        durationMs: duration,
      });
      res.json(action);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      action.error = message;
      instance.approvalStore.update(action);
      logError(log, "tool_call_approved_failed", message, {
        upstream: instance.name,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
      });
      writeToolCallLog({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        durationMs: duration,
        error: message,
      });
      res.json(action);
    }
  } else {
    logInfo(log, "tool_call_rejected", {
      upstream: instance.name,
      tool: action.tool,
      actionId: action.id,
      reviewer,
    });
    writeToolCallLog({ tool: action.tool, decision: "rejected", args: action.args });
    res.json(action);
  }
});

// --- Startup ---
async function start(): Promise<void> {
  // Connect to all configured upstreams eagerly at startup (if config exists)
  let proxyNames: string[] = [];
  try {
    const config = getConfig();
    proxyNames = Object.keys(config.proxies ?? {});
  } catch {
    logWarn(log, "config_not_available", { path: WORKSPACE_CONFIG_PATH });
  }

  logInfo(log, "proxy_starting", { port: PORT, upstreams: proxyNames });

  const results = await Promise.allSettled(proxyNames.map((name) => getInstance(name)));
  for (let i = 0; i < proxyNames.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      logError(log, "upstream_connect_failed", result.reason, { name: proxyNames[i] });
    }
  }

  app.listen(PORT, () => {
    logInfo(log, "proxy_listening", {
      port: PORT,
      connected: [...instances.keys()],
    });
  });
}

process.on("SIGTERM", async () => {
  logInfo(log, "proxy_shutting_down");
  for (const instance of instances.values()) {
    await instance.upstream.client.close();
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  logInfo(log, "proxy_shutting_down");
  for (const instance of instances.values()) {
    await instance.upstream.client.close();
  }
  process.exit(0);
});

start().catch((err) => {
  logError(log, "proxy_start_failed", err);
  process.exit(1);
});
