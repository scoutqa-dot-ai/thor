import {
  PiModelProfileSchema,
  PiModelRoutingConfigSchema,
  PiModelRoutingPoolSchema,
  PiModelSelectionSchema,
  PiTaskRoutingOverridesSchema,
  type PiModelProfile,
  type PiModelRoutingPool,
  type PiModelSelection,
  type PiTaskRoutingOverrides,
} from "@thor/common";
import type { PiRunnerConfig } from "./pi-runner-config.js";

/** Expected routing failures are values; messages do not expose task text or credentials. */
export class PiModelRoutingError extends Error {
  /** Stable routing error tag for boundary translation. */
  readonly _tag = "PiModelRoutingError";
  /** Codes distinguish invalid evidence, unsupported choices and forbidden promotions. */
  constructor(
    readonly code:
      | "configuration_invalid"
      | "overrides_invalid"
      | "model_not_in_pool"
      | "selection_invalid"
      | "escalation_locked"
      | "escalation_limit"
      | "escalation_not_upward"
      | "escalation_reason_invalid",
  ) {
    super(`Pi model routing rejected: ${code}`);
  }
}
/** Pure routing result; no known policy failure throws. */
export type PiModelRoutingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PiModelRoutingError };

const profiles: readonly PiModelProfile[] = ["fast", "balanced", "strong"];
const thinkingDefaults = { fast: "low", balanced: "medium", strong: "high" } as const;
const rejected = (
  code: PiModelRoutingError["code"],
): { ok: false; error: PiModelRoutingError } => ({
  ok: false,
  error: new PiModelRoutingError(code),
});

/** Resolve only operator configuration and the existing model/capabilities; never read secrets or catalogs. */
export function resolvePiModelRoutingPool(
  config: Pick<PiRunnerConfig, "modelId" | "modelContextWindow" | "modelSupportsImages">,
  routingConfig: unknown = {},
): PiModelRoutingResult<PiModelRoutingPool> {
  const parsed = PiModelRoutingConfigSchema.safeParse(routingConfig);
  if (!parsed.success) return rejected("configuration_invalid");
  const routing = parsed.data;
  const entry = (profile: PiModelProfile) => ({
    modelId: routing.profiles?.[profile]?.modelId ?? config.modelId,
    thinkingLevel: routing.profiles?.[profile]?.thinkingLevel ?? thinkingDefaults[profile],
  });
  const pool = PiModelRoutingPoolSchema.safeParse({
    provider: "codex-lb",
    profiles: { fast: entry("fast"), balanced: entry("balanced"), strong: entry("strong") },
    modelContextWindow: config.modelContextWindow,
    modelSupportsImages: config.modelSupportsImages,
    autoSelect: routing.autoSelect ?? true,
    defaultProfile: routing.defaultProfile ?? "balanced",
    allowEscalation: routing.allowEscalation ?? true,
  });
  return pool.success ? { ok: true, value: pool.data } : rejected("configuration_invalid");
}

/** Parse request overrides before selecting; unknown fields and mutually exclusive selectors fail closed. */
export function parsePiTaskRoutingOverrides(
  input: unknown,
): PiModelRoutingResult<PiTaskRoutingOverrides> {
  const parsed = PiTaskRoutingOverridesSchema.safeParse(input);
  if (!parsed.success) return rejected("overrides_invalid");
  return { ok: true, value: parsed.data };
}

