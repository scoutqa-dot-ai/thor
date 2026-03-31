/**
 * MCP client connection to a single upstream server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyConfig } from "./config.js";
import { createLogger, logInfo, logError } from "@thor/common";

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

  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to upstream MCP server at ${config.upstream.url}: ${msg}`);
  }
  logInfo(log, "upstream_connected", { url: config.upstream.url });

  // Crash on upstream disconnect — Docker restart policy will recover.
  client.onclose = () => {
    logError(log, "upstream_disconnected", "upstream closed unexpectedly", {
      url: config.upstream.url,
    });
    process.exit(1);
  };

  let tools: Tool[];
  try {
    ({ tools } = await client.listTools());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Connected to ${config.upstream.url} but failed to list tools: ${msg}`);
  }
  logInfo(log, "upstream_tools_listed", {
    toolCount: tools.length,
    tools: tools.map((t) => t.name),
  });

  return { client, tools };
}
