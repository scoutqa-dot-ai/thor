/**
 * @thor/mission-control — Bridge between Mission Control task board and Thor runner.
 *
 * Registers Thor as an agent, polls for tasks, and dispatches to OpenCode via the runner.
 */

import { createLogger, logInfo, logError } from "@thor/common";
import { MCClient } from "./client.js";
import { startBridge } from "./bridge.js";

const log = createLogger("mission-control");

// --- Config from environment ---

const MC_URL = (process.env.MC_URL || "http://mission-control:3100").replace(/\/$/, "");
const MC_API_KEY = process.env.MC_API_KEY || "";
const RUNNER_URL = (process.env.RUNNER_URL || "http://runner:3000").replace(/\/$/, "");
const AGENT_NAME = process.env.MC_AGENT_NAME || "thor";
const POLL_INTERVAL_MS = parseInt(process.env.MC_POLL_INTERVAL_MS || "10000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.MC_HEARTBEAT_INTERVAL_MS || "30000", 10);

async function main(): Promise<void> {
  logInfo(log, "initializing", {
    mcUrl: MC_URL,
    runnerUrl: RUNNER_URL,
    agentName: AGENT_NAME,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const client = new MCClient({
    baseUrl: MC_URL,
    apiKey: MC_API_KEY,
  });

  // Wait for Mission Control to be available
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await client.health()) break;
    logInfo(log, "waiting_for_mc", { mcUrl: MC_URL });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!(await client.health())) {
    logError(log, "mc_unreachable", `Mission Control at ${MC_URL} not reachable after 30s`);
    process.exit(1);
  }

  // Register Thor as an agent
  const agent = await client.registerAgent(AGENT_NAME, [
    "coding",
    "devops",
    "analysis",
    "slack",
    "github",
    "qa",
  ]);

  logInfo(log, "agent_registered", { agentId: agent.id, name: agent.name });

  // Start the polling bridge
  await startBridge({
    mcClient: client,
    agentId: agent.id,
    runnerUrl: RUNNER_URL,
    pollIntervalMs: POLL_INTERVAL_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
}

main().catch((err) => {
  logError(log, "fatal", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
