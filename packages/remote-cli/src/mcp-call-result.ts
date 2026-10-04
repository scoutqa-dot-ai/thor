import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalRequiredEventPayload, McpCallOutcome } from "@thor/common";
import { unwrapResult } from "./unwrap-result.js";
import type { McpArgumentValidator } from "./mcp-schema-validation.js";

/** Internal CLI projection is omitted by private HTTP; native calls never parse CLI stdout. */
export type McpServiceCallOutcome = McpCallOutcome & {
  readonly cliOutput?: string;
  readonly approvalEvent?: ApprovalRequiredEventPayload;
};

/** Preserve HTTP-200 MCP errors and render structured-only/binary results without URI fetches or base64 prose. */
export function projectMcpCallResult(
  raw: unknown,
  outputValidator?: McpArgumentValidator,
): McpServiceCallOutcome {
  const parsed = CallToolResultSchema.safeParse(raw);
  if (!parsed.success)
    return {
      status: "uncertain",
      isError: true,
      message:
        "MCP result unavailable after dispatch; the outcome is uncertain. Do not retry automatically.",
    };
  const result = parsed.data;
  // SDK listTools caches output validators one page at a time. The broker's full revision
  // inventory owns this check for every permitted tool, without reaching into SDK private caches.
  if (
    outputValidator &&
    ((result.structuredContent === undefined && !result.isError) ||
      (result.structuredContent !== undefined &&
        !outputValidator.validate(result.structuredContent)))
  )
    return {
      status: "uncertain",
      isError: true,
      message:
        "MCP output invalid after dispatch; the outcome is uncertain. Do not retry automatically.",
    };
  const content = result.content.map((block) =>
    block.type === "text"
      ? { type: "text" as const, text: block.text }
      : {
          type: "text" as const,
          text: `Unsupported MCP ${block.type} content; no binary data or resource URI was opened.`,
        },
  );
  if (result.structuredContent !== undefined)
    content.unshift({ type: "text", text: JSON.stringify(result.structuredContent) });
  return {
    status: "completed",
    isError: result.isError === true,
    content,
    // Preserve the established non-text JSON CLI fallback; private protocol metadata is not returned.
    cliOutput: unwrapResult({
      content: result.content.map(({ _meta: _private, ...block }) => {
        if (block.type !== "resource") return block;
        const { _meta: _resourceMeta, ...resource } = block.resource;
        return { ...block, resource };
      }),
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    }),
  };
}

/** Translate at the legacy CLI edge, preserving its ExecResult and pending approval contracts. */
export function mcpCallToExec(outcome: McpServiceCallOutcome): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (outcome.status === "completed")
    return {
      stdout: outcome.cliOutput ?? "",
      stderr: "",
      exitCode: outcome.isError ? 1 : 0,
    };
  if (outcome.status === "pending_approval")
    return {
      stdout:
        JSON.stringify(
          { ...outcome.approvalEvent, command: `approval status ${outcome.actionId}` },
          null,
          2,
        ) + "\n",
      stderr: "",
      exitCode: 0,
    };
  return { stdout: "", stderr: outcome.message, exitCode: 1 };
}

/** The private structured edge never carries CLI copies or raw approval arguments. */
export function mcpCallToNative(outcome: McpServiceCallOutcome): McpCallOutcome {
  const { cliOutput: _cliOutput, approvalEvent: _approvalEvent, ...native } = outcome;
  return native;
}
