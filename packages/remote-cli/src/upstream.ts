import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logError, logInfo } from "@thor/common";
import { createKaliApiMcpClient, KALI_API_TOOLS } from "./kali-api-upstream.js";
import { SecretStdioClientTransport, type StdioSecretInput } from "./secret-stdio-transport.js";
import { mcpJsonSchemaValidator } from "./mcp-schema-validation.js";

const log = createLogger("mcp");

// Inventory is observational but endpoint-specific work must finish even on empty unique pages.
const MCP_INVENTORY_MAX_PAGES = 128;

const ONEPASSWORD_BROWSER_MCP_ENTRY = "/app/packages/onepassword-browser-mcp/dist/index.js";
export const ONEPASSWORD_BROWSER_TOKEN_FILE = "/run/secrets/thor-onepassword-service-account-token";

const ONEPASSWORD_BROWSER_SANDBOX_ARGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--new-session",
  "--die-with-parent",
  "--setenv",
  "PATH",
  "/usr/local/bin:/usr/bin:/bin",
  "--setenv",
  "HOME",
  "/tmp",
  "--setenv",
  "XDG_CACHE_HOME",
  "/tmp/cache",
  "--setenv",
  "XDG_CONFIG_HOME",
  "/tmp/config",
  "--ro-bind",
  "/app",
  "/app",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind",
  "/bin",
  "/bin",
  "--ro-bind",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--ro-bind",
  "/etc/ssl",
  "/etc/ssl",
  "--ro-bind-try",
  "/etc/fonts",
  "/etc/fonts",
  "--ro-bind-try",
  "/etc/chromium",
  "/etc/chromium",
  "--ro-bind-try",
  "/etc/chromium.d",
  "/etc/chromium.d",
  "--ro-bind-try",
  "/etc/resolv.conf",
  "/etc/resolv.conf",
  "--ro-bind-try",
  "/etc/nsswitch.conf",
  "/etc/nsswitch.conf",
  "--ro-bind-try",
  "/etc/hosts",
  "/etc/hosts",
  "--ro-bind-try",
  "/etc/passwd",
  "/etc/passwd",
  "--ro-bind-try",
  "/etc/group",
  "/etc/group",
  "--ro-bind-try",
  "/sys",
  "/sys",
  // A fresh proc mount is rejected on container kernels with masked paths.
  // The user/PID namespaces and credential-free child environment prevent the
  // browser from reading remote-cli's service secrets through procfs.
  "--bind",
  "/proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  // The transport writes the service-account token through anonymous fd 3.
  // bwrap copies it into private tmpfs; broker startup consumes and unlinks it.
  "--tmpfs",
  "/run",
  "--dir",
  "/run/secrets",
  "--file",
  "3",
  ONEPASSWORD_BROWSER_TOKEN_FILE,
  "/usr/local/bin/node",
  ONEPASSWORD_BROWSER_MCP_ENTRY,
] as const;

export type UpstreamConfig =
  | {
      kind: "http";
      url: string;
      headers?: Record<string, string>;
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

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

/** Resolve the trusted broker child without placing its token in env or argv. */
export function resolveOnePasswordBrowserUpstream(
  env: NodeJS.ProcessEnv = process.env,
): UpstreamConfig | undefined {
  const serviceAccountToken = envValue(env, "OP_SERVICE_ACCOUNT_TOKEN");
  const vaultId = envValue(env, "ONEPASSWORD_BROWSER_VAULT_ID");
  if (!serviceAccountToken && !vaultId) return undefined;
  if (!serviceAccountToken || !vaultId) {
    const missing = [
      !serviceAccountToken ? "OP_SERVICE_ACCOUNT_TOKEN" : undefined,
      !vaultId ? "ONEPASSWORD_BROWSER_VAULT_ID" : undefined,
    ].filter((name): name is string => Boolean(name));
    throw new Error(
      `partial onepassword browser bundle: missing ${missing.join(", ")}. Set OP_SERVICE_ACCOUNT_TOKEN and ONEPASSWORD_BROWSER_VAULT_ID together, or neither of them.`,
    );
  }

  return {
    kind: "stdio",
    command: "bwrap",
    args: [...ONEPASSWORD_BROWSER_SANDBOX_ARGS],
    env: {
      OP_SERVICE_ACCOUNT_TOKEN_FILE: ONEPASSWORD_BROWSER_TOKEN_FILE,
      ONEPASSWORD_BROWSER_VAULT_ID: vaultId,
    },
    secretInput: { fd: 3, getContents: () => serviceAccountToken },
  };
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

  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    ...config.headers,
  };
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
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
      pages += 1;
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 2000 || (cursor && (pages >= MCP_INVENTORY_MAX_PAGES || seen.has(cursor))))
        throw new Error("MCP inventory unsupported: pagination");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { client, tools };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error("MCP upstream unavailable: connection or inventory failed");
  } finally {
    signal?.removeEventListener("abort", cancelConnection);
  }
}
