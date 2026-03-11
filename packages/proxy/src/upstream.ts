/**
 * MCP client connection to a single upstream server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyConfig } from "./config.js";
import { createLogger, logInfo } from "@thor/common";

const log = createLogger("proxy");

export interface UpstreamConnection {
  client: Client;
  tools: Tool[];
}

export async function connectUpstream(config: ProxyConfig): Promise<UpstreamConnection> {
  const client = new Client({ name: "thor-proxy", version: "0.0.1" });

  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    ...config.upstream.headers,
  };

  const transport = new StreamableHTTPClientTransport(new URL(config.upstream.url), {
    requestInit: { headers },
  });

  await client.connect(transport);
  logInfo(log, "upstream_connected", { url: config.upstream.url });

  const { tools } = await client.listTools();
  logInfo(log, "upstream_tools_listed", {
    toolCount: tools.length,
    tools: tools.map((t) => t.name),
  });

  return { client, tools };
}
