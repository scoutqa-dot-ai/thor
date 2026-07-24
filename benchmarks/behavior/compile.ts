import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { assertionPath, gradeNextAction, loadAssertion } from "./assert-next-action.js";
import { responseTools, tools } from "./tools.js";
import type {
  Checkpoint,
  JsonObject,
  JsonValue,
  PromptSource,
  ResponseInputItem,
  Scenario,
  SuiteProvenance,
  ToolStep,
  TrajectoryStep,
} from "./types.js";

const behaviorDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(behaviorDirectory, "../..");
export const scenarioDirectory = resolve(behaviorDirectory, "scenarios");
export const assertDirectory = resolve(behaviorDirectory, "asserts");
export const buildPromptPath = resolve(repositoryRoot, "docker/opencode/config/agents/build.md");
export const toolCatalogPath = resolve(behaviorDirectory, "tools.ts");
export const compilerPath = resolve(behaviorDirectory, "compile.ts");
export const codexLbConfigPath = resolve(repositoryRoot, "docker/opencode/config/opencode.json");

interface LoadedScenario {
  readonly scenario: Scenario;
  readonly path: string;
}

export interface CompileOptions {
  readonly scenarios?: readonly LoadedScenario[];
  readonly endpoint?: string;
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly additionalRequestParameters?: Readonly<Record<string, JsonValue>>;
  readonly promptfooVersion?: string;
}

export interface CompiledSuite {
  readonly checkpoints: readonly Checkpoint[];
  readonly prompt: PromptSource;
  readonly provenance: SuiteProvenance;
  readonly warnings: readonly string[];
}

function repoPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function parseFrontmatter(
  source: string,
  path: string,
): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!source.startsWith("---\n")) {
    throw new Error(`${repoPath(path)} must start with YAML frontmatter`);
  }
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(`${repoPath(path)} has unterminated frontmatter`);
  }
  const frontmatter: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.+)$/u.exec(line);
    if (!match) {
      throw new Error(`${repoPath(path)} has unsupported frontmatter line: ${line}`);
    }
    frontmatter[match[1]!] = match[2]!.trim();
  }
  return { frontmatter, body: source.slice(end + 5) };
}

export async function loadBuildPrompt(path = buildPromptPath): Promise<PromptSource> {
  const parsed = parseFrontmatter(await readFile(path, "utf8"), path);
  const configuredModel = parsed.frontmatter.model;
  if (!configuredModel) {
    throw new Error(`${repoPath(path)} frontmatter must define model`);
  }
  const providerSeparator = configuredModel.indexOf("/");
  if (providerSeparator <= 0 || providerSeparator === configuredModel.length - 1) {
    throw new Error(
      `${repoPath(path)} model must use provider/model form, received ${configuredModel}`,
    );
  }
  if (!parsed.body.trim()) {
    throw new Error(`${repoPath(path)} prompt body must not be empty`);
  }
  return {
    path: repoPath(path),
    instructions: parsed.body,
    configured_model: configuredModel,
    default_codex_lb_model: configuredModel.slice(providerSeparator + 1),
  };
}

export async function loadCodexLbWhitelist(path = codexLbConfigPath): Promise<readonly string[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    provider?: { openai?: { whitelist?: unknown } };
  };
  const whitelist = parsed.provider?.openai?.whitelist;
  if (!Array.isArray(whitelist) || whitelist.some((model) => typeof model !== "string")) {
    throw new Error(`${repoPath(path)} has no string provider.openai.whitelist`);
  }
  return whitelist as string[];
}

export async function loadScenarios(
  directory = scenarioDirectory,
): Promise<readonly LoadedScenario[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();
  if (files.length === 0) {
    throw new Error(`${repoPath(directory)} contains no scenario modules`);
  }
  const loaded: LoadedScenario[] = [];
  for (const file of files) {
    const path = resolve(directory, file);
    const imported = (await import(pathToFileURL(path).href)) as {
      default?: unknown;
    };
    if (!imported.default || typeof imported.default !== "object") {
      throw new Error(`${repoPath(path)} must default-export a Scenario object`);
    }
    loaded.push({ scenario: imported.default as Scenario, path });
  }
  return loaded;
}

function validateCatalog(): Map<string, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (validators.has(tool.name)) {
      throw new Error(`tool catalog contains duplicate name ${tool.name}`);
    }
    validators.set(tool.name, ajv.compile(tool.input_schema as Record<string, unknown>));
  }
  return validators;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function expectationAssert(step: TrajectoryStep): string | undefined {
  if ("expect_tool" in step && step.expect_tool && "assert" in step.expect_tool) {
    return step.expect_tool.assert;
  }
  if ("expect_reply" in step && step.expect_reply && "assert" in step.expect_reply) {
    return step.expect_reply.assert;
  }
  return undefined;
}

