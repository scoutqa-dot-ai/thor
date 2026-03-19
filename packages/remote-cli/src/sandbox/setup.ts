/**
 * Sandbox setup — configure OpenCode environment inside a Daytona sandbox.
 *
 * Uploads opencode config (no MCP, permission: allow) and auth credentials
 * so the sandbox can run OpenCode as a coding agent.
 *
 * Setup runs once per sandbox — subsequent calls for the same sandbox are skipped.
 */

import { readFileSync } from "node:fs";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-setup");

const OPENCODE_CONFIG_DIR = "/home/daytona/.config/opencode";
const OPENCODE_DATA_DIR = "/home/daytona/.local/share/opencode";
const OPENCODE_VERSION = "1.2.27";

/** Path to the host-mounted auth.json (read-only mount from opencode data volume). */
const AUTH_JSON_PATH = process.env.OPENCODE_AUTH_PATH || "/opencode-data/auth.json";

/** Track which sandboxes have been set up (skip on repeat calls). */
const setupSandboxes = new Set<string>();

/**
 * Minimal opencode.json for sandbox coding agent:
 * - No MCP servers (isolated execution)
 * - Permission: allow (agent has full file/bash access)
 */
const SANDBOX_OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  permission: "allow",
  mcp: {},
};

/**
 * Set up OpenCode inside a sandbox: install pinned version, upload config and auth.
 * Runs once per sandbox — subsequent calls are no-ops.
 */
export async function setupSandboxOpenCode(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<void> {
  if (setupSandboxes.has(sandboxId)) {
    logInfo(log, "sandbox_setup_skip", { sandboxId });
    return;
  }

  logInfo(log, "sandbox_setup_start", { sandboxId });

  // Install pinned opencode version
  const { exitCode: installExit } = await provider.executeCommand(
    sandboxId,
    `sudo npm i -g opencode-ai@${OPENCODE_VERSION}`,
  );
  if (installExit !== 0) {
    throw new Error(
      `opencode install failed in sandbox ${sandboxId} with exit code ${installExit}`,
    );
  }
  logInfo(log, "sandbox_setup_opencode_installed", { sandboxId, version: OPENCODE_VERSION });

  // Create config directories
  await provider.executeCommand(sandboxId, `mkdir -p ${OPENCODE_CONFIG_DIR} ${OPENCODE_DATA_DIR}`);

  // Upload opencode.json config
  const configBuffer = Buffer.from(JSON.stringify(SANDBOX_OPENCODE_CONFIG, null, 2));
  await provider.uploadFile(sandboxId, `${OPENCODE_CONFIG_DIR}/opencode.json`, configBuffer);

  // Upload auth.json if available — strip refresh tokens so the sandbox
  // cannot refresh and invalidate the main opencode's credentials.
  try {
    const authData = JSON.parse(readFileSync(AUTH_JSON_PATH, "utf-8"));
    const sanitized = stripRefreshFields(authData);
    await provider.uploadFile(
      sandboxId,
      `${OPENCODE_DATA_DIR}/auth.json`,
      Buffer.from(JSON.stringify(sanitized, null, 2)),
    );
    logInfo(log, "sandbox_setup_auth_uploaded", { sandboxId });
  } catch (err) {
    logError(
      log,
      "sandbox_setup_auth_missing",
      `auth.json not found at ${AUTH_JSON_PATH} — sandbox agent will not be able to authenticate. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  setupSandboxes.add(sandboxId);
  logInfo(log, "sandbox_setup_done", { sandboxId });
}

const REFRESH_FIELD_RE = /refresh/i;

/**
 * Recursively strip any field whose key contains "refresh" (case-insensitive)
 * from a JSON value. Prevents the sandbox from refreshing tokens that would
 * invalidate the main opencode's auth.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripRefreshFields(value: any): any {
  if (Array.isArray(value)) {
    return value.map(stripRefreshFields);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (REFRESH_FIELD_RE.test(k)) continue;
      result[k] = stripRefreshFields(v);
    }
    return result;
  }
  return value;
}

/** Reset setup state for a sandbox (e.g. after error or destroy). */
export function resetSetupState(sandboxId: string): void {
  setupSandboxes.delete(sandboxId);
}
