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
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type ProxyConfig } from "./config.js";
import { isAllowed, validatePolicy } from "./policy.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { writeToolCallLog, createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("proxy");

const PORT = parseInt(process.env.PORT || "3001", 10);
const CONFIG_PATH =
  process.env.PROXY_CONFIG || resolve(import.meta.dirname, "../proxy.config.json");

const config: ProxyConfig = loadConfig(
  JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig,
);

let upstream: UpstreamConnection;

function createProxyServer(): Server {
  const server = new Server(
    { name: "thor-proxy", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: upstream.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    if (!upstream.tools.some((t) => t.name === toolName)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      } satisfies CallToolResult;
    }

    if (!isAllowed(config.allow, toolName)) {
      logInfo(log, "tool_blocked", { tool: toolName });
      writeToolCallLog({ tool: toolName, decision: "blocked", args });
      return {
        content: [{ type: "text" as const, text: `Tool "${toolName}" is blocked by policy.` }],
        isError: true,
      } satisfies CallToolResult;
    }

    const start = Date.now();
    try {
      const result = await upstream.client.callTool({ name: toolName, arguments: args });
      const duration = Date.now() - start;
      logInfo(log, "tool_call", { tool: toolName, durationMs: duration });
      writeToolCallLog({ tool: toolName, decision: "allowed", args, result, durationMs: duration });
      return result as CallToolResult;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, { tool: toolName, durationMs: duration });
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
  res.json({
    status: "ok",
    service: "proxy",
    tools: upstream?.tools.length ?? 0,
  });
});

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (req.body?.method === "initialize") {
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

    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  } catch (err) {
    logError(log, "mcp_request_error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

// --- Startup ---
async function start(): Promise<void> {
  logInfo(log, "proxy_starting", { port: PORT });

  upstream = await connectUpstream(config);

  const toolNames = upstream.tools.map((t) => t.name);
  validatePolicy(config.allow, toolNames);
  logInfo(log, "policy_validated", { tools: toolNames.length, patterns: config.allow.length });

  app.listen(PORT, () => {
    logInfo(log, "proxy_listening", { port: PORT });
  });
}

process.on("SIGTERM", async () => {
  logInfo(log, "proxy_shutting_down");
  await upstream?.client.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logInfo(log, "proxy_shutting_down");
  await upstream?.client.close();
  process.exit(0);
});

start().catch((err) => {
  logError(log, "proxy_start_failed", err);
  process.exit(1);
});