async function ensureAssertion(name: string): Promise<string> {
  const path = assertionPath(assertDirectory, name);
  await loadAssertion(assertDirectory, name);
  return path;
}

function validateBasicScenario(scenario: Scenario, path: string): void {
  const where = repoPath(path);
  if (scenario.schema_version !== 1) {
    throw new Error(`${where}: unsupported schema_version`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) {
    throw new Error(`${where}: id must be lowercase kebab-case`);
  }
  if (!scenario.title.trim() || !scenario.category.trim()) {
    throw new Error(`${where}: title and category must be non-empty`);
  }
  if (scenario.messages.length === 0) {
    throw new Error(`${where}: messages must not be empty`);
  }
  if (scenario.messages.some((message) => !message.content.trim())) {
    throw new Error(`${where}: authored messages must have non-empty content`);
  }
  if (scenario.trajectory.length === 0) {
    throw new Error(`${where}: trajectory must not be empty`);
  }
  for (const [index, step] of scenario.trajectory.entries()) {
    const final = index === scenario.trajectory.length - 1;
    if (final && !("expect_reply" in step)) {
      throw new Error(`${where}: final trajectory step must expect a reply`);
    }
    if (!final && !("expect_tool" in step)) {
      throw new Error(`${where}: non-final trajectory step ${index + 1} must expect a tool`);
    }
  }
}

function validateContainsSafety(step: ToolStep, where: string): void {
  if (
    step.expect_tool.name === "bash" &&
    step.expect_tool.arguments_contain !== undefined &&
    Object.hasOwn(step.expect_tool.arguments_contain, "command")
  ) {
    throw new Error(
      `${where}: bash.command cannot use arguments_contain; use arguments_exact or assert`,
    );
  }
}

function callId(scenarioId: string, stepIndex: number): string {
  return `call_${scenarioId.replaceAll("-", "_")}_${stepIndex + 1}`;
}

function resultOutput(result: JsonValue): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

function validateCheckpointLinks(checkpoint: Checkpoint): void {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of checkpoint.input) {
    if (item.type === "function_call") {
      if (calls.has(item.call_id)) {
        throw new Error(`${checkpoint.id}: duplicate function call ID ${item.call_id}`);
      }
      calls.add(item.call_id);
      JSON.parse(item.arguments);
    } else if (item.type === "function_call_output") {
      if (!calls.has(item.call_id)) {
        throw new Error(`${checkpoint.id}: output ${item.call_id} has no preceding function call`);
      }
      if (outputs.has(item.call_id)) {
        throw new Error(`${checkpoint.id}: duplicate output for ${item.call_id}`);
      }
      outputs.add(item.call_id);
    }
  }
  for (const id of calls) {
    if (!outputs.has(id)) {
      throw new Error(`${checkpoint.id}: function call ${id} has no linked output`);
    }
  }
}

