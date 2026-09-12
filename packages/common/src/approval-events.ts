import { z } from "zod/v4";

export const APPROVAL_TOOL_NAMES = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "editJiraIssue",
  "transitionJiraIssue",
  "create-feature-flag",
  "browser_open_authenticated",
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

export const EditJiraIssueApprovalArgsSchema = z
  .object({
    issueIdOrKey: z.string().min(1),
    fields: z.record(z.string(), z.unknown()).optional(),
    update: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const TransitionJiraIssueApprovalArgsSchema = z
  .object({
    issueIdOrKey: z.string().min(1),
    transitionId: z.string().min(1).optional(),
    transitionName: z.string().min(1).optional(),
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

const OnePasswordOpaqueIdSchema = z.string().regex(/^[a-z0-9]{26}$/);
const SafeOnePasswordLoginTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+$/u);
const BrowserPageUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "url must be HTTPS without credentials, query parameters, or a fragment");

/** Strict public arguments for safe exact-origin Login item discovery. */
export const FindLoginItemsArgsSchema = z.object({ url: BrowserPageUrlSchema }).strict();

/** Strict model-supplied arguments before trusted Login metadata enrichment. */
export const BrowserOpenAuthenticatedRequestArgsSchema = z
  .object({
    item_id: OnePasswordOpaqueIdSchema,
    url: BrowserPageUrlSchema,
  })
  .strict();

/** Approval arguments enriched with the item title resolved by the trusted broker. */
export const BrowserOpenAuthenticatedApprovalArgsSchema =
  BrowserOpenAuthenticatedRequestArgsSchema.extend({
    item_title: SafeOnePasswordLoginTitleSchema,
  }).strict();

export const ApprovalArgsSchema = z.union([
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  EditJiraIssueApprovalArgsSchema,
  TransitionJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  BrowserOpenAuthenticatedApprovalArgsSchema,
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
    tool: z.literal("editJiraIssue"),
    args: EditJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("transitionJiraIssue"),
    args: TransitionJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("create-feature-flag"),
    args: CreateFeatureFlagApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("browser_open_authenticated"),
    args: BrowserOpenAuthenticatedApprovalArgsSchema,
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
    case "editJiraIssue":
    case "transitionJiraIssue":
    case "browser_open_authenticated":
      return parsed.data.args;
  }
}
