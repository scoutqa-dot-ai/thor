import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ImageContent,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from "@slack/web-api";
import { createLogger, logInfo, logError } from "@thor/common";
import {
  postMessage,
  readThread,
  getChannelHistory,
  readSlackFile,
  type SlackDeps,
  type SlackFileReadResult,
} from "./slack.js";

const log = createLogger("slack-mcp");

const PORT = parseInt(process.env.PORT || "3003", 10);
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

if (!SLACK_BOT_TOKEN) {
  logError(log, "missing_env", "SLACK_BOT_TOKEN is required");
  process.exit(1);
}

const slackDeps: SlackDeps = {
  client: new WebClient(SLACK_BOT_TOKEN),
  token: SLACK_BOT_TOKEN,
  fetchFn: fetch,
};

// --- Tool definitions ---

const tools: Tool[] = [
  {
    name: "post_message",
    description: "Post a message to a Slack channel or thread. Use thread_ts to reply in a thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel ID (e.g. C0123456789)" },
        text: { type: "string", description: "Message text (supports Slack mrkdwn)" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to reply in (optional)",
        },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "read_thread",
    description: "Read all replies in a Slack thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel ID" },
        thread_ts: { type: "string", description: "Thread timestamp (the parent message ts)" },
        limit: {
          type: "number",
          description: "Max number of replies to return (default 50, max 200)",
        },
      },
      required: ["channel", "thread_ts"],
    },
  },
  {
    name: "get_channel_history",
    description: "Read recent messages from a Slack channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel ID" },
        limit: {
          type: "number",
          description: "Max number of messages to return (default 20, max 100)",
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "get_slack_file",
    description:
      "Fetch a Slack file by file_id. Returns text content for text-like files or image content for photos.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "Slack file ID (e.g. F0123456789)" },
        max_bytes: {
          type: "number",
          description: "Maximum file size to download in bytes (default 5000000, max 20000000)",
        },
      },
      required: ["file_id"],
    },
  },
];

// --- Tool handler ---

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  switch (name) {
    case "post_message": {
      const channel = String(args.channel);
      const text = String(args.text);
      const threadTs = args.thread_ts ? String(args.thread_ts) : undefined;
      const result = await postMessage(channel, text, threadTs, slackDeps);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ts: result.ts, channel: result.channel }),
          },
        ],
      };
    }

    case "read_thread": {
      const channel = String(args.channel);
      const threadTs = String(args.thread_ts);
      const limit = Math.min(Number(args.limit) || 50, 200);
      const messages = await readThread(channel, threadTs, limit, slackDeps);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(messages) }],
      };
    }

    case "get_channel_history": {
      const channel = String(args.channel);
      const limit = Math.min(Number(args.limit) || 20, 100);
      const messages = await getChannelHistory(channel, limit, slackDeps);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(messages) }],
      };
    }

    case "get_slack_file": {
      const fileId = String(args.file_id);
      const maxBytes = Math.min(Number(args.max_bytes) || 5_000_000, 20_000_000);
      const file = await readSlackFile(fileId, maxBytes, slackDeps);
      return {
        content: toSlackFileToolContent(file),
      };
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

function toSlackFileToolContent(file: SlackFileReadResult): CallToolResult["content"] {
  const metadata = {
    file: file.file,
    kind: file.kind,
    ...(file.kind === "text"
      ? { truncated: file.truncated, source: file.source }
      : { mimeType: file.mimeType }),
  };

  if (file.kind === "image") {
    const image: ImageContent = {
      type: "image",
      data: file.data,
      mimeType: file.mimeType,
    };

    return [{ type: "text" as const, text: JSON.stringify(metadata) }, image];
  }

  return [
    { type: "text" as const, text: JSON.stringify(metadata) },
    { type: "text" as const, text: file.text },
  ];
}

// --- MCP Server ---

function createSlackMcpServer(): Server {
  const server = new Server(
    { name: "thor-slack-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      return await handleToolCall(toolName, args);
    } catch (err) {
      logError(log, "tool_call_error", err instanceof Error ? err.message : String(err), {
        tool: toolName,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// --- Express app ---

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "slack-mcp", tools: tools.length });
});

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
      const server = createSlackMcpServer();

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
  logInfo(log, "slack_mcp_listening", { port: PORT, tools: tools.map((t) => t.name) });
});
