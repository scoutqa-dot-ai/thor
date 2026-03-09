import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, type ProxyConfig } from "./config.js";
import { logError, logInfo, logToolCall } from "./logger.js";
import { evaluatePolicy, validatePolicy, type UpstreamToolSet } from "./policy.js";
import { connectAllUpstreams, disconnectAll, type UpstreamConnection } from "./upstream.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const CONFIG_PATH =
  process.env.PROXY_CONFIG || resolve(import.meta.dirname, "../proxy.config.json");

// --- Load config ---
const rawConfig: ProxyConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const config = loadConfig(rawConfig);
logInfo("config_loaded", { upstreams: Object.keys(config.upstreams) });

// --- State ---
let upstreams: Map<string, UpstreamConnection> = new Map();

// Map to find which upstream owns a tool (tool names are prefixed with upstream name)
// e.g. "linear__list_issues" -> { upstream: "linear", originalName: "list_issues" }
interface ToolMapping {
  upstream: string;
  originalName: string;
}
const toolMap = new Map<string, ToolMapping>();

/**
 * Create the MCP server that faces the agent.
 * It exposes all upstream tools (prefixed with upstream name) and applies policy.
 */
function createProxyMcpServer(): McpServer {
  const server = new McpServer(
    { name: "thor-proxy", version: "0.0.1" },
    { capabilities: { logging: {} } },
  );

  // Register all upstream tools on this server
  for (const [upstreamName, conn] of upstreams) {
    for (const tool of conn.tools) {
      const proxyToolName = `${upstreamName}__${tool.name}`;
      toolMap.set(proxyToolName, { upstream: upstreamName, originalName: tool.name });

      // Build zod schema from the tool's input schema
      // For PoC, we pass-through as a generic JSON object
      server.tool(
        proxyToolName,
        tool.description || "",
        { args: z.string().optional() },
        async () => {
          // This handler is registered but won't be used —
          // we intercept at the transport level. This is just for tools/list.
          return { content: [{ type: "text", text: "proxy placeholder" }] };
        },
      );
    }
  }

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

      // For the PoC, create a new MCP server per session
      // In production, you'd want session pooling
      const mcpServer = createProxyMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          logInfo("session_created", { sessionId: sid });
        },
      });

      transport.onclose = () => {
        transports.delete(newSessionId);
        logInfo("session_closed", { sessionId: newSessionId });
      };

      // Intercept tool calls before they reach the McpServer handlers
      // by hooking into the server's request handling
      const originalServer = mcpServer.server;

      // Register a raw request handler for tools/call to intercept and forward
      originalServer.setRequestHandler(CallToolRequestSchema, async (request) => {
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
          logToolCall(mapping.upstream, mapping.originalName, "blocked");
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
            content: [
              { type: "text" as const, text: `Upstream "${mapping.upstream}" not connected.` },
            ],
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
          logToolCall(mapping.upstream, mapping.originalName, "allowed", duration);
          return result as CallToolResult;
        } catch (err) {
          const duration = Date.now() - start;
          logToolCall(
            mapping.upstream,
            mapping.originalName,
            "allowed",
            duration,
            err instanceof Error ? err.message : String(err),
          );
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

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Not an initialize request and no valid session
    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  } catch (err) {
    logError("mcp_request_error", err);
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
  logInfo("proxy_starting", { port: PORT });

  // Connect to all upstreams
  upstreams = await connectAllUpstreams(config.upstreams);

  // Validate policy against discovered tools — fail fast on drift
  const toolSets: UpstreamToolSet[] = [...upstreams.entries()].map(([name, conn]) => ({
    upstream: name,
    tools: conn.tools.map((t) => t.name),
  }));
  validatePolicy(config.policy, toolSets);
  logInfo("policy_validated", {
    upstreams: toolSets.map((ts) => ts.upstream),
    totalTools: toolSets.reduce((sum, ts) => sum + ts.tools.length, 0),
    totalRules: config.policy.rules.length,
  });

  app.listen(PORT, () => {
    logInfo("proxy_listening", { port: PORT });
  });
}

// --- Graceful shutdown ---
process.on("SIGTERM", async () => {
  logInfo("proxy_shutting_down");
  await disconnectAll(upstreams);
  process.exit(0);
});

process.on("SIGINT", async () => {
  logInfo("proxy_shutting_down");
  await disconnectAll(upstreams);
  process.exit(0);
});

start().catch((err) => {
  logError("proxy_start_failed", err);
  process.exit(1);
});
