import { z } from "zod/v4";

// -- Envelope schema --
//
// The GitHub Actions workflow sends:
//   { "event": "...", "branch": "...", "repository": "owner/repo", "payload": { ... } }
//
// Routing fields (`branch`, `repository`) are in the envelope so the gateway
// never needs to dig into the raw payload. The workflow resolves `branch`:
//   - pull_request / pull_request_review / pull_request_review_comment:
//       github.event.pull_request.head.ref
//   - push: github.ref_name (or strip refs/heads/ from github.ref)
//   - issue_comment on PR: fetched via `gh pr view`

const SUPPORTED_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "issue_comment",
] as const;

const GitHubEventSchema = z.object({
  event: z.enum(SUPPORTED_EVENTS),
  branch: z.string(),
  repository: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type GitHubEvent = z.infer<typeof GitHubEventSchema>;

/**
 * Validate the envelope for a supported event type.
 * Returns undefined for unknown or invalid events.
 */
export function parseGitHubEvent(body: unknown): GitHubEvent | undefined {
  const result = GitHubEventSchema.safeParse(body);
  return result.success ? result.data : undefined;
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

export function getGitHubCorrelationKeys(event: GitHubEvent): string[] {
  const canonical = `git:branch:${event.repository}:${event.branch}`;
  const keys = [canonical];

  // Add short alias: git:branch:{repo-name}:{branch}
  const slashIdx = event.repository.indexOf("/");
  if (slashIdx > 0) {
    const repoName = event.repository.slice(slashIdx + 1);
    const alias = `git:branch:${repoName}:${event.branch}`;
    if (alias !== canonical) keys.push(alias);
  }

  return keys;
}
