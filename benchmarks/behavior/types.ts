import type { tools } from "./tools.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly strict: boolean;
}

export type ToolCatalog = readonly ToolDefinition[];
export type ToolName = (typeof tools)[number]["name"];

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

type ToolMatcher =
  | {
      readonly arguments_contain: JsonObject;
      readonly arguments_exact?: never;
      readonly assert?: never;
    }
  | {
      readonly arguments_contain?: never;
      readonly arguments_exact: JsonObject;
      readonly assert?: never;
    }
  | {
      readonly arguments_contain?: never;
      readonly arguments_exact?: never;
      readonly assert: string;
    };

export type ToolExpectation = {
  readonly name: ToolName;
} & ToolMatcher;

export interface ToolStep {
  readonly expect_tool: ToolExpectation;
  readonly expect_reply?: never;
  readonly frozen_arguments: JsonObject;
  readonly result: JsonValue;
}

interface ReplyConstraints {
  readonly contains_all?: readonly string[];
  readonly contains_none?: readonly string[];
  readonly max_words?: number;
  readonly min_words?: number;
}

type ReplyBuiltInExpectation = ReplyConstraints &
  (
    | { readonly contains_all: readonly string[] }
    | { readonly contains_none: readonly string[] }
    | { readonly max_words: number }
    | { readonly min_words: number }
  ) & { readonly assert?: never };

type ReplyScriptExpectation = ReplyConstraints & {
  readonly assert: string;
};

export type ReplyExpectation = ReplyBuiltInExpectation | ReplyScriptExpectation;

export interface ReplyStep {
  readonly expect_tool?: never;
  readonly expect_reply: ReplyExpectation;
  readonly frozen_arguments?: never;
  readonly result?: never;
}

export type TrajectoryStep = ToolStep | ReplyStep;

export interface Scenario {
  readonly schema_version: 1;
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly messages: readonly ConversationMessage[];
  readonly trajectory: readonly TrajectoryStep[];
}

export interface ResponseMessageItem {
  readonly type: "message";
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ResponseFunctionCallItem {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: ToolName;
  readonly arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

export type ResponseInputItem =
  ResponseMessageItem | ResponseFunctionCallItem | ResponseFunctionCallOutputItem;

export interface ResponseFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly strict: boolean;
}

export interface Checkpoint {
  readonly id: string;
  readonly scenario_id: string;
  readonly scenario_title: string;
  readonly category: string;
  readonly step_index: number;
  readonly instructions: string;
  readonly input: readonly ResponseInputItem[];
  readonly tools: readonly ResponseFunctionTool[];
  readonly expectation: ToolExpectation | ReplyExpectation;
  readonly expectation_type: "tool" | "reply";
  readonly frozen_arguments?: JsonObject;
  readonly source_paths: readonly string[];
}

export interface NormalizedFunctionCall {
  readonly call_id?: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly raw_arguments: string;
  readonly parse_error?: string;
}

export interface NormalizedResponse {
  readonly text: string;
  readonly function_calls: readonly NormalizedFunctionCall[];
  readonly raw: unknown;
}

export interface AssertionContext {
  readonly checkpoint: Checkpoint;
  readonly response: NormalizedResponse;
  readonly call?: NormalizedFunctionCall;
  readonly frozen_arguments?: JsonObject;
}

export interface AssertionResult {
  readonly pass: boolean;
  readonly reason: string;
}

export type BehaviorAssertion = (
  context: AssertionContext,
) => AssertionResult | Promise<AssertionResult>;

export interface PromptSource {
  readonly path: string;
  readonly instructions: string;
  readonly configured_model: string;
  readonly default_codex_lb_model: string;
}

export interface SuiteProvenance {
  readonly git_sha: string;
  readonly source_paths: readonly string[];
  readonly promptfoo_version: string;
  readonly endpoint: string;
  readonly model: string;
  readonly request: {
    readonly parallel_tool_calls: false;
    readonly store: false;
    readonly reasoning_effort: string | null;
    readonly additional: Readonly<Record<string, JsonValue>>;
  };
}
