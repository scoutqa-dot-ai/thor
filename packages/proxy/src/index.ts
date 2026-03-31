import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
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

// --- MCP server per session ---

/** Synthetic tool injected when approve list is non-empty. */
const CHECK_APPROVAL_TOOL: Tool = {
  name: "check_approval_status",
  description:
    "Check the status of a pending approval request. Returns the current status and, if approved, the tool call result.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action_id: {
        type: "string",
        description: "The action ID returned when the tool call was held for approval.",
      },
    },
    required: ["action_id"],
  },
};

function createProxyServer(instance: ProxyInstance): Server {
  const server = new Server(
    { name: `thor-proxy-${instance.name}`, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Re-read allow/approve from config on every ListTools call
    const config = getConfig();
    const proxyDef = config.proxies?.[instance.name];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    const exposedTools = instance.upstream.tools.filter(
      (t) => classifyTool(allow, approve, t.name) !== "hidden",
    );
    const hasApprove = approve.length > 0;
    return { tools: hasApprove ? [...exposedTools, CHECK_APPROVAL_TOOL] : exposedTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    // Re-read allow/approve from config on every CallTool
    const config = getConfig();
    const proxyDef = config.proxies?.[instance.name];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    // Handle check_approval_status synthetic tool.
    if (toolName === "check_approval_status") {
      const actionId = (args as { action_id?: string }).action_id;
      if (!actionId) {
        return {
          content: [{ type: "text" as const, text: "Missing required parameter: action_id" }],
          isError: true,
        } satisfies CallToolResult;
      }
      const action = instance.approvalStore.get(actionId);
      if (!action) {
        return {
          content: [
            { type: "text" as const, text: `No approval action found with ID: ${actionId}` },
          ],
          isError: true,
        } satisfies CallToolResult;
      }
      if (action.status === "pending") {
        return {
          content: [
            {
              type: "text" as const,
              text: `⏳ Status: pending. Awaiting human approval for \`${action.tool}\`.`,
            },
          ],
          isError: false,
        } satisfies CallToolResult;
      }
      if (action.status === "rejected") {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Status: rejected.${action.reason ? ` Reason: ${action.reason}` : ""} Reviewer: ${action.reviewer ?? "unknown"}.`,
            },
          ],
          isError: false,
        } satisfies CallToolResult;
      }
      // approved
      if (action.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Status: approved (but execution failed). Error: ${action.error}`,
            },
          ],
          isError: true,
        } satisfies CallToolResult;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(action.result) }],
        isError: false,
      } satisfies CallToolResult;
    }

    const classification = classifyTool(allow, approve, toolName);
    if (classification === "hidden") {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      } satisfies CallToolResult;
    }

    // Approval-required tools: store request and return pending action ID.
    if (classification === "approve") {
      const action = instance.approvalStore.create(toolName, args);
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolName,
        actionId: action.id,
      });
      writeToolCallLog({ tool: toolName, decision: "pending", args });
      return {
        content: [
          {
            type: "text" as const,
            text: `⏳ Approval required for \`${toolName}\`. Action ID: ${action.id}. Proxy-Name: ${instance.name}. Use \`check_approval_status\` with this ID to check the outcome.`,
          },
        ],
        isError: false,
      } satisfies CallToolResult;
    }

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
      });
      writeToolCallLog({ tool: toolName, decision: "allowed", args, result, durationMs: duration });
      return result as CallToolResult;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
      });
      writeToolCallLog({
        tool: toolName,
        decision: "allowed",
        args,
        durationMs: duration,
        error: message,
      });
      return {
        content: [{ type: "text" as const, text: `Error calling "${toolName}": ${message}` }],
        isError: true,
      } satisfies CallToolResult;
    }
  });

  return server;
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

// Per-upstream transports with last-activity tracking for idle reaping
const transports = new Map<
  string,
  { transport: StreamableHTTPServerTransport; upstream: string; lastActivity: number }
>();

const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const REAP_INTERVAL_MS = 60 * 1000; // check every minute

setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of transports) {
    if (now - entry.lastActivity > SESSION_IDLE_MS) {
      logInfo(log, "session_reaped", { sessionId: sid, upstream: entry.upstream });
      transports.delete(sid);
      entry.transport.close().catch(() => {});
    }
  }
}, REAP_INTERVAL_MS).unref();

// --- MCP endpoints: /:upstream ---

async function handleMcpPost(req: Request<{ upstream: string }>, res: Response) {
  const upstreamName = req.params.upstream;

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const entry = transports.get(sessionId)!;
      entry.lastActivity = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.body?.method === "initialize") {
      const instance = await getInstance(upstreamName);
      if (!instance) {
        res.status(404).json({ error: `Unknown upstream: ${upstreamName}` });
        return;
      }

      const newSessionId = randomUUID();
      const server = createProxyServer(instance);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, { transport, upstream: upstreamName, lastActivity: Date.now() });
          logInfo(log, "session_created", { sessionId: sid, upstream: upstreamName });
        },
      });
      transport.onclose = () => {
        transports.delete(newSessionId);
        logInfo(log, "session_closed", { sessionId: newSessionId, upstream: upstreamName });
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  } catch (err) {
    logError(log, "mcp_request_error", err, { upstream: upstreamName });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

async function handleMcpGetOrDelete(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    entry.lastActivity = Date.now();
    await entry.transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
}

app.post("/:upstream", handleMcpPost);
app.get("/:upstream", handleMcpGetOrDelete);
app.delete("/:upstream", handleMcpGetOrDelete);

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
