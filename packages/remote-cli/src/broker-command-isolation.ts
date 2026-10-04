import { existsSync } from "node:fs";
import type { ExecResult } from "@thor/common";

const environmentKeys: Readonly<Record<string, readonly string[]>> = {
  git: [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_BOT_ID",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "GITHUB_APP_DIR",
    "GITHUB_API_URL",
  ],
  gh: [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_BOT_ID",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "GITHUB_APP_DIR",
    "GITHUB_API_URL",
  ],
  gws: [
    "GOOGLE_WORKSPACE_CLI_TOKEN",
    "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
    "GOOGLE_WORKSPACE_PROJECT_ID",
  ],
  scoutqa: ["SCOUT_API_KEY"],
  langfuse: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"],
  ldcli: ["LD_ACCESS_TOKEN", "LD_BASE_URI", "LD_PROJECT", "LD_ENVIRONMENT"],
};
const binaryPaths: Readonly<Record<string, string>> = {
  git: "/usr/local/lib/thor/bin/git",
  gh: "/usr/local/lib/thor/bin/gh",
  gws: "/usr/local/bin/gws",
  scoutqa: "/usr/local/bin/scoutqa",
  langfuse: "/usr/local/bin/langfuse",
  ldcli: "/usr/local/bin/ldcli",
};
/** A parsed broker command grants only its integration's environment and explicit mount set. */
export type BrokerCommandLaunch =
  | {
      readonly ok: true;
      readonly binary: string;
      readonly args: string[];
      readonly env: NodeJS.ProcessEnv;
    }
  | { readonly ok: false; readonly result: ExecResult };

/** Build a capability-free filesystem/PID sandbox; never bind broker secrets, catalog or parent procfs. */
export function prepareBrokerCommand(
  binary: string,
  args: string[],
  cwd: string,
  source: NodeJS.ProcessEnv,
): BrokerCommandLaunch {
  if (!Object.hasOwn(binaryPaths, binary))
    return {
      ok: false,
      result: { stdout: "", stderr: "Broker command denied: unsupported binary", exitCode: 1 },
    };
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/lib/thor/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/thor",
    LANG: "C.UTF-8",
  };
  for (const key of environmentKeys[binary]) if (source[key] !== undefined) env[key] = source[key];
  if (binary === "gws") env.HOME = cwd;
  const mounts = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
  ];
  for (const path of [
    "/app",
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/passwd",
    "/etc/group",
  ]) {
    if (existsSync(path)) mounts.push("--ro-bind", path, path);
  }
  for (const path of ["/workspace", "/tmp", "/home/thor"])
    if (existsSync(path)) mounts.push("--bind", path, path);
  if (binary === "git" || binary === "gh") {
    // Legacy GitHub App wrappers retain their dedicated key/cache, never another integration's secrets.
    const keyRoot = "/var/lib/remote-cli/github-app";
    if (existsSync(keyRoot)) mounts.push("--bind", keyRoot, keyRoot);
  }
  if (binary === "gws") mounts.push("--bind", cwd, cwd);
  mounts.push("--proc", "/proc", "--dev", "/dev", "--chdir", cwd, binaryPaths[binary], ...args);
  return { ok: true, binary: "/usr/bin/bwrap", args: mounts, env };
}

let isolationEnabled = false;
/** Production composition enables isolation before any listener/command; no request/env can disable it. */
export function enableBrokerCommandIsolation(): void {
  isolationEnabled = true;
}
/** Component exec tests run without container paths; deployed startup always enables the protected launcher. */
export function resolveBrokerCommand(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): BrokerCommandLaunch {
  return isolationEnabled
    ? prepareBrokerCommand(binary, args, cwd, env)
    : { ok: true, binary, args, env };
}
