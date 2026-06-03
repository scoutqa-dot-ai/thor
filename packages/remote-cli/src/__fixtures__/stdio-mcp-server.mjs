// Minimal stdio MCP server used by upstream.test.ts to exercise the stdio
// transport. It names a tool after THOR_STDIO_TOOL so the test can prove that
// `config.env` reached the child, and names a "LEAKED" tool if it can see
// THOR_SECRET_LEAK so the test can prove a parent-process secret did not.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stdio-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    { name: process.env.THOR_STDIO_TOOL ?? "default_tool", inputSchema: { type: "object" } },
  ];
  if (process.env.THOR_SECRET_LEAK) tools.push({ name: "LEAKED", inputSchema: { type: "object" } });
  return { tools };
});

await server.connect(new StdioServerTransport());
