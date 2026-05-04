import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

const GitHubSenderSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
  type: z.string(),
});

const GitHubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
});

const GitHubInstallationSchema = z.object({
  id: z.number().int().positive(),
});

const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  default_branch: z.string().optional(),
});

const GitHubPullRequestRefSchema = z.object({
  ref: z.string(),
  repo: z.object({ full_name: z.string() }),
});

const IsoDateTimeSchema = z
  .string()
  .refine((s) => Number.isFinite(Date.parse(s)), { message: "expected ISO-8601 timestamp" });

const IssueCommentEnvelopeSchema = z.object({
  action: z.string(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({ html_url: z.string().optional() }).nullable().optional(),
  }),
  comment: z.object({
    body: z.string(),
    html_url: z.string(),
    created_at: IsoDateTimeSchema,
  }),
});

const PullRequestObjectSchema = z.object({
  number: z.number().int().positive(),
  user: GitHubUserSchema,
  head: GitHubPullRequestRefSchema,
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

const PullRequestReviewCommentEnvelopeSchema = z.object({
  action: z.string(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  pull_request: PullRequestObjectSchema,
  comment: z.object({
    body: z.string(),
    html_url: z.string(),
    created_at: IsoDateTimeSchema,
  }),
});

const PullRequestReviewEnvelopeSchema = z.object({
  event_type: z.literal("pull_request_review"),
  action: z.string(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  pull_request: PullRequestObjectSchema,
  review: z.object({
    body: z.string().nullable().optional(),
    html_url: z.string(),
    submitted_at: IsoDateTimeSchema,
  }),
});

const IssueCommentTypedEnvelopeSchema = IssueCommentEnvelopeSchema.extend({
  event_type: z.literal("issue_comment"),
  action: z.literal("created"),
});

const PullRequestReviewCommentTypedEnvelopeSchema = PullRequestReviewCommentEnvelopeSchema.extend({
  event_type: z.literal("pull_request_review_comment"),
  action: z.literal("created"),
});

const PullRequestReviewTypedEnvelopeSchema = PullRequestReviewEnvelopeSchema.extend({
  event_type: z.literal("pull_request_review"),
  action: z.literal("submitted"),
});

export const PullRequestClosedEventSchema = z.object({
  event_type: z.literal("pull_request"),
  action: z.literal("closed"),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean(),
    merged_at: IsoDateTimeSchema.nullable(),
    merge_commit_sha: z.string().nullable(),
    closed_at: IsoDateTimeSchema,
    html_url: z.string(),
    user: GitHubUserSchema,
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
    base: z.object({
      ref: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
  }),
});

const CheckSuitePullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().optional(),
  head: z
    .object({
      ref: z.string().optional(),
      sha: z.string().optional(),
      repo: z.object({ full_name: z.string().optional() }).optional(),
    })
    .optional(),
  base: z
    .object({
      ref: z.string().optional(),
      sha: z.string().optional(),
      repo: z.object({ full_name: z.string().optional() }).optional(),
    })
    .optional(),
});

export const CheckSuiteCompletedEventSchema = z.object({
  event_type: z.literal("check_suite"),
  action: z.literal("completed"),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  check_suite: z.object({
    head_sha: z.string(),
    head_branch: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    status: z.string().optional(),
    updated_at: IsoDateTimeSchema,
    pull_requests: z.array(CheckSuitePullRequestSchema),
  }),
});

export const PushEventSchema = z.object({
  event_type: z.literal("push"),
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  forced: z.boolean().optional(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema.extend({ default_branch: z.string() }),
  sender: GitHubSenderSchema,
  pusher: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  head_commit: z
    .object({
      id: z.string().optional(),
      message: z.string().optional(),
      url: z.string().optional(),
      timestamp: IsoDateTimeSchema.optional(),
    })
    .nullable()
    .optional(),
  commits: z.array(z.object({ id: z.string().optional() })).optional(),
});

function withEventType(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.event_type === "string") return raw;
  if ("check_suite" in obj) return { ...obj, event_type: "check_suite" };
  if (
    typeof obj.ref === "string" &&
    typeof obj.before === "string" &&
    typeof obj.after === "string"
  ) {
    return { ...obj, event_type: "push" };
  }
  if ("issue" in obj) return { ...obj, event_type: "issue_comment" };
  if ("pull_request" in obj && "comment" in obj) {
    return { ...obj, event_type: "pull_request_review_comment" };
  }
  if ("pull_request" in obj && "review" in obj) {
    return { ...obj, event_type: "pull_request_review" };
  }
  if ("pull_request" in obj) return { ...obj, event_type: "pull_request" };
  return raw;
}

export const GitHubWebhookEnvelopeSchema = z.preprocess(
  withEventType,
  z.discriminatedUnion("event_type", [
    IssueCommentTypedEnvelopeSchema,
    PullRequestReviewCommentTypedEnvelopeSchema,
    PullRequestReviewTypedEnvelopeSchema,
    PullRequestClosedEventSchema,
    CheckSuiteCompletedEventSchema,
    PushEventSchema,
  ]),
);

export type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEnvelopeSchema>;
export type GitHubWebhookEnvelope = GitHubWebhookEvent;

export type IssueCommentEvent = z.infer<typeof IssueCommentTypedEnvelopeSchema>;
export type PullRequestReviewCommentEvent = z.infer<
  typeof PullRequestReviewCommentTypedEnvelopeSchema
>;
export type PullRequestReviewEvent = z.infer<typeof PullRequestReviewTypedEnvelopeSchema>;
export type PullRequestClosedEvent = z.infer<typeof PullRequestClosedEventSchema>;
export type CheckSuiteCompletedEvent = z.infer<typeof CheckSuiteCompletedEventSchema>;
export type PushEvent = z.infer<typeof PushEventSchema>;

export type GitHubIgnoreReason =
  | "pure_issue_comment_unsupported"
  | "self_sender"
  | "empty_review_body"
  | "non_mention_comment"
  | "check_suite_branch_missing"
  | "correlation_key_unresolved"
  | "event_unsupported";

export function verifyGitHubSignature(input: {
  secret: string;
  rawBody: Buffer;
  header: string | undefined;
}): boolean {
  const { secret, rawBody, header } = input;
  if (!secret || !header) return false;

  const match = header.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;

  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();
  const actualDigest = Buffer.from(match[1], "hex");

  if (expectedDigest.length !== actualDigest.length) return false;
  return timingSafeEqual(expectedDigest, actualDigest);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectMention(body: string, mentionLogins: string[]): boolean {
  const text = body.toLowerCase();
  return mentionLogins.some((login) => {
    const escaped = escapeRegex(login.toLowerCase());
    const regex = new RegExp(`(^|[^a-z0-9_-])@${escaped}(?![a-z0-9_-])`, "i");
    return regex.test(text);
  });
}

export function buildMentionLogins(appSlug: string): string[] {
  const slug = appSlug.trim().toLowerCase();
  return [slug, `${slug}[bot]`];
}

export function buildCorrelationKey(localRepo: string, branch: string): string {
  return `git:branch:${localRepo}:${branch}`;
}

export function getGitHubEventLocalRepo(raw: GitHubWebhookEvent): string | null {
  const parts = raw.repository.full_name.split("/");
  return parts[parts.length - 1] || null;
}

const PENDING_BRANCH_RESOLVE_PREFIX = "pending:branch-resolve:";

export function buildPendingBranchResolveKey(localRepo: string, number: number): string {
  return `${PENDING_BRANCH_RESOLVE_PREFIX}${localRepo}:${number}`;
}

export function isPendingBranchResolveKey(key: string): boolean {
  return key.startsWith(PENDING_BRANCH_RESOLVE_PREFIX);
}

export function getGitHubEventSourceTs(raw: GitHubWebhookEnvelope): number {
  if (isPushEvent(raw)) {
    const ts = raw.head_commit?.timestamp ? Date.parse(raw.head_commit.timestamp) : NaN;
    return Number.isFinite(ts) ? ts : Date.now();
  }
  const iso = isIssueCommentEvent(raw)
    ? raw.comment.created_at
    : isPullRequestReviewCommentEvent(raw)
      ? raw.comment.created_at
      : isPullRequestClosedEvent(raw)
        ? raw.pull_request.closed_at
        : isCheckSuiteCompletedEvent(raw)
          ? raw.check_suite.updated_at
          : raw.review.submitted_at;
  return Date.parse(iso);
}

export function getGitHubEventBranch(raw: GitHubWebhookEvent): string | null {
  if (isPushEvent(raw)) return extractGitHubBranchFromRef(raw.ref);
  if (isIssueCommentEvent(raw)) return null;
  if (isCheckSuiteCompletedEvent(raw)) return raw.check_suite.head_branch?.trim() || null;
  if (isPullRequestClosedEvent(raw)) return raw.pull_request.head.ref;
  return raw.pull_request.head.ref;
}

export function getGitHubEventType(
  raw: GitHubWebhookEvent,
):
  | "issue_comment"
  | "pull_request_review_comment"
  | "pull_request_review"
  | "pull_request"
  | "check_suite"
  | "push" {
  return raw.event_type;
}

export function extractGitHubBranchFromRef(ref: string): string | null {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return null;
  const branch = ref.slice(prefix.length);
  return branch.trim() ? branch : null;
}

export function getGitHubEventNumber(raw: GitHubWebhookEvent): number {
  if (isIssueCommentEvent(raw)) return raw.issue.number;
  if (isCheckSuiteCompletedEvent(raw) || isPushEvent(raw)) {
    throw new Error(`${raw.event_type} events do not have a single routing number`);
  }
  return raw.pull_request.number;
}

export function shouldIgnoreIssueCommentEvent(
  raw: IssueCommentEvent,
  options: { mentionLogins: string[]; botId: number },
): GitHubIgnoreReason | null {
  if (!raw.issue.pull_request) {
    return "pure_issue_comment_unsupported";
  }
  if (raw.sender.id === options.botId) {
    return "self_sender";
  }
  if (!detectMention(raw.comment.body, options.mentionLogins)) {
    return "non_mention_comment";
  }
  return null;
}

export function shouldIgnorePullRequestReviewCommentEvent(
  raw: PullRequestReviewCommentEvent,
  options: { mentionLogins: string[]; botId: number },
): GitHubIgnoreReason | null {
  if (raw.sender.id === options.botId) {
    return "self_sender";
  }
  if (
    !detectMention(raw.comment.body, options.mentionLogins) &&
    raw.pull_request.user.id !== options.botId
  ) {
    return "non_mention_comment";
  }
  return null;
}

export function shouldIgnorePullRequestReviewEvent(
  raw: PullRequestReviewEvent,
  options: { mentionLogins: string[]; botId: number },
): GitHubIgnoreReason | null {
  const body = raw.review.body?.trim() ?? "";
  if (!body) {
    return "empty_review_body";
  }
  if (raw.sender.id === options.botId) {
    return "self_sender";
  }
  if (!detectMention(body, options.mentionLogins) && raw.pull_request.user.id !== options.botId) {
    return "non_mention_comment";
  }
  return null;
}

export function shouldIgnoreGitHubEvent(
  raw: GitHubWebhookEvent,
  options: { mentionLogins: string[]; botId: number },
): GitHubIgnoreReason | null {
  if (isPushEvent(raw)) return null;
  if (isCheckSuiteCompletedEvent(raw)) return null;
  if (isPullRequestClosedEvent(raw)) return null;
  if (isIssueCommentEvent(raw)) return shouldIgnoreIssueCommentEvent(raw, options);
  if (isPullRequestReviewCommentEvent(raw)) {
    return shouldIgnorePullRequestReviewCommentEvent(raw, options);
  }
  return shouldIgnorePullRequestReviewEvent(raw, options);
}

export function isCheckSuiteCompletedEvent(
  raw: GitHubWebhookEvent,
): raw is CheckSuiteCompletedEvent {
  return raw.event_type === "check_suite";
}

export function isPushEvent(raw: GitHubWebhookEvent): raw is PushEvent {
  return raw.event_type === "push";
}

export function isIssueCommentEvent(raw: GitHubWebhookEvent): raw is IssueCommentEvent {
  return "issue" in raw;
}

export function isPullRequestReviewCommentEvent(
  raw: GitHubWebhookEvent,
): raw is PullRequestReviewCommentEvent {
  return "pull_request" in raw && "comment" in raw;
}

export function isPullRequestReviewEvent(raw: GitHubWebhookEvent): raw is PullRequestReviewEvent {
  return "pull_request" in raw && "review" in raw;
}

export function isPullRequestClosedEvent(raw: GitHubWebhookEvent): raw is PullRequestClosedEvent {
  return raw.event_type === "pull_request" && raw.action === "closed";
}
