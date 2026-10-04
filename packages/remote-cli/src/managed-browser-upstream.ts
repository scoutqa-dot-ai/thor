import type { UpstreamConfig } from "./upstream.js";

const ONEPASSWORD_BROWSER_MCP_ENTRY = "/app/packages/onepassword-browser-mcp/dist/index.js";
export const ONEPASSWORD_BROWSER_TOKEN_FILE = "/run/secrets/thor-onepassword-service-account-token";

const ONEPASSWORD_BROWSER_SANDBOX_ARGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--new-session",
  "--die-with-parent",
  "--cap-drop",
  "ALL",
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
  // Fresh procfs in the child PID namespace: never bind the broker's /proc.
  "--proc",
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
