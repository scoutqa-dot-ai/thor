// Minimal stdio MCP server used by upstream.test.ts to exercise the stdio
// transport. It names a tool after THOR_STDIO_TOOL so the test can prove that
// `config.env` reached the child, names a "LEAKED" tool if it can see
// THOR_SECRET_LEAK so the test can prove a parent-process secret did not, and
// can deliberately fail tools/list to exercise setup-failure cleanup.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function writeExitMarker() {
  if (process.env.THOR_STDIO_EXIT_MARKER) {
    writeFileSync(process.env.THOR_STDIO_EXIT_MARKER, "exited\n");
  }
}

process.on("exit", writeExitMarker);
process.on("SIGTERM", () => {
  writeExitMarker();
  process.exit(0);
});

const server = new Server(
  { name: "stdio-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.THOR_STDIO_FAIL_LIST_TOOLS) {
    throw new Error("intentional tools/list failure");
  }
  const tools = [
    { name: process.env.THOR_STDIO_TOOL ?? "default_tool", inputSchema: { type: "object" } },
  ];
  if (process.env.THOR_SECRET_LEAK) tools.push({ name: "LEAKED", inputSchema: { type: "object" } });
  return { tools };
});

await server.connect(new StdioServerTransport());
