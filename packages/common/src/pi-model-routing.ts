import { z } from "zod/v4";

/** Pi model profiles are an ordered, operator-owned pool, not provider discovery. */
export const PiModelProfileSchema = z.enum(["fast", "balanced", "strong"]);
/** Supported Pi reasoning effort; profile defaults are low, medium and high. */
export const PiThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high"]);
const modelIdSchema = z.string().trim().min(1);
const profileConfigSchema = z.strictObject({
  modelId: modelIdSchema.optional(),
  thinkingLevel: PiThinkingLevelSchema.optional(),
});

/** Strict routing configuration rejects typos rather than silently changing the pool. */
export const PiModelRoutingConfigSchema = z.strictObject({
  profiles: z
    .strictObject({
      fast: profileConfigSchema.optional(),
      balanced: profileConfigSchema.optional(),
      strong: profileConfigSchema.optional(),
    })
    .optional(),
  autoSelect: z.boolean().optional(),
  defaultProfile: PiModelProfileSchema.optional(),
  allowEscalation: z.boolean().optional(),
});
/** Optional operator configuration; missing profile model IDs inherit the existing model. */
export type PiModelRoutingConfig = z.infer<typeof PiModelRoutingConfigSchema>;
/** Ordered routing profile name. */
export type PiModelProfile = z.infer<typeof PiModelProfileSchema>;
/** Reasoning effort accepted by the Pi routing contract. */
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

/** HTTP/queue fields shared with Pi admission; routingTask is current raw task text, never history. */
export const PiTaskRoutingFields = {
  modelProfile: PiModelProfileSchema.optional(),
  modelId: modelIdSchema.optional(),
  thinkingLevel: PiThinkingLevelSchema.optional(),
  routingTask: z.string().optional(),
};
/** Mutually exclusive selectors with an independent reasoning override. */
export const PiTaskRoutingOverridesSchema = z
  .strictObject(PiTaskRoutingFields)
  .refine(
    (value) => value.modelProfile === undefined || value.modelId === undefined,
    "Pi model routing overrides cannot combine modelProfile and modelId",
  )
  .transform((value): PiTaskRoutingOverrides => {
    const rest = {
      ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
      ...(value.routingTask === undefined ? {} : { routingTask: value.routingTask }),
    };
    if (value.modelProfile !== undefined) return { ...rest, modelProfile: value.modelProfile };
    if (value.modelId !== undefined) return { ...rest, modelId: value.modelId };
    return rest;
  });
/** External override input; no caller may supply frozen selection or escalation authority. */
export type PiTaskRoutingOverrides = {
  thinkingLevel?: PiThinkingLevel;
  routingTask?: string;
} & (
  | { modelProfile: PiModelProfile; modelId?: never }
  | { modelId: string; modelProfile?: never }
  | { modelProfile?: never; modelId?: never }
);

const poolEntrySchema = z
  .strictObject({
    modelId: modelIdSchema,
    thinkingLevel: PiThinkingLevelSchema,
  })
  .readonly();
/** Secret-free frozen pool evidence; all entries share existing context and image capabilities. */
export const PiModelRoutingPoolSchema = z
  .strictObject({
    provider: z.literal("codex-lb"),
    profiles: z
      .strictObject({ fast: poolEntrySchema, balanced: poolEntrySchema, strong: poolEntrySchema })
      .readonly(),
    modelContextWindow: z.number().int().min(32768),
    modelSupportsImages: z.boolean(),
    autoSelect: z.boolean(),
    defaultProfile: PiModelProfileSchema,
    allowEscalation: z.boolean(),
  })
  .readonly()
  .brand<"PiModelRoutingPool">();
/** Resolved pool evidence suitable for durable task metadata; never includes credentials. */
export type PiModelRoutingPool = z.infer<typeof PiModelRoutingPoolSchema>;
const selectionSourceSchema = z.enum([
  "automatic",
  "default",
  "explicit_profile",
  "explicit_model",
  "explicit_thinking",
]);
const escalationEntrySchema = z
  .strictObject({
    from: PiModelProfileSchema,
    to: PiModelProfileSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .readonly();
const profileRank: Record<PiModelProfile, number> = { fast: 0, balanced: 1, strong: 2 };

/** Frozen selection parser enforces pool membership, explicit locks and bounded upward history. */
export const PiModelSelectionSchema = z
  .strictObject({
    version: z.literal(1),
    pool: PiModelRoutingPoolSchema,
    profile: PiModelProfileSchema,
    modelId: modelIdSchema,
    thinkingLevel: PiThinkingLevelSchema,
    source: selectionSourceSchema,
    reason: z.string().min(1),
    escalationLocked: z.boolean(),
    promotions: z.number().int().min(0).max(2),
    history: z.array(escalationEntrySchema).max(2).readonly(),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.pool.profiles[value.profile].modelId !== value.modelId)
      issue("Pi model selection is outside its frozen profile pool");
    const explicit = value.source.startsWith("explicit_");
    if (value.source === "automatic" && !value.pool.autoSelect)
      issue("Pi automatic selection requires automatic routing");
    if (value.source === "default" && value.pool.autoSelect)
      issue("Pi default selection requires disabled automatic routing");
    if ((explicit || !value.pool.allowEscalation) && !value.escalationLocked)
      issue("Pi model selection must lock explicit or disabled escalation");
    if (value.promotions !== value.history.length)
      issue("Pi model selection promotion count must match history");
    if (value.escalationLocked && value.promotions !== 0)
      issue("Pi model selection cannot promote a locked task");
    if (!explicit && value.thinkingLevel !== value.pool.profiles[value.profile].thinkingLevel)
      issue("Pi automatic selection must use profile thinking effort");
    for (const [index, entry] of value.history.entries()) {
      if (profileRank[entry.to] !== profileRank[entry.from] + 1)
        issue("Pi model escalation must move one profile upward");
      if (index > 0 && value.history[index - 1]?.to !== entry.from)
        issue("Pi model escalation history must be contiguous");
    }
    if (value.history.length > 0 && value.history.at(-1)?.to !== value.profile)
      issue("Pi model escalation history must end at the selected profile");
  })
  .readonly()
  .brand<"PiModelSelection">();
/** Current model choice plus immutable pool evidence and promotion history for retry/restart fidelity. */
export type PiModelSelection = z.infer<typeof PiModelSelectionSchema>;
