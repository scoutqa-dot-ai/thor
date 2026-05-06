import { findActiveTrigger } from "./event-log.js";

export function formatThorDisclaimerFooter(triggerUrl: string): string {
  return [
    "",
    "---",
    `AI-generated — verify before acting. [View trigger](${triggerUrl})`,
  ].join("\n");
}

export interface ThorDisclaimerContext {
  anchorId: string;
  sessionId: string;
  triggerId: string;
  triggerUrl: string;
  footer: string;
}

export function buildThorTriggerUrl(
  activeTrigger: { anchorId: string; triggerId: string },
  runnerBaseUrl = "",
): string {
  const base = runnerBaseUrl.replace(/\/$/, "");
  return `${base}/runner/v/${activeTrigger.anchorId}/${activeTrigger.triggerId}`;
}

export function buildThorDisclaimerForSession(
  sessionId: string | undefined,
  runnerBaseUrl = "",
): ThorDisclaimerContext {
  if (!sessionId) {
    throw new Error("Disclaimer required: missing Thor session id");
  }

  const active = findActiveTrigger(sessionId);
  if (!active.ok) {
    throw new Error(
      `Disclaimer required: no single active trigger for session ${sessionId} (${active.reason})`,
    );
  }

  const triggerUrl = buildThorTriggerUrl(active, runnerBaseUrl);
  return {
    anchorId: active.anchorId,
    sessionId: active.sessionId,
    triggerId: active.triggerId,
    triggerUrl,
    footer: formatThorDisclaimerFooter(triggerUrl),
  };
}
