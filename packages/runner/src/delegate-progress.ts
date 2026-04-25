import type { Part, ToolPart } from "@opencode-ai/sdk";
import type { ProgressEvent } from "@thor/common";

type DelegateEvent = Extract<ProgressEvent, { type: "delegate" }>;
interface DelegateProgressState {
  emittedTaskDelegates: Set<string>;
  emittedDelegateLabels: Set<string>;
  pendingTaskFallbackSuppressions: Map<string, number>;
}

function taskFingerprint(agent: string, description?: string): string {
  return `${agent}|${description ?? ""}`;
}

function toNonEmptyTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function taskInvocationKey(toolPart: ToolPart): string | undefined {
  const part = toolPart as ToolPart & {
    id?: string;
    callID?: string;
    messageID?: string;
    sessionID?: string;
    state: {
      input?: unknown;
      time?: { start?: number };
      callID?: string;
      id?: string;
    };
  };

  const stableId =
    part.id ?? part.callID ?? part.state.id ?? part.state.callID ?? String(part.state.time?.start ?? "");
  if (!stableId) return undefined;

  return [part.sessionID ?? "", part.messageID ?? "", stableId].join("|");
}

function delegateLabelKey(part: Part, agent: string): string | undefined {
  const withIds = part as Part & {
    id?: string;
    messageID?: string;
    sessionID?: string;
  };

  if (!withIds.sessionID && !withIds.messageID && !withIds.id) {
    return undefined;
  }

  return [withIds.sessionID ?? "", withIds.messageID ?? "", withIds.id ?? "", agent].join("|");
}

function getTaskDelegateEvent(
  part: ToolPart,
  state: DelegateProgressState,
): DelegateEvent | undefined {
  if (part.type !== "tool" || part.tool !== "task") return undefined;

  const input = (part.state as { input?: unknown }).input;
  if (!input || typeof input !== "object") return undefined;

  const inputRecord = input as Record<string, unknown>;
  const agent = toNonEmptyTrimmedString(inputRecord.subagent_type);
  if (!agent) return undefined;

  const description = toNonEmptyTrimmedString(inputRecord.description);
  const invocationKey = taskInvocationKey(part);
  if (invocationKey) {
    if (state.emittedTaskDelegates.has(invocationKey)) return undefined;
    state.emittedTaskDelegates.add(invocationKey);
  }

  const labelKey = delegateLabelKey(part, agent);
  if (labelKey) {
    state.emittedDelegateLabels.add(labelKey);
  }
  const fingerprint = taskFingerprint(agent, description);
  state.pendingTaskFallbackSuppressions.set(
    fingerprint,
    (state.pendingTaskFallbackSuppressions.get(fingerprint) ?? 0) + 1,
  );

  return {
    type: "delegate",
    agent,
    ...(description ? { description } : {}),
  };
}

function getSubtaskDelegateEvent(part: Part, state: DelegateProgressState): DelegateEvent | undefined {
  if (part.type !== "subtask") return undefined;

  const subtaskPart = part as Part & {
    type: "subtask";
    description?: string;
    agent?: string;
  };

  const agent = toNonEmptyTrimmedString(subtaskPart.agent);
  if (!agent) return undefined;
  const description = toNonEmptyTrimmedString(subtaskPart.description);
  const fingerprint = taskFingerprint(agent, description);
  const pendingSuppression = state.pendingTaskFallbackSuppressions.get(fingerprint) ?? 0;
  if (pendingSuppression > 0) {
    if (pendingSuppression === 1) {
      state.pendingTaskFallbackSuppressions.delete(fingerprint);
    } else {
      state.pendingTaskFallbackSuppressions.set(fingerprint, pendingSuppression - 1);
    }
    return undefined;
  }

  const labelKey = delegateLabelKey(part, agent);
  if (labelKey) {
    if (state.emittedDelegateLabels.has(labelKey)) return undefined;
    state.emittedDelegateLabels.add(labelKey);
  }

  return {
    type: "delegate",
    agent,
    ...(description ? { description } : {}),
  };
}

export function getDelegateProgressEvents(
  part: Part,
  state: DelegateProgressState,
): DelegateEvent[] {
  const events: DelegateEvent[] = [];

  const taskDelegate = part.type === "tool" ? getTaskDelegateEvent(part, state) : undefined;
  if (taskDelegate) {
    events.push(taskDelegate);
  }

  const subtaskDelegate = getSubtaskDelegateEvent(part, state);
  if (subtaskDelegate) {
    events.push(subtaskDelegate);
  }

  return events;
}

export function createDelegateProgressState(): DelegateProgressState {
  return {
    emittedTaskDelegates: new Set<string>(),
    emittedDelegateLabels: new Set<string>(),
    pendingTaskFallbackSuppressions: new Map<string, number>(),
  };
}
