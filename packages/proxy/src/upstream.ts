/**
 * MCP client connection to a single upstream server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("proxy");

export interface UpstreamConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface UpstreamConnection {
  client: Client;
  tools: Tool[];
}

export async function connectUpstream(
  name: string,
  config: UpstreamConfig,
  onDisconnect?: () => void,
): Promise<UpstreamConnection> {
  const client = new Client({ name: `thor-proxy-${name}`, version: "0.0.1" });

  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    ...config.headers,
  };

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });

  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to upstream MCP server "${name}" at ${config.url}: ${msg}`);
  }
  logInfo(log, "upstream_connected", { name, url: config.url });

  // Evict on disconnect so the next request triggers a reconnect.
  client.onclose = () => {
    logError(log, "upstream_disconnected", "upstream closed unexpectedly", {
      name,
      url: config.url,
    });
    onDisconnect?.();
  };

  let tools: Tool[];
  try {
    ({ tools } = await client.listTools());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Connected to "${name}" at ${config.url} but failed to list tools: ${msg}`);
  }
  logInfo(log, "upstream_tools_listed", {
    name,
    toolCount: tools.length,
    tools: tools.map((t) => t.name),
  });

  return { client, tools };
}
