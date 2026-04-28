import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeGitAlias } from "@thor/common";
import {
  buildCorrelationKey,
  CheckSuiteCompletedEventSchema,
  detectMention,
  getGitHubEventBranch,
  getGitHubEventSourceTs,
  getGitHubEventType,
  GitHubWebhookEnvelopeSchema,
  isCheckSuiteCompletedEvent,
  isIssueCommentEvent,
  isPullRequestReviewCommentEvent,
  isPullRequestReviewEvent,
  shouldIgnoreIssueCommentEvent,
  shouldIgnorePullRequestReviewCommentEvent,
  shouldIgnorePullRequestReviewEvent,
  verifyGitHubSignature,
  type GitHubWebhookEnvelope,
} from "./github.js";

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function baseReviewCommentEvent(): GitHubWebhookEnvelope {
  return {
    action: "created",
    installation: { id: 123 },
    repository: { full_name: "scoutqa-dot-ai/thor" },
    sender: { id: 1001, login: "alice", type: "User" },
    pull_request: {
      number: 42,
      user: { id: 1001, login: "alice" },
      head: { ref: "feature/refactor", repo: { full_name: "scoutqa-dot-ai/thor" } },
      base: { repo: { full_name: "scoutqa-dot-ai/thor" } },
    },
    comment: {
      body: "Looks good @thor",
      html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r1",
      created_at: "2026-04-24T11:00:00Z",
    },
  };
}

function baseCheckSuiteEvent(conclusion = "success") {
  return {
    action: "completed",
    installation: { id: 123 },
    repository: { full_name: "scoutqa-dot-ai/thor" },
    sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    check_suite: {
      head_sha: "abc123def456",
      head_branch: "feature/refactor",
      conclusion,
      status: "completed",
      updated_at: "2026-04-24T12:00:00Z",
      pull_requests: [
        {
          number: 42,
          head: {
            ref: "feature/refactor",
            sha: "abc123def456",
            repo: { full_name: "scoutqa-dot-ai/thor" },
          },
          base: {
            ref: "main",
            repo: { full_name: "scoutqa-dot-ai/thor" },
          },
        },
      ],
    },
  };
}

describe("verifyGitHubSignature", () => {
  it("accepts a valid signature", () => {
    const secret = "super-secret";
    const rawBody = Buffer.from('{"a":1}');
    expect(verifyGitHubSignature({ secret, rawBody, header: sign(rawBody, secret) })).toBe(true);
  });

  it("rejects wrong secret, missing header, and body mutations", () => {
    const secret = "super-secret";
    const rawBody = Buffer.from('{"text":"hi 👋"}');
    const header = sign(rawBody, secret);

    expect(verifyGitHubSignature({ secret: "wrong", rawBody, header })).toBe(false);
    expect(verifyGitHubSignature({ secret, rawBody, header: undefined })).toBe(false);
    expect(verifyGitHubSignature({ secret, rawBody: Buffer.from('{"text":"hi👋"}'), header })).toBe(
      false,
    );
    expect(
      verifyGitHubSignature({ secret, rawBody: Buffer.from('{"text":"hi 👋 "}'), header }),
    ).toBe(false);
  });
});

