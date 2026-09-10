// Proves that the secure stdio transport delivers a one-shot secret on fd 3
// without copying it into the child process environment.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const fixtureSecret = "secret-fd-fixture";
const receivedSecret = readFileSync(3, "utf8");
const environmentContainsSecret = Object.values(process.env).some((value) =>
  value?.includes(fixtureSecret),
);

const server = new Server(
  { name: "secret-stdio-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name:
        receivedSecret === fixtureSecret && !environmentContainsSecret
          ? "secret_received_outside_env"
          : "SECRET_DELIVERY_FAILED",
      inputSchema: { type: "object" },
    },
  ],
}));

await server.connect(new StdioServerTransport());
