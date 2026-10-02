import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { QueuedEvent } from "./queue.js";
import type { RunnerTriggerOptions } from "./service.js";

const batchRequestPayloadSchema = z.object({
  prompt: z.string(),
  correlationKey: z.string(),
  directory: z.string(),
  triggerSlackId: z.string().optional(),
  triggerGithubLogin: z.string().optional(),
  interrupt: z.boolean().optional(),
});

/** Deterministic request identity uses event IDs, not arrival time or rendered prompts. */
export function queuedBatchRequestId(events: QueuedEvent[]): string {
  const identity = events
    .map((event) => [event.source, event.id])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `gateway:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Freeze the actual HTTP payload before delivery so retries cannot change routing, actor or prompt context. */
export function persistBatchRunnerRequest(
  queueDir: string,
  options: RunnerTriggerOptions & { requestId: string },
): RunnerTriggerOptions {
  const directory = join(queueDir, ".runner-requests");
  mkdirSync(directory, { recursive: true });
  const file = join(
    directory,
    `${createHash("sha256").update(options.requestId).digest("hex")}.json`,
  );
  let payload;
  try {
    payload = batchRequestPayloadSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error("Gateway stored request unavailable");
    payload = batchRequestPayloadSchema.parse(options);
    writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
    renameSync(`${file}.tmp`, file);
  }
  return { ...options, ...payload };
}
