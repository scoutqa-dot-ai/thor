import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const app = express();
app.use(express.json());
const sessions = new Map();
let effects = 0;
let connections = 0;
const cards = [];
app.get("/health", (_req, res) => res.json({ effects, connections, cards }));
app.post("/slack/:method", (req, res) => {
  if (req.get("authorization") !== "Bearer dummy-slack-token") return res.status(401).end();
  switch (req.params.method) {
    case "auth.test":
      return res.json({ ok: true, team_id: "TFIXTURE" });
    case "conversations.open":
      return res.json({ ok: true, channel: { id: "DFIXTURE" } });
    case "conversations.info":
      return res.json({ ok: true, channel: { id: "DFIXTURE", is_im: true, user: "UFIXTURE" } });
    case "chat.postMessage":
      cards.push(req.body);
      return res.json({ ok: true, channel: "DFIXTURE", ts: "1710000000.123" });
    default:
      return res.json({ ok: false });
  }
});
app.all("/mcp", async (req, res) => {
  const id = req.get("mcp-session-id");
  if (id) {
    const transport = sessions.get(id);
    if (!transport) return res.status(404).end();
    await transport.handleRequest(req, res, req.body);
    return;
  }
  connections++;
  const sdk = new Server(
    { name: "dummy-catalog-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["echo", "write_doc", "hidden_mutation"].map((name) => ({
      name,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    })),
  }));
  sdk.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    effects++;
    return { content: [{ type: "text", text: params.arguments.text }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (id) => sessions.set(id, transport),
  });
  await sdk.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(8000, "0.0.0.0");