async function validateAndCompileScenario(
  loaded: LoadedScenario,
  prompt: PromptSource,
  validators: ReadonlyMap<string, ValidateFunction>,
): Promise<readonly Checkpoint[]> {
  const { scenario, path } = loaded;
  validateBasicScenario(scenario, path);
  const history: ResponseInputItem[] = scenario.messages.map((message) => ({
    type: "message" as const,
    role: message.role,
    content: message.content,
  }));
  const checkpoints: Checkpoint[] = [];
  const scenarioPath = repoPath(path);

  for (const [index, step] of scenario.trajectory.entries()) {
    const assertionName = expectationAssert(step);
    const assertionSource = assertionName
      ? repoPath(await ensureAssertion(assertionName))
      : undefined;
    const sourcePaths = [
      prompt.path,
      repoPath(toolCatalogPath),
      scenarioPath,
      repoPath(compilerPath),
      ...(assertionSource ? [assertionSource] : []),
    ];
    const id = `${scenario.id}#${index + 1}`;

    if (step.expect_tool) {
      const validator = validators.get(step.expect_tool.name);
      if (!validator) {
        throw new Error(`${id}: unknown tool ${step.expect_tool.name}`);
      }
      validateContainsSafety(step, id);
      if (!validator(step.frozen_arguments)) {
        throw new Error(
          `${id}: frozen_arguments do not match ${step.expect_tool.name}: ${formatSchemaErrors(validator.errors)}`,
        );
      }
      const checkpoint: Checkpoint = {
        id,
        scenario_id: scenario.id,
        scenario_title: scenario.title,
        category: scenario.category,
        step_index: index,
        instructions: prompt.instructions,
        input: [...history],
        tools: responseTools,
        expectation: step.expect_tool,
        expectation_type: "tool",
        frozen_arguments: step.frozen_arguments,
        source_paths: sourcePaths,
      };
      if (assertionName) {
        const goldenResponse = {
          output: [
            {
              type: "function_call",
              call_id: callId(scenario.id, index),
              name: step.expect_tool.name,
              arguments: JSON.stringify(step.frozen_arguments),
            },
          ],
        };
        const result = await gradeNextAction(checkpoint, goldenResponse, assertDirectory);
        if (!result.pass) {
          throw new Error(`${id}: assertion rejects frozen_arguments: ${result.reason}`);
        }
      } else {
        const result = await gradeNextAction(
          checkpoint,
          {
            output: [
              {
                type: "function_call",
                call_id: callId(scenario.id, index),
                name: step.expect_tool.name,
                arguments: JSON.stringify(step.frozen_arguments),
              },
            ],
          },
          assertDirectory,
        );
        if (!result.pass) {
          throw new Error(`${id}: expectation rejects frozen_arguments: ${result.reason}`);
        }
      }
      checkpoints.push(checkpoint);
      const idForCall = callId(scenario.id, index);
      history.push({
        type: "function_call" as const,
        call_id: idForCall,
        name: step.expect_tool.name,
        arguments: JSON.stringify(step.frozen_arguments),
      });
      history.push({
        type: "function_call_output" as const,
        call_id: idForCall,
        output: resultOutput(step.result),
      });
    } else {
      checkpoints.push({
        id,
        scenario_id: scenario.id,
        scenario_title: scenario.title,
        category: scenario.category,
        step_index: index,
        instructions: prompt.instructions,
        input: [...history],
        tools: responseTools,
        expectation: step.expect_reply,
        expectation_type: "reply",
        source_paths: sourcePaths,
      });
    }
  }
  checkpoints.forEach(validateCheckpointLinks);
  return checkpoints;
}

function endpointKind(endpoint: string): "codex-lb" | "openai" | "other" {
  if (/codex-lb|127\.0\.0\.1:2455|localhost:2455/u.test(endpoint)) {
    return "codex-lb";
  }
  return endpoint.includes("api.openai.com") ? "openai" : "other";
}

function gitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export async function compileSuite(options: CompileOptions = {}): Promise<CompiledSuite> {
  const prompt = await loadBuildPrompt();
  const endpoint = (options.endpoint ?? "http://127.0.0.1:2455/v1").replace(/\/+$/u, "");
  const model =
    options.model ??
    (endpointKind(endpoint) === "codex-lb"
      ? prompt.default_codex_lb_model
      : (() => {
          throw new Error("a model is required when the endpoint is not codex-lb");
        })());
  const warnings: string[] = [];
  if (endpointKind(endpoint) === "codex-lb") {
    const whitelist = await loadCodexLbWhitelist();
    if (!whitelist.includes(model)) {
      warnings.push(
        `model ${model} is not in ${repoPath(codexLbConfigPath)}; codex-lb may reject it`,
      );
    }
  }

  const scenarios = options.scenarios ?? (await loadScenarios());
  const duplicateIds = scenarios
    .map(({ scenario }) => scenario.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`duplicate scenario IDs: ${[...new Set(duplicateIds)].join(", ")}`);
  }
  const validators = validateCatalog();
  const checkpoints = (
    await Promise.all(
      scenarios.map((scenario) => validateAndCompileScenario(scenario, prompt, validators)),
    )
  ).flat();
  const sourcePaths = [
    ...new Set(checkpoints.flatMap((checkpoint) => checkpoint.source_paths)),
  ].sort();
  return {
    checkpoints,
    prompt,
    warnings,
    provenance: {
      git_sha: gitSha(),
      source_paths: sourcePaths,
      promptfoo_version: options.promptfooVersion ?? "not-installed",
      endpoint,
      model,
      request: {
        parallel_tool_calls: false,
        store: false,
        reasoning_effort: options.reasoningEffort ?? null,
        additional: options.additionalRequestParameters ?? {},
      },
    },
  };
}

async function main(): Promise<void> {
  const suite = await compileSuite({
    endpoint: process.env.THOR_BEHAVIOR_EVAL_BASE_URL,
    model: process.env.THOR_BEHAVIOR_EVAL_MODEL,
  });
  for (const warning of suite.warnings) {
    console.warn(`warning: ${warning}`);
  }
  console.log(
    `Validated ${suite.checkpoints.length} checkpoints from ${new Set(suite.checkpoints.map((checkpoint) => checkpoint.scenario_id)).size} scenarios.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
