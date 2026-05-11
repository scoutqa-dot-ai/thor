import { findActiveTrigger } from "./event-log.js";

export function formatThorDisclaimerFooter(triggerUrl: string): string {
  return ["", "---", `AI-generated — verify before acting. [View trigger](${triggerUrl})`].join(
    "\n",
  );
}

export interface ActiveTriggerSnapshot {
  anchorId: string;
  sessionId: string;
  triggerId: string;
}

export interface ThorDisclaimerContext extends ActiveTriggerSnapshot {
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

export function findActiveTriggerOrThrow(sessionId: string | undefined): ActiveTriggerSnapshot {
  if (!sessionId) {
    throw new Error("Disclaimer required: missing Thor session id");
  }
  const active = findActiveTrigger(sessionId);
  if (!active.ok) {
    throw new Error(
      `Disclaimer required: no single active trigger for session ${sessionId} (${active.reason})`,
    );
  }
  return { anchorId: active.anchorId, sessionId: active.sessionId, triggerId: active.triggerId };
}

export function buildThorDisclaimer(
  trigger: { anchorId: string; triggerId: string },
  runnerBaseUrl = "",
): { triggerUrl: string; footer: string } {
  const triggerUrl = buildThorTriggerUrl(trigger, runnerBaseUrl);
  return { triggerUrl, footer: formatThorDisclaimerFooter(triggerUrl) };
}

export function buildThorDisclaimerForSession(
  sessionId: string | undefined,
  runnerBaseUrl = "",
): ThorDisclaimerContext {
  const trigger = findActiveTriggerOrThrow(sessionId);
  return { ...trigger, ...buildThorDisclaimer(trigger, runnerBaseUrl) };
}
