/**
 * Sandbox setup — configure OpenCode environment inside a Daytona sandbox.
 *
 * Two phases:
 * - setupSandboxOpenCode: one-time install + config (once per sandbox)
 * - uploadSandboxAuth: fresh auth credentials (every prompt, tokens expire)
 */

import { readFileSync } from "node:fs";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-setup");

const OPENCODE_CONFIG_DIR = "/home/daytona/.config/opencode";
const OPENCODE_DATA_DIR = "/home/daytona/.local/share/opencode";
const OPENCODE_VERSION = "1.2.27";

/** Path to the host-mounted auth.json (read at call time so env overrides work). */
function getAuthJsonPath(): string {
  return process.env.OPENCODE_AUTH_PATH || "/opencode-data/auth.json";
}

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
 * One-time sandbox setup: install pinned opencode version and upload config.
 * Skipped on repeat calls for the same sandbox.
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
  const { exitCode: installExit, result: installOutput } = await provider.executeCommand(
    sandboxId,
    `sudo "$(which npm)" i -g opencode-ai@${OPENCODE_VERSION} 2>&1`,
  );
  if (installExit !== 0) {
    logError(log, "sandbox_setup_install_failed", {
      sandboxId,
      exitCode: installExit,
      output: installOutput,
    });
    throw new Error(
      `opencode install failed in sandbox ${sandboxId} (exit ${installExit}): ${installOutput}`,
    );
  }
  logInfo(log, "sandbox_setup_opencode_installed", { sandboxId, version: OPENCODE_VERSION });

  // Configure git identity (persists in ~/.gitconfig for sandbox lifetime)
  await provider.executeCommand(
    sandboxId,
    'git config --global user.email "sandbox@thor" && git config --global user.name "thor"',
  );

  // Create config directories
  await provider.executeCommand(sandboxId, `mkdir -p ${OPENCODE_CONFIG_DIR} ${OPENCODE_DATA_DIR}`);

  // Upload opencode.json config
  const configBuffer = Buffer.from(JSON.stringify(SANDBOX_OPENCODE_CONFIG, null, 2));
  await provider.uploadFile(sandboxId, `${OPENCODE_CONFIG_DIR}/opencode.json`, configBuffer);

  setupSandboxes.add(sandboxId);
  logInfo(log, "sandbox_setup_done", { sandboxId });
}

/**
 * Upload fresh auth credentials to the sandbox. Called before every prompt
 * because tokens expire. Refresh fields are stripped so the sandbox cannot
 * refresh and invalidate the main opencode's credentials.
 */
export async function uploadSandboxAuth(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<void> {
  try {
    const authData = JSON.parse(readFileSync(getAuthJsonPath(), "utf-8"));
    const sanitized = stripRefreshFields(authData);
    await provider.uploadFile(
      sandboxId,
      `${OPENCODE_DATA_DIR}/auth.json`,
      Buffer.from(JSON.stringify(sanitized, null, 2)),
    );
    logInfo(log, "sandbox_auth_uploaded", { sandboxId });
  } catch (err) {
    logError(
      log,
      "sandbox_auth_missing",
      `auth.json not found at ${getAuthJsonPath()} — sandbox agent will not be able to authenticate. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
      if (REFRESH_FIELD_RE.test(k)) {
        result[k] = typeof v === "string" ? "" : typeof v === "number" ? 0 : v;
        continue;
      }
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
