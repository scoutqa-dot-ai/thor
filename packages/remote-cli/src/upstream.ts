import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logError, logInfo, logWarn, type ProxyUpstream } from "@thor/common";

const log = createLogger("mcp");

export type UpstreamConfig = ProxyUpstream;

export interface UpstreamConnection {
  client: Client;
  tools: Tool[];
}

/**
 * A stable, transport-agnostic descriptor for logs and error messages. For stdio
 * the full argv (a long bwrap line) is summarized to keep logs scannable; the
 * accompanying targetKey/profile fields disambiguate which upstream it is.
 */
export function upstreamTarget(config: UpstreamConfig): string {
  return config.kind === "stdio" ? `${config.command} (+${config.args.length} args)` : config.url;
}

function createTransport(config: UpstreamConfig): Transport {
  if (config.kind === "stdio") {
    // The SDK spawns with `{ ...getDefaultEnvironment(), ...config.env }`. Its
    // default is a fixed safe allowlist (HOME, LOGNAME, PATH, SHELL, TERM, USER)
    // — remote-cli's secrets (THOR_INTERNAL_SECRET, the GitHub App key path,
    // other integration credentials) are never on it, so they never reach the
    // child. PATH is inherited so the child can resolve `command`.
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: { Accept: "application/json, text/event-stream", ...config.headers },
    },
  });
}

export async function connectUpstream(
  name: string,
  config: UpstreamConfig,
  onDisconnect?: () => void,
): Promise<UpstreamConnection> {
  const client = new Client({ name: `thor-remote-cli-${name}`, version: "0.0.1" });
  const target = upstreamTarget(config);
  const transport = createTransport(config);

  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to upstream MCP server "${name}" at ${target}: ${msg}`);
  }
  logInfo(log, "upstream_connected", { name, transport: config.kind, target });

  let tools: Tool[];
  try {
    ({ tools } = await client.listTools());
  } catch (err) {
    await client.close().catch((closeErr) => {
      logError(
        log,
        "upstream_close_failed",
        closeErr instanceof Error ? closeErr.message : String(closeErr),
        { name, target },
      );
    });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Connected to "${name}" at ${target} but failed to list tools: ${msg}`);
  }

  client.onclose = () => {
    logWarn(log, "upstream_disconnected", {
      name,
      target,
      willReconnect: !!onDisconnect,
    });
    onDisconnect?.();
  };
  logInfo(log, "upstream_tools_listed", {
    name,
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name),
  });

  return { client, tools };
}
