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

export const GitHubWebhookEnvelopeSchema = z.union([
  IssueCommentEnvelopeSchema.extend({ action: z.literal("created") }),
  PullRequestReviewCommentEnvelopeSchema.extend({ action: z.literal("created") }),
  PullRequestReviewEnvelopeSchema.extend({ action: z.literal("submitted") }),
]);

export type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEnvelopeSchema>;
export type GitHubWebhookEnvelope = GitHubWebhookEvent;

export type IssueCommentEvent = z.infer<typeof IssueCommentEnvelopeSchema> & {
  action: "created";
};
export type PullRequestReviewCommentEvent = z.infer<
  typeof PullRequestReviewCommentEnvelopeSchema
> & {
  action: "created";
};
export type PullRequestReviewEvent = z.infer<typeof PullRequestReviewEnvelopeSchema> & {
  action: "submitted";
};

export type GitHubIgnoreReason =
  | "pure_issue_comment_unsupported"
  | "fork_pr_unsupported"
  | "self_sender"
  | "empty_review_body"
  | "non_mention_comment"
  | "event_unsupported";

export interface NormalizedGitHubEvent {
  source: "github";
  eventType: "issue_comment" | "pull_request_review_comment" | "pull_request_review";
  action: "created" | "submitted";
  installationId: number;
  repoFullName: string;
  localRepo: string;
  senderLogin: string;
  htmlUrl: string;
  number: number;
  body: string;
  branch: string | null;
}

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

const PENDING_BRANCH_RESOLVE_PREFIX = "pending:branch-resolve:";

export function buildPendingBranchResolveKey(localRepo: string, number: number): string {
  return `${PENDING_BRANCH_RESOLVE_PREFIX}${localRepo}:${number}`;
}

export function isPendingBranchResolveKey(key: string): boolean {
  return key.startsWith(PENDING_BRANCH_RESOLVE_PREFIX);
}

export function getGitHubEventSourceTs(raw: GitHubWebhookEnvelope): number {
  const iso = isIssueCommentEvent(raw)
    ? raw.comment.created_at
    : isPullRequestReviewCommentEvent(raw)
      ? raw.comment.created_at
      : raw.review.submitted_at;
  return Date.parse(iso);
}

export function getGitHubEventBranch(raw: GitHubWebhookEvent): string | null {
  if (isIssueCommentEvent(raw)) return null;
  return raw.pull_request.head.ref;
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
  if (raw.pull_request.head.repo.full_name !== raw.pull_request.base.repo.full_name) {
    return "fork_pr_unsupported";
  }
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
  if (raw.pull_request.head.repo.full_name !== raw.pull_request.base.repo.full_name) {
    return "fork_pr_unsupported";
  }

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

export function normalizeGitHubEvent(
  raw: GitHubWebhookEnvelope,
  options: { localRepo: string; mentionLogins: string[]; botId: number },
): NormalizedGitHubEvent | { ignored: true; reason: GitHubIgnoreReason } {
  const senderLogin = raw.sender.login.toLowerCase();

  if (isIssueCommentEvent(raw)) {
    const reason = shouldIgnoreIssueCommentEvent(raw, options);
    if (reason) return { ignored: true, reason };
    return {
      source: "github",
      eventType: "issue_comment",
      action: "created",
      installationId: raw.installation.id,
      repoFullName: raw.repository.full_name,
      localRepo: options.localRepo,
      senderLogin,
      htmlUrl: raw.comment.html_url,
      number: raw.issue.number,
      body: raw.comment.body,
      branch: null,
    };
  }

  if (isPullRequestReviewCommentEvent(raw)) {
    const reason = shouldIgnorePullRequestReviewCommentEvent(raw, options);
    if (reason) return { ignored: true, reason };
    return {
      source: "github",
      eventType: "pull_request_review_comment",
      action: "created",
      installationId: raw.installation.id,
      repoFullName: raw.repository.full_name,
      localRepo: options.localRepo,
      senderLogin,
      htmlUrl: raw.comment.html_url,
      number: raw.pull_request.number,
      body: raw.comment.body,
      branch: raw.pull_request.head.ref,
    };
  }

  const reason = shouldIgnorePullRequestReviewEvent(raw, options);
  if (reason) return { ignored: true, reason };
  const body = raw.review.body?.trim() ?? "";

  return {
    source: "github",
    eventType: "pull_request_review",
    action: "submitted",
    installationId: raw.installation.id,
    repoFullName: raw.repository.full_name,
    localRepo: options.localRepo,
    senderLogin,
    htmlUrl: raw.review.html_url,
    number: raw.pull_request.number,
    body,
    branch: raw.pull_request.head.ref,
  };
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
