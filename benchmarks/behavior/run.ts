import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AssertionValueFunction,
  EvaluateOptions,
  EvaluateResult,
  EvaluateTestSuite,
  GradingResult,
} from "promptfoo";

import { gradeNextAction } from "./assert-next-action.js";
import { assertDirectory, compileSuite, repositoryRoot, type CompiledSuite } from "./compile.js";
import type { Checkpoint, JsonValue } from "./types.js";

const PROMPTFOO_VERSION = "0.121.19";
const PROTECTED_REQUEST_KEYS = new Set([
  "apiBaseUrl",
  "apiKey",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "store",
  "tools",
]);

interface RunArguments {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly scenario?: string;
  readonly category?: string;
  readonly replicates: number;
  readonly outputDirectory: string;
  readonly reasoningEffort: string | null;
  readonly additionalRequestParameters: Readonly<Record<string, JsonValue>>;
}

interface ArtifactRecord {
  readonly git_sha: string;
  readonly endpoint: string;
  readonly model: string;
  readonly request: CompiledSuite["provenance"]["request"];
  readonly promptfoo_version: string;
  readonly source_paths: readonly string[];
  readonly scenario_id: string;
  readonly checkpoint_id: string;
  readonly checkpoint: number;
  readonly replicate: number;
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string | null;
  readonly latency_ms: number;
  readonly token_usage: unknown;
  readonly cost_usd: number | null;
  readonly returned_model: string | null;
  readonly raw_response: unknown;
  readonly provider_error: string | null;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`replicates must be a positive integer, received ${value}`);
  }
  return parsed;
}

function parseRequestParameters(raw: string | undefined): Record<string, JsonValue> {
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("THOR_BEHAVIOR_EVAL_REQUEST_PARAMS must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (PROTECTED_REQUEST_KEYS.has(key)) {
      throw new Error(`THOR_BEHAVIOR_EVAL_REQUEST_PARAMS cannot override protected key ${key}`);
    }
  }
  return parsed as Record<string, JsonValue>;
}

export function parseRunArguments(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): RunArguments {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return {
    endpoint: readFlag(argv, "--endpoint") ?? env.THOR_BEHAVIOR_EVAL_BASE_URL,
    apiKey: env.THOR_BEHAVIOR_EVAL_API_KEY,
    model: readFlag(argv, "--model") ?? env.THOR_BEHAVIOR_EVAL_MODEL,
    scenario: readFlag(argv, "--scenario"),
    category: readFlag(argv, "--category"),
    replicates: positiveInteger(
      readFlag(argv, "--replicates") ?? env.THOR_BEHAVIOR_EVAL_REPLICATES,
      1,
    ),
    outputDirectory: resolve(
      repositoryRoot,
      readFlag(argv, "--output") ?? `.context/behavior-evals/${timestamp}`,
    ),
    reasoningEffort: env.THOR_BEHAVIOR_EVAL_REASONING_EFFORT?.trim() || null,
    additionalRequestParameters: parseRequestParameters(env.THOR_BEHAVIOR_EVAL_REQUEST_PARAMS),
  };
}

function returnedModel(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "model" in raw) {
    return typeof raw.model === "string" ? raw.model : null;
  }
  return null;
}

function checkpointAssertion(checkpoint: Checkpoint): AssertionValueFunction {
  return async (_output, context): Promise<GradingResult> => {
    const raw = context.providerResponse?.raw ?? context.providerResponse?.output;
    const result = await gradeNextAction(checkpoint, raw, assertDirectory);
    return {
      pass: result.pass,
      score: result.pass ? 1 : 0,
      reason: `${checkpoint.id}: ${result.reason}`,
    };
  };
}

export function buildPromptfooSuite(suite: CompiledSuite, apiKey: string): EvaluateTestSuite {
  return {
    description: `Thor behavioral next-action eval at ${suite.provenance.git_sha}`,
    prompts: ["{{input}}"],
    providers: [
      {
        id: `openai:responses:${suite.provenance.model}`,
        label: `${suite.provenance.endpoint} :: ${suite.provenance.model}`,
        config: {
          apiBaseUrl: suite.provenance.endpoint,
          apiKey,
          instructions: suite.prompt.instructions,
          tools: suite.checkpoints[0]?.tools ?? [],
          parallel_tool_calls: false,
          store: false,
          omitDefaults: true,
          ...(suite.provenance.request.reasoning_effort
            ? {
                reasoning_effort: suite.provenance.request.reasoning_effort,
              }
            : {}),
          ...suite.provenance.request.additional,
        },
      },
    ],
    tests: suite.checkpoints.map((checkpoint) => ({
      description: checkpoint.id,
      vars: { input: JSON.stringify(checkpoint.input) },
      metadata: {
        scenario_id: checkpoint.scenario_id,
        checkpoint_id: checkpoint.id,
      },
      assert: [
        {
          type: "javascript",
          value: checkpointAssertion(checkpoint),
        },
      ],
    })),
    writeLatestResults: false,
  };
}

