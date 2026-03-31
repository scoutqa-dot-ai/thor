import { z } from "zod/v4";

// -- Shared schemas --

const UserSchema = z.object({ login: z.string() });

const PrSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
  user: UserSchema,
});

// -- Payload schemas per event type --
//
// GitHub webhook payloads are huge (20-30KB) due to repeated repo/org/user
// metadata. Each schema picks only the fields the agent needs.

const CheckRunPayload = z.object({
  action: z.string(),
  check_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string(),
    pull_requests: z.array(z.object({ number: z.number() })),
  }),
  sender: UserSchema,
});

const DeploymentStatusPayload = z.object({
  deployment_status: z.object({
    state: z.string(),
    environment: z.string(),
    environment_url: z.string().optional(),
  }),
  deployment: z.object({ ref: z.string() }),
  sender: UserSchema,
});

const PullRequestPayload = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    html_url: z.string(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().optional(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
    user: UserSchema,
  }),
  sender: UserSchema,
});

const PullRequestReviewPayload = z.object({
  action: z.string(),
  review: z.object({
    state: z.string(),
    body: z.string().nullable(),
    html_url: z.string(),
    user: UserSchema,
  }),
  pull_request: PrSummarySchema,
  sender: UserSchema,
});

const PullRequestReviewCommentPayload = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    path: z.string().optional(),
    line: z.number().nullable().optional(),
    html_url: z.string(),
    user: UserSchema,
  }),
  pull_request: PrSummarySchema,
  sender: UserSchema,
});

const PushPayload = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  forced: z.boolean().optional(),
  commits: z.array(
    z.object({
      message: z.string(),
      url: z.string(),
      author: z.object({ username: z.string().optional() }),
    }),
  ),
  sender: UserSchema,
});

const IssueCommentPayload = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    html_url: z.string(),
    user: UserSchema,
  }),
  issue: z.object({
    number: z.number(),
    title: z.string(),
  }),
  sender: UserSchema,
});

// Map event name → payload schema for sanitization
const PayloadSchemas: Record<string, z.ZodType> = {
  check_run: CheckRunPayload,
  deployment_status: DeploymentStatusPayload,
  pull_request: PullRequestPayload,
  pull_request_review: PullRequestReviewPayload,
  pull_request_review_comment: PullRequestReviewCommentPayload,
  push: PushPayload,
  issue_comment: IssueCommentPayload,
};

// -- Envelope schema --
//
// The GitHub Actions workflow sends:
//   { "event": "...", "branch": "...", "repository": "owner/repo", "payload": { ... } }
//
// Routing fields (`branch`, `repository`) are in the envelope so the gateway
// never needs to dig into the raw payload.

const SUPPORTED_EVENTS = Object.keys(PayloadSchemas) as [string, ...string[]];

const GitHubEventSchema = z.object({
  event: z.enum(SUPPORTED_EVENTS),
  branch: z.string(),
  repository: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type GitHubEvent = z.infer<typeof GitHubEventSchema>;

/**
 * Validate the envelope and sanitize the payload.
 * Strips the payload to only the fields the agent needs.
 * Falls back to the raw payload if the typed schema doesn't match.
 * Returns undefined for unsupported or malformed envelopes.
 */
export function parseGitHubEvent(body: unknown): GitHubEvent | undefined {
  const result = GitHubEventSchema.safeParse(body);
  if (!result.success) return undefined;

  const event = result.data;
  const schema = PayloadSchemas[event.event];
  if (schema) {
    const parsed = schema.safeParse(event.payload);
    if (parsed.success) {
      event.payload = parsed.data as Record<string, unknown>;
    }
  }
  return event;
}

// -- Correlation keys --
//
// All events use git:branch:{repo}:{branch} so that PR activity,
// reviews, comments, and pushes to the same branch share a session.
//
// Returns an array: [canonical, ...aliases].
// The canonical key uses the full owner/repo name from GitHub.
// An alias using just the repo name is added so that runner-side
// correlation (which only has the directory name) can match.

/**
 * Check if a GitHub event payload mentions a specific username (e.g. `@thor-bot`).
 * Uses existing payload schemas to extract comment.body, review.body, and pull_request.body.
 */
export function githubEventMentions(event: GitHubEvent, username: string): boolean {
  if (!username) return false;
  const mention = `@${username}`;
  const p = event.payload;

  const bodies: (string | null | undefined)[] = [];

  const comment = IssueCommentPayload.safeParse(p);
  if (comment.success) bodies.push(comment.data.comment.body);

  const reviewComment = PullRequestReviewCommentPayload.safeParse(p);
  if (reviewComment.success) bodies.push(reviewComment.data.comment.body);

  const review = PullRequestReviewPayload.safeParse(p);
  if (review.success) bodies.push(review.data.review.body);

  const pr = PullRequestPayload.safeParse(p);
  if (pr.success) bodies.push(pr.data.pull_request.body);

  return bodies.some((b) => b?.includes(mention));
}

/**
 * Extract the short repo name from an "owner/repo" string.
 * Returns the full string if there's no slash.
 */
export function getRepoName(repository: string): string {
  const slashIdx = repository.indexOf("/");
  return slashIdx > 0 ? repository.slice(slashIdx + 1) : repository;
}

export function getGitHubCorrelationKeys(event: GitHubEvent): string[] {
  const canonical = `git:branch:${event.repository}:${event.branch}`;
  const keys = [canonical];

  // Add short alias: git:branch:{repo-name}:{branch}
  const repoName = getRepoName(event.repository);
  if (repoName !== event.repository) {
    const alias = `git:branch:${repoName}:${event.branch}`;
    if (alias !== canonical) keys.push(alias);
  }

  return keys;
}
