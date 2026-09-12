import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logError, logInfo } from "@thor/common";
import { createKaliApiMcpClient, KALI_API_TOOLS } from "./kali-api-upstream.js";
import { SecretStdioClientTransport, type StdioSecretInput } from "./secret-stdio-transport.js";

const log = createLogger("mcp");

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

export interface UpstreamClient {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

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

export function upstreamTarget(config: UpstreamConfig): string {
  return config.kind === "stdio" ? config.command : config.url;
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

export async function connectUpstream(
  name: string,
  config: UpstreamConfig,
  onDisconnect?: () => void,
): Promise<UpstreamConnection> {
  if (config.kind === "kali-api") {
    const client = await createKaliApiMcpClient({ baseUrl: config.url });
    logInfo(log, "upstream_connected", { name, target: config.url, transport: config.kind });
    logInfo(log, "upstream_tools_listed", {
      name,
      toolCount: KALI_API_TOOLS.length,
      tools: KALI_API_TOOLS.map((tool) => tool.name),
    });
    return { client, tools: KALI_API_TOOLS };
  }

  const target = upstreamTarget(config);
  const client = new Client({ name: `thor-remote-cli-${name}`, version: "0.0.1" });
  const transport = createTransport(config);

  try {
    await client.connect(transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to upstream MCP server "${name}" at ${target}: ${message}`);
  }
  logInfo(log, "upstream_connected", { name, target, transport: config.kind });

  client.onclose = () => {
    logError(log, "upstream_disconnected", "upstream closed unexpectedly", { name, target });
    onDisconnect?.();
  };

  let tools: Tool[];
  try {
    ({ tools } = await client.listTools());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Connected to "${name}" at ${target} but failed to list tools: ${message}`);
  }
  logInfo(log, "upstream_tools_listed", {
    name,
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name),
  });

  return { client, tools };
}
