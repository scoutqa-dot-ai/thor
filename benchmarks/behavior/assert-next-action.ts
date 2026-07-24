import { pathToFileURL } from "node:url";

import type {
  AssertionResult,
  BehaviorAssertion,
  Checkpoint,
  JsonObject,
  JsonValue,
  NormalizedFunctionCall,
  NormalizedResponse,
  ReplyExpectation,
  ToolExpectation,
} from "./types.js";

function fail(reason: string): AssertionResult {
  return { pass: false, reason };
}

function pass(reason = "next action matched"): AssertionResult {
  return { pass: true, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(value: unknown): {
  parsed?: JsonObject;
  raw: string;
  error?: string;
} {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!isObject(parsed)) {
      return { raw, error: "function arguments must be a JSON object" };
    }
    return { parsed: parsed as JsonObject, raw };
  } catch (error) {
    return {
      raw,
      error: `function arguments are malformed JSON: ${String(error)}`,
    };
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(isObject)
    .filter(
      (part) => part.type === "output_text" || part.type === "text" || part.type === "input_text",
    )
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function normalizeResponse(raw: unknown): NormalizedResponse {
  if (!isObject(raw)) {
    return { text: typeof raw === "string" ? raw : "", function_calls: [], raw };
  }

  const output = Array.isArray(raw.output) ? raw.output : [];
  const text: string[] = [];
  const functionCalls: NormalizedFunctionCall[] = [];

  for (const item of output) {
    if (!isObject(item)) {
      continue;
    }
    if (item.type === "function_call") {
      const parsed = parseArguments(item.arguments);
      if (parsed.error || !parsed.parsed) {
        functionCalls.push({
          call_id: typeof item.call_id === "string" ? item.call_id : undefined,
          name: typeof item.name === "string" ? item.name : "",
          arguments: {},
          raw_arguments: parsed.raw,
        });
        continue;
      }
      functionCalls.push({
        call_id: typeof item.call_id === "string" ? item.call_id : undefined,
        name: typeof item.name === "string" ? item.name : "",
        arguments: parsed.parsed,
        raw_arguments: parsed.raw,
      });
      continue;
    }
    if (item.type === "message") {
      text.push(contentText(item.content));
    }
  }

  // Promptfoo providers can return the Responses object as `raw`, or place a
  // rendered string in `output`. The latter is useful for assertion unit tests.
  if (output.length === 0 && typeof raw.output === "string") {
    text.push(raw.output);
  }
  if (text.length === 0 && typeof raw.output_text === "string") {
    text.push(raw.output_text);
  }

  return {
    text: text.join("\n").trim(),
    function_calls: functionCalls,
    raw,
  };
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index] as JsonValue))
    );
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) && deepEqual(left[key] as JsonValue, right[key] as JsonValue),
      )
    );
  }
  return false;
}

function contains(actual: JsonValue, expected: JsonValue, path = "$"): string | null {
  if (typeof expected === "string") {
    return typeof actual === "string" && actual.includes(expected)
      ? null
      : `${path} must contain ${JSON.stringify(expected)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || !deepEqual(actual, expected)) {
      return `${path} must exactly match the expected array`;
    }
    return null;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      return `${path} must be an object`;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) {
        return `${path}.${key} is missing`;
      }
      const mismatch = contains(actual[key] as JsonValue, value as JsonValue, `${path}.${key}`);
      if (mismatch) {
        return mismatch;
      }
    }
    return null;
  }
  return deepEqual(actual, expected) ? null : `${path} does not match`;
}

export function assertionPath(assertDirectory: string, name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid assertion name ${JSON.stringify(name)}`);
  }
  return `${assertDirectory}/${name}.ts`;
}

export async function loadAssertion(
  assertDirectory: string,
  name: string,
): Promise<BehaviorAssertion> {
  const path = assertionPath(assertDirectory, name);
  let imported: { default?: unknown };
  try {
    imported = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`assertion "${name}" could not be loaded from ${path}: ${String(error)}`);
  }
  if (typeof imported.default !== "function") {
    throw new Error(`assertion "${name}" must default-export a function`);
  }
  return imported.default as BehaviorAssertion;
}

async function gradeTool(
  checkpoint: Checkpoint,
  response: NormalizedResponse,
  expectation: ToolExpectation,
  assertDirectory: string,
): Promise<AssertionResult> {
  if (response.function_calls.length !== 1) {
    return fail(
      `expected exactly one ${expectation.name} call, received ${response.function_calls.length}`,
    );
  }
  const call = response.function_calls[0]!;
  if (!call.name) {
    return fail("function call has no name or malformed arguments");
  }
  if (call.name !== expectation.name) {
    return fail(`expected tool ${expectation.name}, received ${call.name}`);
  }

  if (expectation.arguments_exact) {
    if (!deepEqual(call.arguments, expectation.arguments_exact)) {
      return fail(
        `arguments did not exactly match: expected ${JSON.stringify(expectation.arguments_exact)}, received ${call.raw_arguments}`,
      );
    }
  } else if (expectation.arguments_contain) {
    const mismatch = contains(call.arguments, expectation.arguments_contain);
    if (mismatch) {
      return fail(`arguments mismatch: ${mismatch}`);
    }
  } else {
    try {
      const assertion = await loadAssertion(assertDirectory, expectation.assert);
      return await assertion({
        checkpoint,
        response,
        call,
        frozen_arguments: checkpoint.frozen_arguments,
      });
    } catch (error) {
      return fail(String(error));
    }
  }
  return pass();
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

async function gradeReply(
  checkpoint: Checkpoint,
  response: NormalizedResponse,
  expectation: ReplyExpectation,
  assertDirectory: string,
): Promise<AssertionResult> {
  if ("assert" in expectation && expectation.assert) {
    try {
      const assertion = await loadAssertion(assertDirectory, expectation.assert);
      const result = await assertion({ checkpoint, response });
      if (!result.pass) {
        return result;
      }
    } catch (error) {
      return fail(String(error));
    }
  } else if (response.function_calls.length > 0) {
    return fail(
      `expected a reply without function calls, received ${response.function_calls.length} call(s)`,
    );
  }

  const folded = response.text.toLocaleLowerCase();
  for (const required of expectation.contains_all ?? []) {
    if (!folded.includes(required.toLocaleLowerCase())) {
      return fail(`reply is missing required content ${JSON.stringify(required)}`);
    }
  }
  for (const forbidden of expectation.contains_none ?? []) {
    if (folded.includes(forbidden.toLocaleLowerCase())) {
      return fail(`reply contains forbidden content ${JSON.stringify(forbidden)}`);
    }
  }
  const words = wordCount(response.text);
  if (expectation.max_words !== undefined && words > expectation.max_words) {
    return fail(`reply has ${words} words; maximum is ${expectation.max_words}`);
  }
  if (expectation.min_words !== undefined && words < expectation.min_words) {
    return fail(`reply has ${words} words; minimum is ${expectation.min_words}`);
  }
  return pass();
}

export async function gradeNextAction(
  checkpoint: Checkpoint,
  rawResponse: unknown,
  assertDirectory: string,
): Promise<AssertionResult> {
  const response = normalizeResponse(rawResponse);
  return checkpoint.expectation_type === "tool"
    ? gradeTool(checkpoint, response, checkpoint.expectation as ToolExpectation, assertDirectory)
    : gradeReply(checkpoint, response, checkpoint.expectation as ReplyExpectation, assertDirectory);
}
