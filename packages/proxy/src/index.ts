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
import { classifyTool, validatePolicy, PolicyDriftError, PolicyOverlapError } from "./policy.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { ApprovalStore } from "./approval-store.js";
import { writeToolCallLog, createLogger, logInfo, logWarn, logError } from "@thor/common";

const log = createLogger("proxy");

const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const CONFIG_PATH =
  process.env.PROXY_CONFIG || resolve(import.meta.dirname, "../proxy.config.json");

const config: ProxyConfig = loadConfig(
  JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig,
);

let upstream: UpstreamConnection;

// Exposed tools = allow + approve (agent sees both, but approve tools are gated).
let exposedTools: Tool[] = [];

// Tools that require human approval before execution.
const approveSet = new Set<string>();

const APPROVALS_DIR = process.env.APPROVALS_DIR || "data/approvals";
const approvalStore = new ApprovalStore(APPROVALS_DIR);

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

function createProxyServer(): Server {
  const server = new Server(
    { name: "thor-proxy", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: approveSet.size > 0 ? [...exposedTools, CHECK_APPROVAL_TOOL] : exposedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    // Handle check_approval_status synthetic tool.
    if (toolName === "check_approval_status") {
      const actionId = (args as { action_id?: string }).action_id;
      if (!actionId) {
        return {
          content: [{ type: "text" as const, text: "Missing required parameter: action_id" }],
          isError: true,
        } satisfies CallToolResult;
      }
      const action = approvalStore.get(actionId);
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

    if (!exposedTools.some((t) => t.name === toolName)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      } satisfies CallToolResult;
    }

    // Approval-required tools: store request and return pending action ID.
    if (approveSet.has(toolName)) {
      const action = approvalStore.create(toolName, args);
      logInfo(log, "tool_call_pending_approval", { tool: toolName, actionId: action.id });
      writeToolCallLog({ tool: toolName, decision: "pending", args });
      return {
        content: [
          {
            type: "text" as const,
            text: `⏳ Approval required for \`${toolName}\`. Action ID: ${action.id}. Proxy-Port: ${PORT}. Use \`check_approval_status\` with this ID to check the outcome.`,
          },
        ],
        isError: false,
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
    exposedTools: exposedTools.length,
    upstreamTools: upstream?.tools.length ?? 0,
  });
});

// --- Approval resolution endpoints ---

app.get("/approval/:id", (req, res) => {
  const action = approvalStore.get(req.params.id);
  if (!action) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(action);
});

app.post("/approval/:id/resolve", async (req, res) => {
  const { decision, reviewer, reason } = req.body as {
    decision?: string;
    reviewer?: string;
    reason?: string;
  };

  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    return;
  }

  const action = approvalStore.resolve(req.params.id, decision, reviewer, reason);
  if (!action) {
    res.status(404).json({ error: "Not found or already resolved" });
    return;
  }

  if (decision === "approved") {
    // Execute the stored tool call against upstream.
    const start = Date.now();
    try {
      const result = await upstream.client.callTool({
        name: action.tool,
        arguments: action.args,
      });
      const duration = Date.now() - start;
      action.result = result;
      approvalStore.update(action);
      logInfo(log, "tool_call_approved", {
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
      approvalStore.update(action);
      logError(log, "tool_call_approved_failed", message, {
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
    logInfo(log, "tool_call_rejected", { tool: action.tool, actionId: action.id, reviewer });
    writeToolCallLog({ tool: action.tool, decision: "rejected", args: action.args });
    res.json(action);
  }
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

  const approve = config.approve ?? [];
  const allToolNames = upstream.tools.map((t) => t.name);

  // Validate allow + approve lists against upstream — detect drift and overlap
  try {
    validatePolicy(config.allow, approve, allToolNames);
  } catch (err) {
    if (err instanceof PolicyDriftError) {
      if (IS_PRODUCTION) {
        logWarn(log, "policy_drift", { orphans: err.orphans });
      } else {
        throw err;
      }
    } else if (err instanceof PolicyOverlapError) {
      // Overlap is always fatal — ambiguous policy
      throw err;
    } else {
      throw err;
    }
  }

  // Build approval set
  for (const name of approve) {
    approveSet.add(name);
  }

  // Expose both allow and approve tools (approve tools are gated at call time)
  exposedTools = upstream.tools.filter(
    (t) => classifyTool(config.allow, approve, t.name) !== "hidden",
  );

  const allowCount = config.allow.length;
  const approveCount = approve.length;

  logInfo(log, "proxy_ready", {
    upstreamTools: allToolNames.length,
    exposedTools: exposedTools.length,
    allowTools: allowCount,
    approveTools: approveCount,
    hiddenTools: allToolNames.length - exposedTools.length,
  });

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
