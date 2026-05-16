import { findActiveTrigger, findAnchorContext } from "./event-log.js";

export function formatThorDisclaimerFooter(thorUrl: string): string {
  return ["", "---", `AI-generated — verify before acting. [View Thor context](${thorUrl})`].join(
    "\n",
  );
}

export interface ActiveTriggerSnapshot {
  anchorId: string;
  sessionId: string;
  triggerId: string;
}

export interface ThorDisclaimerContext {
  anchorId: string;
  sessionId?: string;
  triggerId?: string;
  triggerUrl?: string;
  anchorUrl: string;
  footer: string;
}

export function buildThorAnchorUrl(anchor: { anchorId: string }, runnerBaseUrl = ""): string {
  const base = runnerBaseUrl.replace(/\/$/, "");
  return `${base}/runner/v/${anchor.anchorId}`;
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
  trigger: { anchorId: string; triggerId?: string },
  runnerBaseUrl = "",
): { anchorUrl: string; triggerUrl?: string; footer: string } {
  const anchorUrl = buildThorAnchorUrl(trigger, runnerBaseUrl);
  const triggerUrl = trigger.triggerId
    ? buildThorTriggerUrl({ anchorId: trigger.anchorId, triggerId: trigger.triggerId }, runnerBaseUrl)
    : undefined;
  return { anchorUrl, triggerUrl, footer: formatThorDisclaimerFooter(anchorUrl) };
}

export function buildThorDisclaimerForSession(
  sessionId: string | undefined,
  runnerBaseUrl = "",
): ThorDisclaimerContext {
  if (!sessionId) {
    throw new Error("Disclaimer required: missing Thor session id");
  }
  const context = findAnchorContext(sessionId);
  if (!context.ok) {
    throw new Error(`Disclaimer required: no Thor anchor for session ${sessionId} (${context.reason})`);
  }
  const { anchorId, sessionId: anchorSessionId, triggerId } = context;
  return {
    anchorId,
    sessionId: anchorSessionId,
    triggerId,
    ...buildThorDisclaimer({ anchorId, triggerId }, runnerBaseUrl),
  };
}
