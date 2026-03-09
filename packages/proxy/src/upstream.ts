/**
 * Manages MCP client connections to upstream (downstream from proxy's perspective) servers.
 * Each upstream in the config gets its own Client instance.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig } from "./config.js";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("proxy");

export interface UpstreamConnection {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Tool[];
}

/**
 * Connect to a single upstream MCP server.
 */
export async function connectUpstream(
  name: string,
  config: UpstreamConfig,
): Promise<UpstreamConnection> {
  const client = new Client({ name: `thor-proxy/${name}`, version: "0.0.1" });

  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    ...config.headers,
  };

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });

  await client.connect(transport);
  logInfo(log, "upstream_connected", { upstream: name, url: config.url });

  // Fetch available tools
  const { tools } = await client.listTools();
  logInfo(log, "upstream_tools_listed", {
    upstream: name,
    toolCount: tools.length,
    tools: tools.map((t) => t.name),
  });

  return { name, client, transport, tools };
}

/**
 * Connect to all configured upstreams. Returns a map of name -> connection.
 */
export async function connectAllUpstreams(
  upstreams: Record<string, UpstreamConfig>,
): Promise<Map<string, UpstreamConnection>> {
  const connections = new Map<string, UpstreamConnection>();

  for (const [name, config] of Object.entries(upstreams)) {
    try {
      const conn = await connectUpstream(name, config);
      connections.set(name, conn);
    } catch (err) {
      logError(log, "upstream_connect_failed", err, { upstream: name });
      throw err;
    }
  }

  return connections;
}

/**
 * Disconnect all upstream connections.
 */
export async function disconnectAll(connections: Map<string, UpstreamConnection>): Promise<void> {
  for (const [name, conn] of connections) {
    try {
      await conn.client.close();
      logInfo(log, "upstream_disconnected", { upstream: name });
    } catch (err) {
      logError(log, "upstream_disconnect_failed", err, { upstream: name });
    }
  }
}