describe("GitHubWebhookEnvelopeSchema", () => {
  it("accepts allowlisted events and rejects off-allowlist action", () => {
    expect(GitHubWebhookEnvelopeSchema.safeParse(baseReviewCommentEvent()).success).toBe(true);
    expect(
      GitHubWebhookEnvelopeSchema.safeParse({
        ...baseReviewCommentEvent(),
        action: "edited",
      }).success,
    ).toBe(false);
  });

  it("accepts check_suite completed events and adds the event discriminator", () => {
    const parsed = GitHubWebhookEnvelopeSchema.safeParse(baseCheckSuiteEvent("success"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.event_type).toBe("check_suite");
    expect(isCheckSuiteCompletedEvent(parsed.data)).toBe(true);
    expect(getGitHubEventType(parsed.data)).toBe("check_suite");
    expect(getGitHubEventBranch(parsed.data)).toBe("feature/refactor");
    expect(getGitHubEventSourceTs(parsed.data)).toBe(Date.parse("2026-04-24T12:00:00Z"));
  });

  it("accepts non-success check_suite conclusions", () => {
    const parsed = GitHubWebhookEnvelopeSchema.safeParse(baseCheckSuiteEvent("failure"));
    expect(parsed.success).toBe(true);
    if (!parsed.success || !isCheckSuiteCompletedEvent(parsed.data)) return;

    expect(parsed.data.check_suite.conclusion).toBe("failure");
    expect(CheckSuiteCompletedEventSchema.safeParse(parsed.data).success).toBe(true);
  });
});

const THOR_BOT_ID = 7777;
const OTHER_BOT_ID = 9999;

describe("GitHub ignore helpers", () => {
  const options = {
    mentionLogins: ["thor", "thor[bot]"],
    botId: THOR_BOT_ID,
  };

  it("accepts pull_request_review_comment and derives branch", () => {
    const event = baseReviewCommentEvent();
    if (!isPullRequestReviewCommentEvent(event)) throw new Error("expected review comment event");

    expect(shouldIgnorePullRequestReviewCommentEvent(event, options)).toBeNull();
    expect(getGitHubEventBranch(event)).toBe("feature/refactor");
  });

  it("ignores pure issue comments", () => {
    const event: GitHubWebhookEnvelope = {
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "acme/repo" },
      sender: { id: 1001, login: "alice", type: "User" },
      issue: { number: 12, pull_request: null },
      comment: {
        body: "hello",
        html_url: "https://github.com/acme/repo/issues/12#issuecomment-1",
        created_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isIssueCommentEvent(event)) throw new Error("expected issue comment event");
    expect(shouldIgnoreIssueCommentEvent(event, options)).toBe("pure_issue_comment_unsupported");
  });

  it("ignores fork PR comments", () => {
    const event = {
      ...baseReviewCommentEvent(),
      pull_request: {
        ...baseReviewCommentEvent().pull_request,
        head: { ref: "feature", repo: { full_name: "alice/thor" } },
      },
    };
    if (!isPullRequestReviewCommentEvent(event)) throw new Error("expected review comment event");
    expect(shouldIgnorePullRequestReviewCommentEvent(event, options)).toBe("fork_pr_unsupported");
  });

  it("ignores self senders", () => {
    const self = {
      ...baseReviewCommentEvent(),
      sender: { id: THOR_BOT_ID, login: "thor[bot]", type: "Bot" },
    };
    if (!isPullRequestReviewCommentEvent(self)) throw new Error("expected review comment event");
    expect(shouldIgnorePullRequestReviewCommentEvent(self, options)).toBe("self_sender");
  });

  it("does not auto-drop other bots — falls through to mention/bot-PR checks", () => {
    const otherBotMention = {
      ...baseReviewCommentEvent(),
      sender: { id: OTHER_BOT_ID, login: "codex[bot]", type: "Bot" },
    };
    if (!isPullRequestReviewCommentEvent(otherBotMention)) {
      throw new Error("expected review comment event");
    }
    expect(shouldIgnorePullRequestReviewCommentEvent(otherBotMention, options)).toBeNull();

    const otherBotNoMention = {
      ...baseReviewCommentEvent(),
      sender: { id: OTHER_BOT_ID, login: "codex[bot]", type: "Bot" },
      comment: {
        body: "no @mention here",
        html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r4",
        created_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewCommentEvent(otherBotNoMention)) {
      throw new Error("expected review comment event");
    }
    expect(shouldIgnorePullRequestReviewCommentEvent(otherBotNoMention, options)).toBe(
      "non_mention_comment",
    );
  });

  it("ignores self senders even when login does not match (id is canonical)", () => {
    const event = {
      ...baseReviewCommentEvent(),
      sender: { id: THOR_BOT_ID, login: "renamed-thor[bot]", type: "Bot" },
    };
    if (!isPullRequestReviewCommentEvent(event)) throw new Error("expected review comment event");
    expect(shouldIgnorePullRequestReviewCommentEvent(event, options)).toBe("self_sender");
  });

  it("ignores issue_comment without app mention", () => {
    const event: GitHubWebhookEnvelope = {
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "acme/repo" },
      sender: { id: 1001, login: "alice", type: "User" },
      issue: {
        number: 12,
        pull_request: { html_url: "https://github.com/acme/repo/pull/12" },
      },
      comment: {
        body: "@codex review",
        html_url: "https://github.com/acme/repo/pull/12#issuecomment-1",
        created_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isIssueCommentEvent(event)) throw new Error("expected issue comment event");
    expect(shouldIgnoreIssueCommentEvent(event, options)).toBe("non_mention_comment");
    expect(getGitHubEventBranch(event)).toBeNull();
  });

  it("ignores pull_request_review_comment without app mention", () => {
    const event = {
      ...baseReviewCommentEvent(),
      comment: {
        body: "@codex please look",
        html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r2",
        created_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewCommentEvent(event)) throw new Error("expected review comment event");
    expect(shouldIgnorePullRequestReviewCommentEvent(event, options)).toBe("non_mention_comment");
  });

  it("forwards pull_request_review_comment without mention when PR was opened by us", () => {
    const event = {
      ...baseReviewCommentEvent(),
      pull_request: {
        ...baseReviewCommentEvent().pull_request,
        user: { id: THOR_BOT_ID, login: "thor[bot]" },
      },
      comment: {
        body: "looks good, no @ mention here",
        html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r3",
        created_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewCommentEvent(event)) throw new Error("expected review comment event");
    expect(shouldIgnorePullRequestReviewCommentEvent(event, options)).toBeNull();
  });

  it("forwards pull_request_review without mention when PR was opened by us", () => {
    const event: GitHubWebhookEnvelope = {
      action: "submitted",
      installation: { id: 1 },
      repository: { full_name: "acme/repo" },
      sender: { id: 1001, login: "alice", type: "User" },
      pull_request: {
        number: 12,
        user: { id: THOR_BOT_ID, login: "thor[bot]" },
        head: { ref: "main", repo: { full_name: "acme/repo" } },
        base: { repo: { full_name: "acme/repo" } },
      },
      review: {
        body: "looks good to me",
        html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-2",
        submitted_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewEvent(event)) throw new Error("expected review event");
    expect(shouldIgnorePullRequestReviewEvent(event, options)).toBeNull();
    expect(getGitHubEventBranch(event)).toBe("main");
  });

  it("ignores pull_request_review without app mention", () => {
    const event: GitHubWebhookEnvelope = {
      action: "submitted",
      installation: { id: 1 },
      repository: { full_name: "acme/repo" },
      sender: { id: 1001, login: "alice", type: "User" },
      pull_request: {
        number: 12,
        user: { id: 1001, login: "alice" },
        head: { ref: "main", repo: { full_name: "acme/repo" } },
        base: { repo: { full_name: "acme/repo" } },
      },
      review: {
        body: "looks good to me",
        html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-1",
        submitted_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewEvent(event)) throw new Error("expected review event");
    expect(shouldIgnorePullRequestReviewEvent(event, options)).toBe("non_mention_comment");
  });

  it("ignores empty pull_request_review body", () => {
    const event: GitHubWebhookEnvelope = {
      action: "submitted",
      installation: { id: 1 },
      repository: { full_name: "acme/repo" },
      sender: { id: 1001, login: "alice", type: "User" },
      pull_request: {
        number: 12,
        user: { id: 1001, login: "alice" },
        head: { ref: "main", repo: { full_name: "acme/repo" } },
        base: { repo: { full_name: "acme/repo" } },
      },
      review: {
        body: "   ",
        html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-1",
        submitted_at: "2026-04-24T11:00:00Z",
      },
    };
    if (!isPullRequestReviewEvent(event)) throw new Error("expected review event");
    expect(shouldIgnorePullRequestReviewEvent(event, options)).toBe("empty_review_body");
  });
});

describe("mention and correlation helpers", () => {
  it("mention matching is case-insensitive and boundary-safe", () => {
    expect(detectMention("Please check @Thor", ["thor"])).toBe(true);
    expect(detectMention("Please check @thorbot", ["thor"])).toBe(false);
  });

  it("buildCorrelationKey matches computeGitAlias format", () => {
    const built = buildCorrelationKey("thor", "feature/refactor");
    const alias = computeGitAlias(
      "git",
      ["push", "origin", "feature/refactor"],
      "/workspace/repos/thor",
    );
    expect(alias?.alias).toBe(built);
  });
});
