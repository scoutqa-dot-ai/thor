import { z } from "zod";

const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});
const piRunnerConfigSchema = z.object({
  internalSecret: z.string().min(1),
  /** Existing public viewer base; artwork validation belongs to the progress boundary. */
  runnerBaseUrl: z.string().optional(),
  slackTeamId: z.string().trim().min(1).optional(),
  executorUrl: httpUrlSchema.refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash;
  }),
  storagePath: z.string().min(1),
  modelBaseUrl: httpUrlSchema,
  modelId: z.string().min(1),
  modelApiKey: z.string().min(1),
  modelContextWindow: z.coerce.number().int().min(32768),
  modelSupportsImages: z.enum(["true", "false"]).transform((value) => value === "true"),
  skillsDir: z.string().startsWith("/"),
  memoryDir: z.string().startsWith("/"),
});

/** Embedded Pi startup configuration; the API key is only supplied to the model provider, never the executor. */
export type PiRunnerConfig = z.infer<typeof piRunnerConfigSchema>;

/** Parse Pi environment without echoing values in configuration failures. */
export function parsePiRunnerConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; value: PiRunnerConfig } | { ok: false; error: "pi_configuration_invalid" } {
  const result = piRunnerConfigSchema.safeParse({
    internalSecret: env.THOR_INTERNAL_SECRET,
    runnerBaseUrl: env.RUNNER_BASE_URL,
    slackTeamId: env.SLACK_TEAM_ID?.trim() || undefined,
    executorUrl: env.PI_EXECUTOR_URL ?? "http://pi-executor:3002",
    storagePath: env.PI_STORAGE_PATH ?? "/var/lib/runner/pi.sqlite",
    modelBaseUrl: env.PI_MODEL_BASE_URL ?? "http://codex-lb:2455/v1",
    modelId: env.PI_MODEL_ID ?? "gpt-5.4",
    modelApiKey: env.PI_MODEL_API_KEY ?? "codex-lb-local",
    modelContextWindow: env.PI_MODEL_CONTEXT_WINDOW ?? 272000,
    modelSupportsImages: env.PI_MODEL_SUPPORTS_IMAGES ?? "true",
    skillsDir: env.PI_SKILLS_DIR ?? "/etc/thor/skills",
    memoryDir: env.PI_MEMORY_DIR ?? "/workspace/memory",
  });
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: "pi_configuration_invalid" };
}
