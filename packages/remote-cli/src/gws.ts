import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ExecResult } from "@thor/common";
import { execCommand } from "./exec.js";
import type { GwsAccessToken } from "./gws-oauth.js";
import { isGwsPublicDiscoveryCommand } from "./gws-args.js";

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute);
const ConfigSchema = z.object({
  configDir: AbsolutePathSchema,
  projectId: z.string().optional(),
  path: z.string().optional(),
});

type GwsResponse = { readonly status: 200 | 503; readonly result: ExecResult };

export interface GwsServiceDeps {
  /** Trusted fixture-only discovery cache copied into each isolated execution. */
  readonly discoveryCacheSeedDir?: string;
}

/** Runs a parsed upstream gws command with the active Slack requester's broker-issued token. */
export interface IGwsService {
  /** Returns configuration failures as an ExecResult, without exposing credential contents. */
  execute(args: string[], accessToken: GwsAccessToken): Promise<GwsResponse>;
  /** Optional public discovery capability; it never executes an account operation. */
  executePublicDiscovery?(args: string[]): Promise<GwsResponse>;
}

/** Owns the private cwd and reduced child environment for upstream execution. */
export class GwsService implements IGwsService {
  private readonly config: ReturnType<typeof ConfigSchema.safeParse>;
  private readonly discoveryCacheSeedDir: string | undefined;

  constructor(env: NodeJS.ProcessEnv, deps: GwsServiceDeps = {}) {
    this.discoveryCacheSeedDir = deps.discoveryCacheSeedDir;
    this.config = ConfigSchema.safeParse({
      configDir: env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR?.trim() || "/var/lib/remote-cli/gws",
      projectId: env.GOOGLE_WORKSPACE_PROJECT_ID?.trim() || undefined,
      path: env.PATH,
    });
  }

  /** Run one command with only its owner's refreshed and verified short-lived access token. */
  async execute(args: string[], accessToken: GwsAccessToken): Promise<GwsResponse> {
    return this.#executeInPrivateDirectory(args, accessToken);
  }

  /** CLI help/schema only; no broker or ambient credential is provided. */
  async executePublicDiscovery(args: string[]): Promise<GwsResponse> {
    if (!isGwsPublicDiscoveryCommand(args))
      return unavailable("Google Workspace public discovery cannot execute account operations.");
    return this.#executeInPrivateDirectory(args);
  }

  async #executeInPrivateDirectory(
    args: string[],
    accessToken?: GwsAccessToken,
  ): Promise<GwsResponse> {
    if (!this.config.success) {
      return unavailable(
        "Google Workspace configuration is invalid; ask an operator to check the private execution path.",
      );
    }
    const config = this.config.data;
    let executionDir: string | undefined;
    try {
      await mkdir(config.configDir, { recursive: true, mode: 0o700 });
      executionDir = await mkdtemp(join(config.configDir, "execution-"));
      if (this.discoveryCacheSeedDir) {
        await cp(this.discoveryCacheSeedDir, join(executionDir, "cache"), { recursive: true });
      }
    } catch {
      if (executionDir) {
        await rm(executionDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return unavailable(
        "Google Workspace private storage is unavailable; ask an operator to check mounts and permissions.",
      );
    }
    if (!executionDir) {
      return unavailable("Google Workspace private execution storage is unavailable.");
    }

    try {
      // gws loads dotenv and credentials from its cwd/config ancestors. Use a fresh
      // empty directory and inject only the single-use access token.
      const result = await execCommand("gws", args, executionDir, {
        envMode: "replace",
        env: {
          PATH: config.path,
          HOME: executionDir,
          GOOGLE_WORKSPACE_CLI_CONFIG_DIR: executionDir,
          GOOGLE_WORKSPACE_CLI_TOKEN: accessToken?.reveal(),
          GOOGLE_WORKSPACE_PROJECT_ID: config.projectId,
        },
      });
      return { status: 200, result };
    } finally {
      await rm(executionDir, { recursive: true, force: true });
    }
  }
}

function unavailable(stderr: string): GwsResponse {
  return { status: 503, result: { stdout: "", stderr, exitCode: 2 } };
}
