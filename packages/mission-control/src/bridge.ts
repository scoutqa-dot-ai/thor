/**
 * Mission Control → Thor Runner bridge.
 *
 * Polls MC for assigned tasks, triggers the runner, streams progress,
 * and reports completion back to MC.
 */

import { createLogger, logInfo, logError, ProgressEventSchema } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { MCClient } from "./client.js";
import type { MCTask } from "./client.js";

const log = createLogger("mc-bridge");

export interface BridgeConfig {
  mcClient: MCClient;
  agentId: string;
  runnerUrl: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build a prompt from a Mission Control task.
 * Includes task metadata so the agent has full context.
 */
function buildPrompt(task: MCTask): string {
  const lines: string[] = [];
  lines.push(`[Mission Control Task: ${task.id}]`);
  lines.push(`Title: ${task.title}`);
  if (task.priority) lines.push(`Priority: ${task.priority}`);
  if (task.projectId) lines.push(`Project: ${task.projectId}`);
  lines.push("");

  if (task.description) {
    lines.push(task.description);
  } else {
    lines.push(task.title);
  }

  return lines.join("\n");
}

/**
 * Derive a stable correlation key for a MC task.
 * Using `mc:{taskId}` so sessions persist across retries of the same task.
 */
function deriveCorrelationKey(task: MCTask): string {
  return `mc:${task.id}`;
}

/**
 * Trigger the runner and consume the NDJSON stream.
 * Returns the final status and response text.
 */
async function triggerRunner(
  task: MCTask,
  runnerUrl: string,
  fetchFn: typeof fetch,
): Promise<{ status: "completed" | "error"; response: string; error?: string }> {
  const prompt = buildPrompt(task);
  const correlationKey = deriveCorrelationKey(task);

  const response = await fetchFn(`${runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, correlationKey }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  // Consume NDJSON stream
  const body = response.body;
  if (!body) {
    return { status: "completed", response: "" };
  }

  let finalStatus: "completed" | "error" = "completed";
  let finalResponse = "";
  let finalError: string | undefined;

  const reader = body.pipeThrough(new TextDecoderStream());
  let buffer = "";

  for await (const chunk of reader) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = ProgressEventSchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;

        const event: ProgressEvent = parsed.data;

        if (event.type === "tool") {
          logInfo(log, "task_tool", {
            taskId: task.id,
            tool: event.tool,
            status: event.status,
          });
        } else if (event.type === "done") {
          finalStatus = event.status === "error" ? "error" : "completed";
          finalResponse = event.response ?? "";
          finalError = event.error;
        } else if (event.type === "error") {
          finalStatus = "error";
          finalError = event.error;
        }
      } catch {
        // skip non-JSON lines
      }
    }
  }

  return { status: finalStatus, response: finalResponse, error: finalError };
}

/**
 * Process a single task: mark in-progress, trigger runner, report back.
 */
async function processTask(task: MCTask, config: BridgeConfig): Promise<void> {
  const fetchFn = config.fetchImpl ?? fetch;

  logInfo(log, "task_started", { taskId: task.id, title: task.title });

  // Mark in-progress
  await config.mcClient.updateTask(task.id, { status: "in_progress" });

  try {
    const result = await triggerRunner(task, config.runnerUrl, fetchFn);

    if (result.status === "error") {
      logError(log, "task_failed", result.error ?? "unknown error", { taskId: task.id });
      await config.mcClient.updateTask(task.id, {
        status: "error",
        error: result.error,
      });
      if (result.response) {
        await config.mcClient.addComment(task.id, `**Error output:**\n${result.response}`);
      }
    } else {
      logInfo(log, "task_completed", { taskId: task.id });
      await config.mcClient.updateTask(task.id, {
        status: "done",
        output: result.response.slice(0, 10000), // MC may have size limits
      });
      if (result.response) {
        await config.mcClient.addComment(task.id, result.response.slice(0, 10000));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(log, "task_error", msg, { taskId: task.id });
    await config.mcClient.updateTask(task.id, { status: "error", error: msg }).catch(() => {});
  }
}

/**
 * Start the polling loop. Runs indefinitely.
 */
export async function startBridge(config: BridgeConfig): Promise<void> {
  logInfo(log, "bridge_started", {
    runnerUrl: config.runnerUrl,
    pollIntervalMs: config.pollIntervalMs,
    agentId: config.agentId,
  });

  // Heartbeat loop (background)
  const heartbeatLoop = setInterval(async () => {
    try {
      await config.mcClient.heartbeat(config.agentId);
    } catch (err) {
      logError(log, "heartbeat_error", err instanceof Error ? err.message : String(err));
    }
  }, config.heartbeatIntervalMs);

  // Keep reference to prevent GC, allow cleanup
  process.on("SIGTERM", () => clearInterval(heartbeatLoop));
  process.on("SIGINT", () => clearInterval(heartbeatLoop));

  // Poll loop
  let processing = false;

  while (true) {
    if (!processing) {
      try {
        const task = await config.mcClient.pollQueue(config.agentId);

        if (task) {
          processing = true;
          processTask(task, config)
            .catch((err) => {
              logError(log, "process_task_error", err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
              processing = false;
            });
        }
      } catch (err) {
        logError(log, "poll_error", err instanceof Error ? err.message : String(err));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
