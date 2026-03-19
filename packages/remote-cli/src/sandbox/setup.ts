/**
 * Sandbox setup — configure OpenCode environment inside a Daytona sandbox.
 *
 * Uploads opencode config (no MCP, permission: allow) and auth credentials
 * so the sandbox can run OpenCode as an independent coding agent.
 */

import { readFileSync } from "node:fs";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-setup");

const OPENCODE_CONFIG_DIR = "/home/daytona/.config/opencode";
const OPENCODE_DATA_DIR = "/home/daytona/.local/share/opencode";

/** Path to the host-mounted auth.json (read-only mount from opencode data volume). */
const AUTH_JSON_PATH = process.env.OPENCODE_AUTH_PATH || "/opencode-data/auth.json";

/**
 * Minimal opencode.json for sandbox coding agent:
 * - No MCP servers (isolated execution)
 * - Permission: allow (agent has full file/bash access)
 * - Model: same as main opencode instance
 */
const SANDBOX_OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  model: "opencode/big-pickle",
  permission: "allow",
  mcp: {},
};

const SANDBOX_AGENT_PROMPT = `You are a coding agent running in an isolated sandbox.
Your job is to edit files, run tests, and fix bugs in the source code at /home/daytona/workspace/src.
Do not attempt external API calls — you have no network access to external services.
Focus on writing correct, well-tested code.`;

/**
 * Set up OpenCode inside a sandbox: upload config and auth credentials.
 * Call this once after sandbox creation, before running the agent.
 */
export async function setupSandboxOpenCode(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<void> {
  logInfo(log, "sandbox_setup_start", { sandboxId });

  // Install OpenCode if not already present
  const { exitCode: whichExit } = await provider.executeCommand(sandboxId, "which opencode");
  if (whichExit !== 0) {
    logInfo(log, "sandbox_setup_installing_opencode", { sandboxId });
    const { exitCode: installExit } = await provider.executeCommand(
      sandboxId,
      "npm install -g opencode-ai",
    );
    if (installExit !== 0) {
      throw new Error(`Failed to install opencode-ai in sandbox ${sandboxId}`);
    }
  }

  // Create config directories
  await provider.executeCommand(
    sandboxId,
    `mkdir -p ${OPENCODE_CONFIG_DIR} ${OPENCODE_DATA_DIR} ${OPENCODE_CONFIG_DIR}/agents`,
  );

  // Upload opencode.json config
  const configBuffer = Buffer.from(JSON.stringify(SANDBOX_OPENCODE_CONFIG, null, 2));
  await provider.uploadFile(sandboxId, `${OPENCODE_CONFIG_DIR}/opencode.json`, configBuffer);

  // Upload agent prompt
  const agentBuffer = Buffer.from(`---
name: coder
model: opencode/big-pickle
---
${SANDBOX_AGENT_PROMPT}
`);
  await provider.uploadFile(sandboxId, `${OPENCODE_CONFIG_DIR}/agents/coder.md`, agentBuffer);

  // Upload auth.json if available
  try {
    const authData = readFileSync(AUTH_JSON_PATH);
    await provider.uploadFile(sandboxId, `${OPENCODE_DATA_DIR}/auth.json`, authData);
    logInfo(log, "sandbox_setup_auth_uploaded", { sandboxId });
  } catch (err) {
    logError(
      log,
      "sandbox_setup_auth_missing",
      `auth.json not found at ${AUTH_JSON_PATH} — sandbox agent will not be able to authenticate. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logInfo(log, "sandbox_setup_done", { sandboxId });
}
