import { z } from "zod/v4";

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

// `spaceId` is required so the approval card always names the target space —
// an approver must not be asked to approve a page with no visible destination.
// It also accepts a space key, which upstream resolves to the numeric id.
// `title` is optional, matching upstream; `cloudId` is injected by the proxy.
export const CreateConfluencePageApprovalArgsSchema = z
  .object({
    spaceId: z.string().min(1),
    title: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .passthrough();

// `key` is required so the approval card always names the flag being created;
// upstream only requires its own `context`. `name` holds the flag's description
// prose (see DISCLAIMER_TARGET_FIELDS). Fields upstream does not define are left
// out rather than mirrored — passthrough carries anything else the agent sends.
export const CreateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1).optional(),
    active: z.boolean().optional(),
    filters: z.unknown().optional(),
  })
  .passthrough();

export const GhIssueCreateApprovalArgsSchema = z
  .object({
    cwd: z.string().min(1),
    args: z.array(z.string()),
    title: z.string().optional(),
    bodyPreview: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    milestone: z.string().optional(),
    parent: z.string().optional(),
  })
  .passthrough();

export const AwsExecApprovalArgsSchema = z
  .object({
    cwd: z.string().min(1),
    args: z.array(z.string()),
  })
  .passthrough();

export const ApprovalArgsSchema = z.union([
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateConfluencePageApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  GhIssueCreateApprovalArgsSchema,
  AwsExecApprovalArgsSchema,
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
    tool: z.literal("createConfluencePage"),
    args: CreateConfluencePageApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("create-feature-flag"),
    args: CreateFeatureFlagApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("ghIssueCreate"),
    args: GhIssueCreateApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("awsExec"),
    args: AwsExecApprovalArgsSchema,
  }),
]);

export type ApprovalToolName = z.infer<typeof ApprovalRequiredEventPayloadSchema>["tool"];
export type ApprovalArgs = z.infer<typeof ApprovalArgsSchema>;
export type ApprovalRequiredEventPayload = z.infer<typeof ApprovalRequiredEventPayloadSchema>;

/**
 * The prose field each disclaimer-required approval tool carries, and therefore
 * the field the Thor footer is appended to.
 *
 * Single source of truth: it decides which tools require a disclaimer, it drives
 * injection below, and remote-cli's MCP policy check asserts the upstream tool
 * schema still exposes each field as a string. That last part matters — when a
 * provider drops or renames the field, an upstream with `additionalProperties`
 * unset (PostHog) silently discards the footer, shipping an untraceable
 * artifact. Drift has to fail loudly instead.
 */
export const DISCLAIMER_TARGET_FIELDS = {
  createJiraIssue: "description",
  addCommentToJiraIssue: "commentBody",
  createConfluencePage: "body",
  // PostHog has no `description` property: it documents `name` as the flag's
  // description field, kept there "for backwards compatibility".
  "create-feature-flag": "name",
} as const satisfies Partial<Record<ApprovalToolName, string>>;

export function approvalToolRequiresDisclaimer(tool: string): boolean {
  return tool in DISCLAIMER_TARGET_FIELDS;
}

export function disclaimerTargetField(tool: string): string | undefined {
  return (DISCLAIMER_TARGET_FIELDS as Record<string, string>)[tool];
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
  if (!parsed.success) {
    // Fail closed: a disclaimer-required tool must never execute upstream without the
    // Thor footer. If the stored args no longer parse, surface it loudly instead of
    // silently returning args unchanged (which would skip disclaimer injection).
    throw new Error(
      `Cannot inject approval disclaimer for "${tool}": arguments failed validation — ${parsed.error.message}`,
    );
  }
  switch (parsed.data.tool) {
    case "createJiraIssue":
      return {
        ...parsed.data.args,
        description: parsed.data.args.description
          ? `${parsed.data.args.description}\n${footer}`
          : footer,
      };
    case "create-feature-flag":
      return {
        ...parsed.data.args,
        name: parsed.data.args.name ? `${parsed.data.args.name}\n${footer}` : footer,
      };
    case "addCommentToJiraIssue":
      return {
        ...parsed.data.args,
        commentBody: `${parsed.data.args.commentBody}\n${footer}`,
      };
    case "createConfluencePage":
      return {
        ...parsed.data.args,
        // The footer is markdown, and upstream leaves the body format
        // unspecified when contentFormat is omitted — pin it so the reviewed
        // content and the disclaimer link render as written.
        contentFormat: "markdown",
        body: `${parsed.data.args.body}\n${footer}`,
      };
    case "ghIssueCreate":
    case "awsExec":
      return parsed.data.args;
  }
}
