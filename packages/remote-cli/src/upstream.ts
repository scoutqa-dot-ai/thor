import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logError, logInfo } from "@thor/common";
import { createKaliApiMcpClient, KALI_API_TOOLS } from "./kali-api-upstream.js";
import { SecretStdioClientTransport, type StdioSecretInput } from "./secret-stdio-transport.js";
import { mcpJsonSchemaValidator } from "./mcp-schema-validation.js";
import type { McpBearerCredential } from "./mcp-catalog-files.js";
import { createPinnedMcpFetch } from "./mcp-http-transport.js";
export {
  resolveOnePasswordBrowserUpstream,
  ONEPASSWORD_BROWSER_TOKEN_FILE,
} from "./managed-browser-upstream.js";

const log = createLogger("mcp");

// Inventory is observational but endpoint-specific work must finish even on empty unique pages.
const MCP_INVENTORY_MAX_PAGES = 128;

export type UpstreamConfig =
  | {
      kind: "http";
      url: string;
      headers?: Record<string, string>;
      bearer?: McpBearerCredential;
    }
  | {
      kind: "kali-api";
      url: string;
    }
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      secretInput: StdioSecretInput;
    };

/** Private upstream transport owner; the broker translates rejected call promises into uncertainty. */
export interface UpstreamClient {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

/** A connection inventory is immutable for its broker revision and discarded on disconnect/change. */
export interface UpstreamConnection {
  client: UpstreamClient;
  tools: Tool[];
}

function createTransport(config: Exclude<UpstreamConfig, { kind: "kali-api" }>): Transport {
  if (config.kind === "stdio") {
    return new SecretStdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      secretInput: config.secretInput,
    });
  }

  return new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: createPinnedMcpFetch(config),
    // The broker, not the SDK SSE resume loop, owns inventory revalidation on reconnect.
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 30000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1.5,
    },
  });
}

/** Collect at most 128 inventory pages / 2,000 tools; shutdown cancels SDK initialization and listing. */
export async function connectUpstream(
  name: string,
  config: UpstreamConfig,
  onDisconnect?: () => void,
  signal?: AbortSignal,
): Promise<UpstreamConnection> {
  if (config.kind === "kali-api") {
    const client = await createKaliApiMcpClient({ baseUrl: config.url });
    logInfo(log, "upstream_connected", { name, transport: config.kind });
    return { client, tools: KALI_API_TOOLS };
  }

  const client = new Client(
    { name: `thor-remote-cli-${name}`, version: "0.0.1" },
    { jsonSchemaValidator: mcpJsonSchemaValidator },
  );
  const transport = createTransport(config);
  client.onerror = () => {
    onDisconnect?.();
    void client.close().catch(() => undefined);
  };

  const cancelConnection = () => {
    void client.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelConnection, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(transport, { signal });
    logInfo(log, "upstream_connected", { name, transport: config.kind });

    client.onclose = () => {
      logError(log, "upstream_disconnected", "upstream closed unexpectedly", { name });
      onDisconnect?.();
    };

    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      // An inventory change revokes the old connection snapshot before any subsequent dispatch.
      onDisconnect?.();
      await client.close();
    });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      signal?.throwIfAborted();
      const page = await client.listTools(cursor ? { cursor } : {}, { signal });
      if (
        config.kind === "http" &&
        config.bearer &&
        JSON.stringify(page).includes(config.bearer.reveal())
      )
        throw new Error("MCP credential reflection denied");
      pages += 1;
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 2000 || (cursor && (pages >= MCP_INVENTORY_MAX_PAGES || seen.has(cursor))))
        throw new Error("MCP inventory unsupported: pagination");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return {
      client: {
        callTool: async (input) => {
          const result = await client.callTool(input);
          if (config.kind === "http" && config.bearer) {
            // Generic bearer vendor errors are diagnostics, not an opportunity to reflect headers.
            if ("isError" in result && result.isError === true)
              return {
                isError: true,
                content: [{ type: "text", text: "MCP tool reported an error." }],
              };
            if (JSON.stringify(result).includes(config.bearer.reveal()))
              throw new Error("MCP credential reflection denied");
          }
          return result;
        },
        close: async () => {
          if (transport instanceof StreamableHTTPClientTransport) {
            // Abort bounded teardown even when an offline server never answers DELETE.
            const timer = setTimeout(() => {
              void client.close();
            }, 2000).unref();
            try {
              await transport.terminateSession();
            } catch {
              /* safe teardown failure */
            } finally {
              clearTimeout(timer);
            }
          }
          await client.close();
        },
      },
      tools,
    };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error("MCP upstream unavailable: connection or inventory failed");
  } finally {
    signal?.removeEventListener("abort", cancelConnection);
  }
}