function checkpointForResult(result: EvaluateResult, suite: CompiledSuite): Checkpoint {
  const checkpoint = suite.checkpoints[result.testIdx];
  if (!checkpoint) {
    throw new Error(`Promptfoo returned unknown test index ${result.testIdx}`);
  }
  return checkpoint;
}

function artifactForResult(
  result: EvaluateResult,
  suite: CompiledSuite,
  replicate: number,
): ArtifactRecord {
  const checkpoint = checkpointForResult(result, suite);
  const raw = result.response?.raw;
  return {
    git_sha: suite.provenance.git_sha,
    endpoint: suite.provenance.endpoint,
    model: suite.provenance.model,
    request: suite.provenance.request,
    promptfoo_version: suite.provenance.promptfoo_version,
    source_paths: checkpoint.source_paths,
    scenario_id: checkpoint.scenario_id,
    checkpoint_id: checkpoint.id,
    checkpoint: checkpoint.step_index + 1,
    replicate,
    pass: result.success,
    score: result.score,
    reason: result.gradingResult?.reason ?? null,
    latency_ms: result.latencyMs,
    token_usage: result.tokenUsage ?? result.response?.tokenUsage ?? null,
    cost_usd: result.cost ?? result.response?.cost ?? null,
    returned_model: returnedModel(raw),
    raw_response: raw ?? null,
    provider_error: result.error ?? result.response?.error ?? null,
  };
}

function assertProviderIdentity(results: readonly EvaluateResult[], suite: CompiledSuite): void {
  for (const result of results) {
    const raw = result.response?.raw;
    const actual = returnedModel(raw);
    if (actual && actual !== suite.provenance.model) {
      throw new Error(
        `model identity mismatch for ${checkpointForResult(result, suite).id}: requested ${suite.provenance.model}, received ${actual}`,
      );
    }
  }
}

async function writeArtifacts(
  records: readonly ArtifactRecord[],
  suite: CompiledSuite,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "results.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const passed = records.filter((record) => record.pass).length;
  await writeFile(
    resolve(directory, "summary.json"),
    `${JSON.stringify(
      {
        ...suite.provenance,
        checkpoints: suite.checkpoints.length,
        evaluations: records.length,
        passed,
        failed: records.length - passed,
        token_usage: records.map((record) => record.token_usage),
        cost_usd: records.reduce((total, record) => total + (record.cost_usd ?? 0), 0),
        latency_ms: records.reduce((total, record) => total + record.latency_ms, 0),
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseRunArguments();
  if (!args.apiKey) {
    throw new Error("THOR_BEHAVIOR_EVAL_API_KEY is required for model-backed evaluation");
  }
  process.env.PROMPTFOO_CONFIG_DIR ??= resolve(repositoryRoot, ".context/promptfoo");
  process.env.PROMPTFOO_DISABLE_TELEMETRY ??= "1";

  const compiled = await compileSuite({
    endpoint: args.endpoint,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    additionalRequestParameters: args.additionalRequestParameters,
    promptfooVersion: PROMPTFOO_VERSION,
  });
  const checkpoints = compiled.checkpoints.filter(
    (checkpoint) =>
      (!args.scenario || checkpoint.scenario_id === args.scenario) &&
      (!args.category || checkpoint.category === args.category),
  );
  if (checkpoints.length === 0) {
    throw new Error("no checkpoints matched the requested filters");
  }
  const sourcePaths = [
    ...new Set(checkpoints.flatMap((checkpoint) => checkpoint.source_paths)),
  ].sort();
  const suite = {
    ...compiled,
    checkpoints,
    provenance: { ...compiled.provenance, source_paths: sourcePaths },
  } satisfies CompiledSuite;
  suite.warnings.forEach((warning) => console.warn(`warning: ${warning}`));

  const promptfoo = await import("promptfoo");
  promptfoo.cache.disableCache();
  const options: EvaluateOptions = {
    cache: false,
    repeat: args.replicates,
    showProgressBar: true,
  };
  const evaluation = await promptfoo.evaluate(buildPromptfooSuite(suite, args.apiKey), options);
  const summary = await evaluation.toEvaluateSummary();
  assertProviderIdentity(summary.results, suite);

  const counts = new Map<string, number>();
  const records = summary.results.map((result) => {
    const checkpoint = checkpointForResult(result, suite);
    const replicate = (counts.get(checkpoint.id) ?? 0) + 1;
    counts.set(checkpoint.id, replicate);
    return artifactForResult(result, suite, replicate);
  });
  await writeArtifacts(records, suite, args.outputDirectory);

  const passed = records.filter((record) => record.pass).length;
  const cost = records.reduce((total, record) => total + (record.cost_usd ?? 0), 0);
  console.log(
    `${passed}/${records.length} passed; model=${suite.provenance.model}; endpoint=${suite.provenance.endpoint}; cost=$${cost.toFixed(4)}; results=${args.outputDirectory}`,
  );
  if (passed !== records.length) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
