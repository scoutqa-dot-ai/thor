import express from "express";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
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
const calls = [];
const dummyPrincipals = new Map([
  ["Bearer dummy-private-token-first", "first"],
  ["Bearer dummy-private-token-replacement", "replacement"],
]);
const teamId = process.env.MCP_FIXTURE_TEAM ?? "TFIXTURE";
const userId = process.env.MCP_FIXTURE_USER ?? "UFIXTURE";
app.get("/health", (_req, res) => res.json({ effects, connections, cards, calls }));
app.post("/slack/:method", (req, res) => {
  if (req.get("authorization") !== "Bearer dummy-slack-token") return res.status(401).end();
  switch (req.params.method) {
    case "auth.test":
      return res.json({ ok: true, team_id: teamId });
    case "conversations.open":
      return res.json({ ok: true, channel: { id: "DFIXTURE" } });
    case "conversations.info":
      return res.json({ ok: true, channel: { id: "DFIXTURE", is_im: true, user: userId } });
    case "chat.postMessage":
      cards.push(req.body);
      return res.json({ ok: true, channel: "DFIXTURE", ts: "1710000000.123" });
    default:
      return res.json({ ok: false });
  }
});
// TLS token rotation is opt-in for the Pi fixture; record only safe principal labels.
app.use("/mcp", (req, res, next) => {
  if (!req.socket.encrypted) return next();
  if (!dummyPrincipals.has(req.get("authorization"))) return res.status(401).end();
  next();
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
      description: "Untrusted fixture tool description",
      _meta: { private: "dummy-private-tool-meta" },
      annotations: { title: "dummy-private-annotation", readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    })),
  }));
  sdk.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    effects++;
    calls.push({
      name: params.name,
      arguments: params.arguments,
      // Installed SDK supplies the actual call request, not the initialization header.
      principal: dummyPrincipals.get(extra.requestInfo?.headers.authorization) ?? "none",
    });
    // Deliberately hold AFTER the effect, to expose native unsafe recovery on runner SIGKILL.
    if (params.arguments.text === "native-crash") await new Promise(() => {});
    if (params.arguments.text === "native-structured")
      return { content: [], structuredContent: { echoed: "native-structured" } };
    if (params.arguments.text === "native-error")
      return { isError: true, content: [{ type: "text", text: "Confirmed fixture error" }] };
    if (params.arguments.text === "native-image")
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8AAQVDqPwMDAEHSBfsl0XwmAAAAAElFTkSuQmCC",
          },
        ],
      };
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
if (process.env.MCP_FIXTURE_TLS === "1")
  createServer(
    {
      key: readFileSync("/fixture-tls/key.pem"),
      cert: readFileSync("/fixture-ca/cert.pem"),
    },
    app,
  ).listen(8001, "0.0.0.0");
