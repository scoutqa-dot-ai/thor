import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ExecResult } from "@thor/common";
import { execCommand } from "./exec.ts";
import type { GwsCommand } from "./policy-gws.ts";

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute);
const ConfigSchema = z.object({
  credentialsFile: AbsolutePathSchema.optional(),
  configDir: AbsolutePathSchema,
  projectId: z.string().optional(),
  path: z.string().optional(),
});

type GwsResponse = { readonly status: 200 | 503; readonly result: ExecResult };

/** Executes only parsed commands; configuration and credentials stay server-side. */
export interface IGwsService {
  /** Returns configuration failures as an ExecResult, without exposing credential contents. */
  execute(command: GwsCommand): Promise<GwsResponse>;
}

/** Owns the private working directory and credential availability for upstream gws. */
export class GwsService implements IGwsService {
  private readonly config: ReturnType<typeof ConfigSchema.safeParse>;

  constructor(env: NodeJS.ProcessEnv) {
    this.config = ConfigSchema.safeParse({
      credentialsFile: env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?.trim() || undefined,
      configDir: env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR?.trim() || "/var/lib/remote-cli/gws",
      projectId: env.GOOGLE_WORKSPACE_PROJECT_ID?.trim() || undefined,
      path: env.PATH,
    });
  }

  /** Help/schema work without credentials; API reads fail closed when credentials are unavailable. */
  async execute(command: GwsCommand): Promise<GwsResponse> {
    if (!this.config.success) {
      return unavailable(
        "Google Workspace configuration is invalid; ask an operator to check the private credential and config paths.",
      );
    }
    const config = this.config.data;
    if (command.requiresCredentials && !config.credentialsFile) {
      return unavailable(
        "Google Workspace is not configured; ask an operator to configure read access.",
      );
    }
    try {
      await mkdir(config.configDir, { recursive: true, mode: 0o700 });
      if (command.requiresCredentials && config.credentialsFile) {
        await access(config.credentialsFile, constants.R_OK);
        if (!(await stat(config.credentialsFile)).isFile()) {
          return unavailable(
            "Google Workspace credentials must be a readable file; ask an operator to check the credential mount.",
          );
        }
      }
    } catch {
      return unavailable(
        "Google Workspace private storage or credentials are unavailable; ask an operator to check mounts and permissions.",
      );
    }

    // gws loads dotenv from cwd/ancestors. This directory and its ancestors are
    // operator-controlled, never a repo, shared workspace, or shared /tmp.
    const result = await execCommand("gws", command.args, config.configDir, {
      envMode: "replace",
      env: {
        PATH: config.path,
        HOME: config.configDir,
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config.configDir,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: config.credentialsFile,
        GOOGLE_WORKSPACE_PROJECT_ID: config.projectId,
      },
    });
    return { status: 200, result };
  }
}

function unavailable(stderr: string): GwsResponse {
  return { status: 503, result: { stdout: "", stderr, exitCode: 2 } };
}
