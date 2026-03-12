import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const CronRequestSchema = z.object({
  prompt: z.string().min(1),
});

export type CronRequest = z.infer<typeof CronRequestSchema>;

export interface CronPayload {
  prompt: string;
}

/**
 * Derive a correlation key for a cron trigger.
 * Format: `cron:{md5(prompt)}:{unix-epoch-seconds}`
 */
export function deriveCronCorrelationKey(prompt: string): string {
  const hash = createHash("md5").update(prompt).digest("hex");
  const epoch = Math.floor(Date.now() / 1000);
  return `cron:${hash}:${epoch}`;
}