function classifyPiRoutingTask(task: string): { profile: PiModelProfile; reason: string } {
  if (
    /\b(architect(?:ure|ural)?|security|vulnerabilit\w*|threat|exploit\w*|investigat\w*|debug\w*|diagnos\w*|incident|outage|crash\w*|root[ -]cause|segfault|race condition|deadlock)\b/i.test(
      task,
    )
  )
    return { profile: "strong", reason: "deep_investigation_security_architecture" };
  if (
    /\b(implement\w*|cod(?:e|ing)|refactor\w*|fix\w*|bug\w*|test\w*|feature|patch|build|typescript|migration)\b/i.test(
      task,
    )
  )
    return { profile: "balanced", reason: "coding_work" };
  if (
    /\b(summari[sz]\w*|summary|summaries|lookup|look up|list|find|fetch|retrieve|read|status|digest|jira|slack|calendar|drive|sheets|integration)\b/i.test(
      task,
    )
  )
    return { profile: "fast", reason: "routine_lookup_integration_summary" };
  return { profile: "balanced", reason: "unknown_task_balanced" };
}

/** Select from current raw task text only; every explicit override locks later escalation. */
export function selectPiTaskModel(input: {
  pool: PiModelRoutingPool;
  routingTask: string;
  overrides?: unknown;
}): PiModelRoutingResult<PiModelSelection> {
  const parsed = parsePiTaskRoutingOverrides(input.overrides ?? {});
  if (!parsed.ok) return parsed;
  const overrides = parsed.value;
  const { pool } = input;
  const initial = pool.autoSelect
    ? classifyPiRoutingTask(overrides.routingTask ?? input.routingTask)
    : { profile: pool.defaultProfile, reason: "configured_default_profile" };
  let profile = initial.profile;
  let reason = initial.reason;
  let source: PiModelSelection["source"] = pool.autoSelect ? "automatic" : "default";
  if (overrides.modelProfile !== undefined) {
    profile = overrides.modelProfile;
    source = "explicit_profile";
    reason = "request_profile_override";
  } else if (overrides.modelId !== undefined) {
    const matches = profiles.filter(
      (candidate) => pool.profiles[candidate].modelId === overrides.modelId,
    );
    const match = matches.includes(pool.defaultProfile) ? pool.defaultProfile : matches[0];
    if (match === undefined) return rejected("model_not_in_pool");
    profile = match;
    source = "explicit_model";
    reason = "request_model_override";
  } else if (overrides.thinkingLevel !== undefined) {
    source = "explicit_thinking";
    reason = "request_thinking_override";
  }
  const selected = PiModelSelectionSchema.safeParse({
    version: 1,
    pool,
    profile,
    modelId: pool.profiles[profile].modelId,
    thinkingLevel: overrides.thinkingLevel ?? pool.profiles[profile].thinkingLevel,
    source,
    reason,
    escalationLocked: source.startsWith("explicit_") || !pool.allowEscalation,
    promotions: 0,
    history: [],
  });
  return selected.success ? { ok: true, value: selected.data } : rejected("selection_invalid");
}

/** Parse durable selection evidence without reclassifying retry or continuation text. */
export function parsePiModelSelection(input: unknown): PiModelRoutingResult<PiModelSelection> {
  const parsed = PiModelSelectionSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : rejected("selection_invalid");
}

/** Decide one upward promotion in the frozen pool; native configuration/persistence belongs to the runner. */
export function decidePiModelEscalation(
  selection: PiModelSelection,
  request: { profile: unknown; reason: string },
): PiModelRoutingResult<PiModelSelection> {
  if (selection.escalationLocked) return rejected("escalation_locked");
  if (selection.promotions >= 2 || selection.profile === "strong")
    return rejected("escalation_limit");
  const profile = PiModelProfileSchema.safeParse(request.profile);
  if (
    !profile.success ||
    profiles.indexOf(profile.data) !== profiles.indexOf(selection.profile) + 1
  )
    return rejected("escalation_not_upward");
  const reason = request.reason.trim();
  if (!reason || reason.length > 1000) return rejected("escalation_reason_invalid");
  const next = PiModelSelectionSchema.safeParse({
    ...selection,
    profile: profile.data,
    ...selection.pool.profiles[profile.data],
    promotions: selection.promotions + 1,
    history: [...selection.history, { from: selection.profile, to: profile.data, reason }],
  });
  return next.success ? { ok: true, value: next.data } : rejected("selection_invalid");
}
