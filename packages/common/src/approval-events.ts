import { z } from "zod/v4";

export const APPROVAL_TOOL_NAMES = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "create-feature-flag",
] as const;

export const CreateJiraIssueApprovalArgsSchema = z
  .object({
    projectKey: z.string().min(1),
    issueTypeName: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().optional(),
  })
  .passthrough();

export const AddCommentToJiraIssueApprovalArgsSchema = z
  .object({
    issueIdOrKey: z.string().min(1),
    commentBody: z.string().min(1),
  })
  .passthrough();

export const CreateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    rolloutPercentage: z.number().optional(),
    filters: z.unknown().optional(),
  })
  .passthrough();

export const ApprovalArgsSchema = z.union([
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
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
]);

export type ApprovalToolName = (typeof APPROVAL_TOOL_NAMES)[number];
export type ApprovalArgs = z.infer<typeof ApprovalArgsSchema>;
export type ApprovalRequiredEventPayload = z.infer<typeof ApprovalRequiredEventPayloadSchema>;

const APPROVAL_TOOLS_REQUIRING_DISCLAIMER = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "create-feature-flag",
] as const satisfies readonly ApprovalToolName[];

export function approvalToolRequiresDisclaimer(tool: string): boolean {
  return (APPROVAL_TOOLS_REQUIRING_DISCLAIMER as readonly string[]).includes(tool);
}

export function validateDisclaimerCompatibleArgs(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!approvalToolRequiresDisclaimer(tool)) return undefined;
  const contentFormat = args.contentFormat;
  if (contentFormat === undefined || contentFormat === "markdown") return undefined;
  const formatted =
    typeof contentFormat === "string" ? `"${contentFormat}"` : JSON.stringify(contentFormat);
  return [
    `"${tool}" is not allowed.`,
    `Reason: contentFormat ${formatted} is not supported — only "markdown" is permitted.`,
  ].join("\n");
}

export function injectApprovalDisclaimer(
  tool: string,
  args: Record<string, unknown>,
  footer: string,
): Record<string, unknown> {
  const parsed = ApprovalRequiredEventPayloadSchema.safeParse({
    type: "approval_required",
    actionId: "_disclaimer",
    tool,
    args,
  });
  if (!parsed.success) return args;
  switch (parsed.data.tool) {
    case "createJiraIssue":
    case "create-feature-flag":
      return {
        ...parsed.data.args,
        description: parsed.data.args.description
          ? `${parsed.data.args.description}\n${footer}`
          : footer,
      };
    case "addCommentToJiraIssue":
      return {
        ...parsed.data.args,
        commentBody: `${parsed.data.args.commentBody}\n${footer}`,
      };
  }
}
