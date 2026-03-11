import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logInfo, logError } from "@thor/common";
import { execGit } from "./git.js";

const log = createLogger("git-mcp");

const PORT = parseInt(process.env.PORT || "3004", 10);
const GITHUB_PAT = process.env.GITHUB_PAT;
const GIT_MCP_DEFAULT_CWD =
  process.env.GIT_MCP_DEFAULT_CWD || "/workspace/repos/acme-project";

if (!GITHUB_PAT) {
  logError(log, "missing_env", "GITHUB_PAT is required");
  process.exit(1);
}

// --- Tool definitions ---

const tools: Tool[] = [
  {
    name: "git",
    description:
      "Run a git command. The PAT is injected automatically for HTTPS auth. " +
      'Examples: ["status"], ["log", "--oneline", "-10"], ["commit", "-m", "fix typo"].',
    inputSchema: {
      type: "object" as const,
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Git command arguments (e.g. ["status"], ["push", "origin", "agent/fix-bug"])',
        },
        cwd: {
          type: "string",
          description: `Working directory for the command. Defaults to ${GIT_MCP_DEFAULT_CWD}.`,
        },
      },
      required: ["args"],
    },
  },
];

// --- Tool handler ---

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (name !== "git") {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const gitArgs = args.args as string[];
  if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
    return {
      content: [{ type: "text" as const, text: "args must be a non-empty string array" }],
      isError: true,
    };
  }

  const cwd = typeof args.cwd === "string" ? args.cwd : GIT_MCP_DEFAULT_CWD;

  const result = await execGit(gitArgs, cwd, GITHUB_PAT);

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  return {
    content: [
      {
        type: "text" as const,
        text:
          result.exitCode === 0
            ? output || "(no output)"
            : `exit code ${result.exitCode}\n${output}`,
      },
    ],
    isError: result.exitCode !== 0,
  };
}

// --- MCP Server ---

function createGitMcpServer(): Server {
  const server = new Server(
    { name: "thor-git-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      return await handleToolCall(toolName, toolArgs);
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
  res.json({ status: "ok", service: "git-mcp", tools: tools.length });
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
      const server = createGitMcpServer();

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
  logInfo(log, "git_mcp_listening", { port: PORT, defaultCwd: GIT_MCP_DEFAULT_CWD });
});
