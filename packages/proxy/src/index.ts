import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type ProxyConfig } from "./config.js";
import { evaluatePolicy, validatePolicy, type UpstreamToolSet } from "./policy.js";
import { connectAllUpstreams, disconnectAll, type UpstreamConnection } from "./upstream.js";
import { writeToolCallLog, createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("proxy");

const PORT = parseInt(process.env.PORT || "3001", 10);
const CONFIG_PATH =
  process.env.PROXY_CONFIG || resolve(import.meta.dirname, "../proxy.config.json");

// --- Load config ---
const rawConfig: ProxyConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const config = loadConfig(rawConfig);
logInfo(log, "config_loaded", { upstreams: Object.keys(config.upstreams) });

// --- State ---
let upstreams: Map<string, UpstreamConnection> = new Map();

// Map to find which upstream owns a tool (tool names are prefixed with upstream name)
// e.g. "linear__list_issues" -> { upstream: "linear", originalName: "list_issues" }
interface ToolMapping {
  upstream: string;
  originalName: string;
}
const toolMap = new Map<string, ToolMapping>();

// Build the prefixed tool list with original JSON schemas from upstreams.
// Called once at startup after all upstreams are connected.
let proxyTools: Tool[] = [];

function buildToolIndex(): void {
  toolMap.clear();
  proxyTools = [];

  for (const [upstreamName, conn] of upstreams) {
    for (const tool of conn.tools) {
      const proxyToolName = `${upstreamName}__${tool.name}`;
      toolMap.set(proxyToolName, { upstream: upstreamName, originalName: tool.name });

      // Pass through the original tool definition with its real JSON Schema
      proxyTools.push({
        name: proxyToolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
}

/**
 * Create a low-level MCP Server that faces the agent.
 * Uses Server directly (not McpServer) so we can return the original
 * JSON Schema inputSchema from upstream tools — no Zod conversion needed.
 */
function createProxyServer(): Server {
  const server = new Server(
    { name: "thor-proxy", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // tools/list — return upstream tools with their real JSON schemas
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: proxyTools,
  }));

  // tools/call — evaluate policy, then forward to upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    const mapping = toolMap.get(toolName);
    if (!mapping) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      } satisfies CallToolResult;
    }

    // Evaluate policy
    const decision = evaluatePolicy(config.policy, mapping.upstream, mapping.originalName);

    if (decision === "block") {
      logInfo(log, "tool_call", {
        upstream: mapping.upstream,
        tool: mapping.originalName,
        decision: "blocked",
      });
      writeToolCallLog({
        upstream: mapping.upstream,
        tool: mapping.originalName,
        proxyToolName: toolName,
        decision: "blocked",
        args,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool "${mapping.originalName}" on upstream "${mapping.upstream}" is blocked by policy.`,
          },
        ],
        isError: true,
      } satisfies CallToolResult;
    }

    // Forward to upstream
    const conn = upstreams.get(mapping.upstream);
    if (!conn) {
      return {
        content: [{ type: "text" as const, text: `Upstream "${mapping.upstream}" not connected.` }],
        isError: true,
      } satisfies CallToolResult;
    }

    const start = Date.now();
    try {
      const result = await conn.client.callTool({
        name: mapping.originalName,
        arguments: args,
      });
      const duration = Date.now() - start;
      logInfo(log, "tool_call", {
        upstream: mapping.upstream,
        tool: mapping.originalName,
        decision: "allowed",
        durationMs: duration,
      });
      writeToolCallLog({
        upstream: mapping.upstream,
        tool: mapping.originalName,
        proxyToolName: toolName,
        decision: "allowed",
        args,
        result,
        durationMs: duration,
      });
      return result as CallToolResult;
    } catch (err) {
      const duration = Date.now() - start;
      logError(log, "tool_call", err instanceof Error ? err.message : String(err), {
        upstream: mapping.upstream,
        tool: mapping.originalName,
        decision: "allowed",
        durationMs: duration,
      });
      writeToolCallLog({
        upstream: mapping.upstream,
        tool: mapping.originalName,
        proxyToolName: toolName,
        decision: "allowed",
        args,
        durationMs: duration,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Error calling "${mapping.originalName}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      } satisfies CallToolResult;
    }
  });

  return server;
}

// --- Express app ---
const app = express();

// Need raw body for MCP
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "proxy",
    upstreams: Object.fromEntries(
      [...upstreams.entries()].map(([name, conn]) => [name, { tools: conn.tools.length }]),
    ),
  });
});

// Session management for MCP Streamable HTTP
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  try {
    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — check if this is an initialize request
    const body = req.body;
    if (body?.method === "initialize") {
      const newSessionId = randomUUID();

      const server = createProxyServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          logInfo(log, "session_created", { sessionId: sid });
        },
      });

      transport.onclose = () => {
        transports.delete(newSessionId);
        logInfo(log, "session_closed", { sessionId: newSessionId });
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Not an initialize request and no valid session
    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  } catch (err) {
    logError(log, "mcp_request_error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Handle GET for SSE stream (optional, for server-initiated messages)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

// Handle DELETE for session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

// --- Startup ---
async function start(): Promise<void> {
  logInfo(log, "proxy_starting", { port: PORT });

  // Connect to all upstreams
  upstreams = await connectAllUpstreams(config.upstreams);

  // Build the prefixed tool index with original JSON schemas
  buildToolIndex();

  // Validate policy against discovered tools — fail fast on drift
  const toolSets: UpstreamToolSet[] = [...upstreams.entries()].map(([name, conn]) => ({
    upstream: name,
    tools: conn.tools.map((t) => t.name),
  }));
  validatePolicy(config.policy, toolSets);
  logInfo(log, "policy_validated", {
    upstreams: toolSets.map((ts) => ts.upstream),
    totalTools: toolSets.reduce((sum, ts) => sum + ts.tools.length, 0),
    totalRules: config.policy.rules.length,
  });

  app.listen(PORT, () => {
    logInfo(log, "proxy_listening", { port: PORT });
  });
}

// --- Graceful shutdown ---
process.on("SIGTERM", async () => {
  logInfo(log, "proxy_shutting_down");
  await disconnectAll(upstreams);
  process.exit(0);
});

process.on("SIGINT", async () => {
  logInfo(log, "proxy_shutting_down");
  await disconnectAll(upstreams);
  process.exit(0);
});

start().catch((err) => {
  logError(log, "proxy_start_failed", err);
  process.exit(1);
});
