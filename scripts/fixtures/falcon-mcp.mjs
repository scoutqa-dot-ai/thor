// Inert Streamable HTTP MCP fixture for CI suites that do not exercise Falcon.
// No credentials, external requests or tool execution; production still uses the pinned Falcon image.
import { createServer } from "node:http";

createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString());
    if (request.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let response;
    if (request.method === "initialize")
      response = {
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "inert-falcon-fixture", version: "1.0.0" },
        },
      };
    else if (request.method === "tools/list") response = { result: { tools: [] } };
    else if (request.method === "ping") response = { result: {} };
    else response = { error: { code: -32601, message: "Fixture exposes no operational tools" } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }));
  })().catch(() => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
}).listen(8000, "0.0.0.0");
