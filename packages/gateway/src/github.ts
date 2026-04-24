import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

const GitHubSenderSchema = z.object({
  login: z.string(),
  type: z.string(),
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
    created_at: z.string().optional(),
  }),
});

const PullRequestReviewCommentEnvelopeSchema = z.object({
  action: z.string(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    head: GitHubPullRequestRefSchema,
    base: z.object({ repo: z.object({ full_name: z.string() }) }),
  }),
  comment: z.object({
    body: z.string(),
    html_url: z.string(),
    created_at: z.string().optional(),
  }),
});

const PullRequestReviewEnvelopeSchema = z.object({
  action: z.string(),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    head: GitHubPullRequestRefSchema,
    base: z.object({ repo: z.object({ full_name: z.string() }) }),
  }),
  review: z.object({
    body: z.string().nullable().optional(),
    html_url: z.string(),
    submitted_at: z.string().optional(),
  }),
});

export const GitHubWebhookEnvelopeSchema = z.union([
  IssueCommentEnvelopeSchema.extend({ action: z.literal("created") }),
  PullRequestReviewCommentEnvelopeSchema.extend({ action: z.literal("created") }),
  PullRequestReviewEnvelopeSchema.extend({ action: z.literal("submitted") }),
]);

export type GitHubWebhookEnvelope =
  | z.infer<typeof IssueCommentEnvelopeSchema>
  | z.infer<typeof PullRequestReviewCommentEnvelopeSchema>
  | z.infer<typeof PullRequestReviewEnvelopeSchema>;

type IssueCommentEnvelope = z.infer<typeof IssueCommentEnvelopeSchema>;
type PullRequestReviewCommentEnvelope = z.infer<typeof PullRequestReviewCommentEnvelopeSchema>;
type PullRequestReviewEnvelope = z.infer<typeof PullRequestReviewEnvelopeSchema>;

type IgnoreReason =
  | "pure_issue_comment_unsupported"
  | "fork_pr_unsupported"
  | "bot_sender"
  | "empty_review_body"
  | "unsupported_action";

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
  mention: boolean;
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

function isBotSender(senderType: string, senderLogin: string, mentionLogins: string[]): boolean {
  if (senderType.toLowerCase() === "bot") return true;
  return mentionLogins.map((login) => login.toLowerCase()).includes(senderLogin.toLowerCase());
}

export function buildCorrelationKey(localRepo: string, branch: string): string {
  return `git:branch:${localRepo}:${branch}`;
}

export function getGitHubEventSourceTs(raw: GitHubWebhookEnvelope): number | undefined {
  const iso = isIssueCommentEvent(raw)
    ? raw.comment.created_at
    : isPullRequestReviewCommentEvent(raw)
      ? raw.comment.created_at
      : raw.review.submitted_at;

  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getGitHubDeliveryFallbackSourceTs(deliveryId: string): number {
  return createHash("sha256").update(deliveryId).digest().readUIntBE(0, 6);
}

export function normalizeGitHubEvent(
  raw: GitHubWebhookEnvelope,
  options: { localRepo: string; mentionLogins: string[] },
): NormalizedGitHubEvent | { ignored: true; reason: IgnoreReason } {
  const senderLogin = raw.sender.login.toLowerCase();

  if (isBotSender(raw.sender.type, senderLogin, options.mentionLogins)) {
    return { ignored: true, reason: "bot_sender" };
  }

  if (isIssueCommentEvent(raw)) {
    if (raw.action !== "created") {
      return { ignored: true, reason: "unsupported_action" };
    }
    if (!raw.issue.pull_request) {
      return { ignored: true, reason: "pure_issue_comment_unsupported" };
    }
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
      mention: detectMention(raw.comment.body, options.mentionLogins),
    };
  }

  if (isPullRequestReviewCommentEvent(raw)) {
    if (raw.action !== "created") {
      return { ignored: true, reason: "unsupported_action" };
    }
    if (raw.pull_request.head.repo.full_name !== raw.pull_request.base.repo.full_name) {
      return { ignored: true, reason: "fork_pr_unsupported" };
    }
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
      mention: detectMention(raw.comment.body, options.mentionLogins),
    };
  }

  if (raw.action !== "submitted") {
    return { ignored: true, reason: "unsupported_action" };
  }
  if (raw.pull_request.head.repo.full_name !== raw.pull_request.base.repo.full_name) {
    return { ignored: true, reason: "fork_pr_unsupported" };
  }

  const body = raw.review.body?.trim() ?? "";
  if (!body) {
    return { ignored: true, reason: "empty_review_body" };
  }

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
    mention: detectMention(body, options.mentionLogins),
  };
}

function isIssueCommentEvent(raw: GitHubWebhookEnvelope): raw is IssueCommentEnvelope {
  return "issue" in raw;
}

function isPullRequestReviewCommentEvent(
  raw: GitHubWebhookEnvelope,
): raw is PullRequestReviewCommentEnvelope {
  return "pull_request" in raw && "comment" in raw;
}
