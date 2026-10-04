import { z } from "zod/v4";
import { McpCallInputSchema, McpNativeAuthoritySchema, McpToolRefSchema } from "./mcp-broker.js";

const genericActionId = z.uuidv7().brand<"GenericMcpApprovalId">();
const activationId = z.uuid().brand<"McpBrokerActivationId">();

/** Generic approval records never use a bare tool name as an operation discriminator. */
export const GenericMcpApprovalSchema = z
  .strictObject({
    version: z.literal(1),
    operation: z.literal("genericMcp"),
    id: genericActionId,
    dateSegment: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    server: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    tool: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
    arguments: McpCallInputSchema.shape.arguments,
    effectiveArguments: McpCallInputSchema.shape.arguments,
    preparationVersion: z.literal(1),
    activationId,
    connectionRevision: z.string().min(1).max(80),
    catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    toolRef: McpToolRefSchema,
    authority: McpNativeAuthoritySchema,
    destination: z.strictObject({
      teamId: z.string().min(1),
      userId: z.string().min(1),
      channel: z.string().regex(/^D[A-Z0-9]+$/),
    }),
    notification: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("intent") }),
      z.strictObject({ status: z.literal("confirmed"), messageTs: z.string().min(1) }),
      z.strictObject({ status: z.literal("uncertain") }),
    ]),
    dispatch: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("pending") }),
      z.strictObject({
        status: z.literal("rejected"),
        reason: z.enum(["human", "stale", "expired", "notification_unconfirmed"]),
      }),
      z.strictObject({ status: z.literal("consumed"), claimedAt: z.iso.datetime() }),
      z.strictObject({
        status: z.literal("confirmed"),
        claimedAt: z.iso.datetime(),
        isError: z.boolean(),
      }),
    ]),
  })
  .superRefine((record, ctx) => {
    if (
      (record.dispatch.status === "consumed" || record.dispatch.status === "confirmed") &&
      record.notification.status !== "confirmed"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Generic MCP dispatch requires confirmed private notification",
      });
    }
    if (
      record.authority.requester.source !== "slack" ||
      record.authority.requester.id !== record.destination.userId ||
      record.authority.teamId !== record.destination.teamId ||
      record.dateSegment !== record.createdAt.slice(0, 10) ||
      Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
      JSON.stringify(record.arguments) !== JSON.stringify(record.effectiveArguments)
    ) {
      // Generic preparation v1 has no rewriting adapter, so effective and reviewed JSON must agree.
      ctx.addIssue({ code: "custom", message: "Generic MCP frozen authority invalid" });
    }
  });
/** Frozen proof and durable disposition, not a retryable invocation ledger. */
export type GenericMcpApproval = z.infer<typeof GenericMcpApprovalSchema>;

/** Only the signed-interactivity gateway forwards this evidence over authenticated transport. */
export const McpApprovalClickSchema = z.strictObject({
  actionId: genericActionId,
  decision: z.enum(["approved", "rejected"]),
  userId: z.string().min(1),
  teamId: z.string().min(1),
  channel: z.string().min(1),
  messageTs: z.string().min(1),
});
/** Slack hints are not proof: all fields must match the stored private delivery. */
export type McpApprovalClick = z.infer<typeof McpApprovalClickSchema>;

/** Reader scope must originate at an authenticated host boundary, never CLI attribution. */
export const McpApprovalReaderSchema = z.strictObject({
  requester: McpNativeAuthoritySchema.shape.requester,
  teamId: McpNativeAuthoritySchema.shape.teamId,
  repositoryDirectory: McpNativeAuthoritySchema.shape.repositoryDirectory,
  sourceKey: McpNativeAuthoritySchema.shape.sourceKey,
  requestId: McpNativeAuthoritySchema.shape.requestId,
  sessionId: McpNativeAuthoritySchema.shape.sessionId,
});
/** Stored readers retain scope even after the corresponding catalog entry is removed. */
export type McpApprovalReader = z.infer<typeof McpApprovalReaderSchema>;
/** No raw arguments, results, credentials or vendor failures cross continuation/status edges. */
export const McpApprovalProjectionSchema = z.strictObject({
  actionId: genericActionId,
  server: z.string().min(1),
  tool: z.string().min(1),
  disposition: z.enum(["pending", "rejected", "completed", "tool_error", "uncertain"]),
  channel: z.string().regex(/^D[A-Z0-9]+$/),
  threadTs: z.string().optional(),
  repositoryDirectory: McpApprovalReaderSchema.shape.repositoryDirectory,
  requester: z.string().min(1),
  reader: McpApprovalReaderSchema,
});
/** Minimal stored result disposition and private continuation scope; no raw provider output. */
export type McpApprovalProjection = z.infer<typeof McpApprovalProjectionSchema>;
/** Gateway resolution is safe to publish only to its stored, confirmed private audience. */
export type McpApprovalResolution =
  | { readonly status: "denied" | "busy"; readonly message: string }
  | { readonly status: "generic"; readonly value: McpApprovalProjection };
