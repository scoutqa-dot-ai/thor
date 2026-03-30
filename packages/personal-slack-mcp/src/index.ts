/**
 * Personal Slack MCP — read-only Slack access via user token (xoxp-).
 *
 * Exposes 8 read-only tools over streamable HTTP MCP transport.
 * No write operations (no post_message, no reactions, no approvals).
 *
 * Security:
 * - Token loaded from PERSONAL_SLACK_TOKEN env var only
 * - Token is NEVER logged (pino redaction not needed — we never pass it to logger)
 * - No channel allowlist — scoped by user token permissions
 * - Bound to 127.0.0.1 in docker-compose (not publicly accessible)
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger, logInfo, logError } from "@thor/common";
import { createSlackDeps } from "./slack-client.js";
import { createPersonalSlackMcpServer, tools } from "./server.js";

const log = createLogger("personal-slack-mcp");

const PORT = parseInt(process.env.PORT || "3020", 10);
const PERSONAL_SLACK_TOKEN = process.env.PERSONAL_SLACK_TOKEN;

if (!PERSONAL_SLACK_TOKEN) {
  logError(log, "missing_env", "PERSONAL_SLACK_TOKEN is required");
  process.exit(1);
}

if (!PERSONAL_SLACK_TOKEN.startsWith("xoxp-") && !PERSONAL_SLACK_TOKEN.startsWith("xoxe.xoxp-")) {
  logError(log, "invalid_token", "PERSONAL_SLACK_TOKEN must be a user token (xoxp-)");
  process.exit(1);
}

const slackDeps = createSlackDeps(PERSONAL_SLACK_TOKEN);

// --- Express app ---

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "personal-slack-mcp", tools: tools.length });
});

// --- MCP transport ---

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const body = req.body;
    if (body?.method === "initialize") {
      const newSessionId = randomUUID();
      const server = createPersonalSlackMcpServer(slackDeps);

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
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

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

app.listen(PORT, () => {
  logInfo(log, "personal_slack_mcp_listening", {
    port: PORT,
    tools: tools.map((t) => t.name),
    mode: "read-only",
  });
});
