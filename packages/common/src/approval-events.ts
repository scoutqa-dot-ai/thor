import { z } from "zod/v4";

export const APPROVAL_TOOL_NAMES = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "create-feature-flag",
  "update-feature-flag",
] as const;

export const CreateJiraIssueApprovalArgsSchema = z
  .object({
    projectKey: z.unknown().optional(),
    issueTypeName: z.unknown().optional(),
    summary: z.unknown().optional(),
    description: z.unknown().optional(),
  })
  .passthrough();

export const AddCommentToJiraIssueApprovalArgsSchema = z
  .object({
    issueKey: z.unknown().optional(),
    commentBody: z.unknown().optional(),
  })
  .passthrough();

export const CreateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.unknown().optional(),
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    active: z.unknown().optional(),
    rolloutPercentage: z.unknown().optional(),
    filters: z.unknown().optional(),
  })
  .passthrough();

export const UpdateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.unknown().optional(),
  })
  .passthrough();

export const ApprovalArgsSchema = z.union([
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  UpdateFeatureFlagApprovalArgsSchema,
]);

const ApprovalRequiredEventBaseSchema = z.object({
  type: z.literal("approval_required"),
  actionId: z.string().min(1),
  proxyName: z.string().min(1).optional(),
});

export const ApprovalRequiredEventPayloadSchema = z.discriminatedUnion("tool", [
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("createJiraIssue"),
    args: CreateJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("addCommentToJiraIssue"),
    args: AddCommentToJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("create-feature-flag"),
    args: CreateFeatureFlagApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("update-feature-flag"),
    args: UpdateFeatureFlagApprovalArgsSchema,
  }),
]);

export type ApprovalToolName = (typeof APPROVAL_TOOL_NAMES)[number];
export type ApprovalArgs = z.infer<typeof ApprovalArgsSchema>;
export type ApprovalRequiredEventPayload = z.infer<typeof ApprovalRequiredEventPayloadSchema>;
