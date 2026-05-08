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

export const CreateJiraIssuePresentationArgsSchema = z
  .object({
    cloudId: z.string().min(1).optional(),
    projectKey: z.string().min(1),
    issueTypeName: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().optional(),
    parent: z.string().min(1).optional(),
    assignee_account_id: z.string().min(1).optional(),
    additional_fields: z.record(z.string(), z.unknown()).optional(),
    transition: z.object({ id: z.string().min(1) }).optional(),
    contentFormat: z.enum(["markdown", "adf"]).optional(),
    responseContentFormat: z.enum(["markdown", "adf"]).optional(),
  })
  .strict();

export const AddCommentToJiraIssueApprovalArgsSchema = z
  .object({
    issueKey: z.unknown().optional(),
    commentBody: z.unknown().optional(),
  })
  .passthrough();

export const AddCommentToJiraIssuePresentationArgsSchema = z
  .object({
    cloudId: z.string().min(1).optional(),
    issueIdOrKey: z.string().min(1),
    commentBody: z.string().min(1),
    commentVisibility: z
      .object({
        type: z.enum(["group", "role"]),
        value: z.string().min(1),
      })
      .optional(),
    contentFormat: z.enum(["markdown", "adf"]).optional(),
    responseContentFormat: z.enum(["markdown", "adf"]).optional(),
  })
  .strict();

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

export const CreateFeatureFlagPresentationArgsSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    rolloutPercentage: z.number().optional(),
    filters: z.unknown().optional(),
  })
  .strict();

export const UpdateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.unknown().optional(),
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    active: z.unknown().optional(),
    rolloutPercentage: z.unknown().optional(),
    filters: z.unknown().optional(),
  })
  .passthrough();

export const UpdateFeatureFlagPresentationArgsSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    rolloutPercentage: z.number().optional(),
    filters: z.unknown().optional(),
  })
  .strict();

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
