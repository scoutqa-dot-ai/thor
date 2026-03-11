/**
 * Structured JSON logger backed by pino.
 *
 * Usage:
 *   import { createLogger, logInfo, logError } from "@thor/common";
 *   const logger = createLogger("proxy");
 *   logInfo(logger, "config_loaded", { upstreams: ["linear", "posthog"] });
 *   logError(logger, "start_failed", new Error("port in use"), { port: 3001 });
 */

import pino, { type Logger } from "pino";

export type { Logger } from "pino";

export function createLogger(name: string): Logger {
  return pino({ name });
}

export function logInfo(logger: Logger, event: string, data?: Record<string, unknown>): void {
  logger.info({ event, ...data }, event);
}

export function logWarn(logger: Logger, event: string, data?: Record<string, unknown>): void {
  logger.warn({ event, ...data }, event);
}

export function logError(
  logger: Logger,
  event: string,
  error: unknown,
  data?: Record<string, unknown>,
): void {
  logger.error(
    { event, error: error instanceof Error ? error.message : String(error), ...data },
    event,
  );
}
