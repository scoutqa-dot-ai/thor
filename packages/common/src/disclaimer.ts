import { findActiveTrigger, type ActiveTriggerResult } from "./event-log.js";

export type ThorDisclaimerErrorCode = "missing_session_id" | "active_trigger_unavailable";

export class ThorDisclaimerError extends Error {
  readonly code: ThorDisclaimerErrorCode;
  readonly sessionId?: string;
  readonly activeTriggerReason?: Exclude<ActiveTriggerResult, { ok: true }>["reason"];

  constructor(
    code: ThorDisclaimerErrorCode,
    message: string,
    details: { sessionId?: string; activeTriggerReason?: Exclude<ActiveTriggerResult, { ok: true }>["reason"] } = {},
  ) {
    super(message);
    this.name = "ThorDisclaimerError";
    this.code = code;
    this.sessionId = details.sessionId;
    this.activeTriggerReason = details.activeTriggerReason;
  }
}

export function formatThorDisclaimerFooter(triggerUrl: string): string {
  return [
    "",
    "---",
    `Created by Thor, an AI assistant. This content may be wrong; review carefully and do not trust it blindly. [View Thor trigger](${triggerUrl})`,
  ].join("\n");
}

export interface ThorDisclaimerContext {
  sessionId: string;
  triggerId: string;
  triggerUrl: string;
  footer: string;
}

export function buildThorTriggerUrl(activeTrigger: { sessionId: string; triggerId: string }, runnerBaseUrl = ""): string {
  const base = runnerBaseUrl.replace(/\/$/, "");
  return `${base}/runner/v/${activeTrigger.sessionId}/${activeTrigger.triggerId}`;
}

export function buildThorDisclaimerForSession(sessionId: string | undefined, runnerBaseUrl = ""): ThorDisclaimerContext {
  if (!sessionId) {
    throw new ThorDisclaimerError("missing_session_id", "missing Thor session id for disclaimer injection");
  }

  const active = findActiveTrigger(sessionId);
  if (!active.ok) {
    throw new ThorDisclaimerError(
      "active_trigger_unavailable",
      `no single active trigger for session ${sessionId} (${active.reason})`,
      { sessionId, activeTriggerReason: active.reason },
    );
  }

  const triggerUrl = buildThorTriggerUrl(active, runnerBaseUrl);
  return {
    sessionId: active.sessionId,
    triggerId: active.triggerId,
    triggerUrl,
    footer: formatThorDisclaimerFooter(triggerUrl),
  };
}
