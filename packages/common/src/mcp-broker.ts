import { z } from "zod";
import { extractRepoFromCwd, isAllowedDirectory } from "./workspace-config.js";
import { WORKSPACE_REPOS_ROOT } from "./paths.js";

const contextId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$/);
/** Resolve the canonical repository root lexically; the full admitted cwd remains executor-owned. */
export function resolveMcpRepositoryDirectory(directory: string): string | undefined {
  if (!isAllowedDirectory(directory)) return undefined;
  const repo = extractRepoFromCwd(directory);
  return repo ? `${WORKSPACE_REPOS_ROOT}/${repo}` : undefined;
}
const repositoryDirectory = z
  .string()
  .refine((directory) => resolveMcpRepositoryDirectory(directory) === directory);

/** Native tool proof is bound to discovery or dispatch, never interchangeable. */
export type McpNativeOperation = "mcp_search" | "mcp_call";

/** Native requester evidence is projected by the host, never chosen by tool arguments. */
export const McpRequesterSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("slack"), id: contextId.brand<"McpSlackRequesterId">() }),
  z.strictObject({ source: z.literal("github"), id: contextId.brand<"McpGithubRequesterId">() }),
  z.strictObject({ source: z.literal("system") }),
]);
/** Native admission projection supplements, but never replaces, the open trigger boundary. */
export const McpNativeProjectionSchema = z
  .strictObject({
    requestId: contextId.brand<"McpRequestId">(),
    directory: z.string().refine(isAllowedDirectory).brand<"McpWorkingDirectory">(),
    repositoryDirectory: repositoryDirectory.brand<"McpRepositoryDirectory">(),
    requester: McpRequesterSchema,
    teamId: contextId.brand<"McpTeamId">().nullable(),
    sourceKey: contextId.brand<"McpSourceKey">().nullable(),
  })
  .refine(
    (projection) =>
      resolveMcpRepositoryDirectory(projection.directory) === projection.repositoryDirectory,
    "MCP working directory must belong to the projected repository root",
  );
/** Private MCP context requires independent transport authentication plus current projection equality. */
export const McpNativeAuthoritySchema = McpNativeProjectionSchema.safeExtend({
  sessionId: contextId.brand<"McpSessionId">(),
  anchorId: z.uuid().brand<"McpAnchorId">(),
  triggerId: z.uuid().brand<"McpTriggerId">(),
  taskId: contextId.brand<"McpTaskId">(),
  callId: contextId.brand<"McpCallId">(),
}).strict();
/** Native authority IDs are correlation only until checked against the current host projection. */
export type McpNativeAuthority = z.infer<typeof McpNativeAuthoritySchema>;

/** Host-only call lifetime evidence; correlation IDs alone never grant native scope. */
export const McpNativeCallProjectionSchema = z.strictObject({
  nativeMcp: McpNativeAuthoritySchema,
  state: z.enum(["started", "ended"]),
});

/** Discovery accepts exact lookup or bounded search; continuation preserves the complete query. */
export const McpSearchInputSchema = z
  .strictObject({
    server: z.string().min(1).max(100).optional(),
    query: z.string().max(200).default(""),
    exactName: z.string().min(1).max(200).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .refine((input) => !input.exactName || !!input.server, "Exact lookup requires a server");
/** Search input is parsed once at each HTTP/CLI edge. */
export type McpSearchInput = z.infer<typeof McpSearchInputSchema>;
/** A tool reference identifies one exact broker revision, not a capability or credential. */
export const McpToolRefSchema = z.string().min(1).max(200).brand<"McpToolRef">();
function hasExactMcpJsonKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => key !== "__proto__" && hasExactMcpJsonKeys(child),
  );
}
// Zod records deliberately skip __proto__. Reject it at the raw JSON boundary rather
// than silently changing the approved/outbound object (including nested business data).
const McpArgumentsSchema = z
  .unknown()
  .refine(hasExactMcpJsonKeys)
  .pipe(z.record(z.string(), z.json()));

/** Call arguments are a JSON object, not argv or caller-selectable authority. */
export const McpCallInputSchema = z.strictObject({
  toolRef: McpToolRefSchema,
  arguments: McpArgumentsSchema,
});
/** An exact revision reference is discovery identity, not authorization. */
export type McpCallInput = z.infer<typeof McpCallInputSchema>;
/** Private search requests carry host context separately from discovery arguments. */
export const McpPrivateSearchSchema = z.strictObject({
  context: McpNativeAuthoritySchema,
  input: McpSearchInputSchema,
});
/** Private call requests cannot set URLs, headers, directory or requester inside the call envelope. */
export const McpPrivateCallSchema = z.strictObject({
  context: McpNativeAuthoritySchema,
  input: McpCallInputSchema,
});

/** Only reviewed metadata and complete supported schemas cross discovery. */
export interface McpToolDescriptor {
  readonly server: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly policy: "allow" | "approve";
  readonly toolRef: McpCallInput["toolRef"];
}
/** Pagination counts visible tools only and never clips a descriptor. */
export interface McpDiscoveryPage {
  readonly servers: readonly {
    readonly server: string;
    readonly available: boolean;
    readonly visibleTools?: number;
  }[];
  readonly tools: readonly McpToolDescriptor[];
  readonly cursor?: string;
}
/** Pre-dispatch failures and dispatched uncertainty have distinct, secret-free dispositions. */
export type McpBrokerFailure = {
  readonly status:
    | "denied"
    | "unavailable"
    | "stale"
    | "invalid_arguments"
    | "uncertain"
    | "review_not_supported";
  readonly isError: true;
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly keyword: string }[];
};
/** MCP results are model-visible text; binary/URI blocks are explicitly unsupported until native decoding is installed. */
export type McpCallOutcome =
  | McpBrokerFailure
  | {
      readonly status: "completed";
      readonly isError: boolean;
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
    }
  | {
      readonly status: "pending_approval";
      readonly isError: false;
      readonly actionId: string;
      readonly server: string;
      readonly tool: string;
    };
/** Observational broker operations return explicit failures rather than provider exceptions. */
export type McpDiscoveryOutcome =
  | McpBrokerFailure
  | { readonly status: "ok"; readonly value: McpDiscoveryPage };
/** Exact describe shares the same policy/revision owner as search and call. */
export type McpDescribeOutcome =
  | McpBrokerFailure
  | { readonly status: "ok"; readonly value: McpToolDescriptor };
