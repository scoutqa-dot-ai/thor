import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeGitAlias } from "@thor/common";
import {
  buildCorrelationKey,
  detectMention,
  GitHubWebhookEnvelopeSchema,
  normalizeGitHubEvent,
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
    sender: { login: "alice", type: "User" },
    pull_request: {
      number: 42,
      user: { login: "alice" },
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
});

describe("normalizeGitHubEvent", () => {
  const options = { localRepo: "thor", mentionLogins: ["thor", "thor[bot]"] };

  it("normalizes pull_request_review_comment and detects mention", () => {
    const normalized = normalizeGitHubEvent(baseReviewCommentEvent(), options);
    if ("ignored" in normalized) throw new Error("expected normalized event");

    expect(normalized.eventType).toBe("pull_request_review_comment");
    expect(normalized.repoFullName).toBe("scoutqa-dot-ai/thor");
    expect(normalized.branch).toBe("feature/refactor");
  });

  it("ignores pure issue comments", () => {
    const result = normalizeGitHubEvent(
      {
        action: "created",
        installation: { id: 1 },
        repository: { full_name: "acme/repo" },
        sender: { login: "alice", type: "User" },
        issue: { number: 12, pull_request: null },
        comment: {
          body: "hello",
          html_url: "https://github.com/acme/repo/issues/12#issuecomment-1",
          created_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "pure_issue_comment_unsupported" });
  });

  it("ignores fork PR comments", () => {
    const result = normalizeGitHubEvent(
      {
        ...baseReviewCommentEvent(),
        pull_request: {
          ...baseReviewCommentEvent().pull_request,
          head: { ref: "feature", repo: { full_name: "alice/thor" } },
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "fork_pr_unsupported" });
  });

  it("ignores bot senders and unsupported actions", () => {
    const bot = normalizeGitHubEvent(
      {
        ...baseReviewCommentEvent(),
        sender: { login: "thor[bot]", type: "User" },
      },
      options,
    );
    expect(bot).toEqual({ ignored: true, reason: "bot_sender" });

    const unsupported = normalizeGitHubEvent(
      {
        ...baseReviewCommentEvent(),
        action: "edited",
      },
      options,
    );
    expect(unsupported).toEqual({ ignored: true, reason: "event_unsupported" });
  });

  it("ignores issue_comment without app mention", () => {
    const result = normalizeGitHubEvent(
      {
        action: "created",
        installation: { id: 1 },
        repository: { full_name: "acme/repo" },
        sender: { login: "alice", type: "User" },
        issue: {
          number: 12,
          pull_request: { html_url: "https://github.com/acme/repo/pull/12" },
        },
        comment: {
          body: "@codex review",
          html_url: "https://github.com/acme/repo/pull/12#issuecomment-1",
          created_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "non_mention_comment" });
  });

  it("ignores pull_request_review_comment without app mention", () => {
    const result = normalizeGitHubEvent(
      {
        ...baseReviewCommentEvent(),
        comment: {
          body: "@codex please look",
          html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r2",
          created_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "non_mention_comment" });
  });

  it("forwards pull_request_review_comment without mention when PR was opened by us", () => {
    const result = normalizeGitHubEvent(
      {
        ...baseReviewCommentEvent(),
        pull_request: {
          ...baseReviewCommentEvent().pull_request,
          user: { login: "thor[bot]" },
        },
        comment: {
          body: "looks good, no @ mention here",
          html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r3",
          created_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    if ("ignored" in result) throw new Error("expected normalized event");
    expect(result.eventType).toBe("pull_request_review_comment");
  });

  it("forwards pull_request_review without mention when PR was opened by us", () => {
    const result = normalizeGitHubEvent(
      {
        action: "submitted",
        installation: { id: 1 },
        repository: { full_name: "acme/repo" },
        sender: { login: "alice", type: "User" },
        pull_request: {
          number: 12,
          user: { login: "thor[bot]" },
          head: { ref: "main", repo: { full_name: "acme/repo" } },
          base: { repo: { full_name: "acme/repo" } },
        },
        review: {
          body: "looks good to me",
          html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-2",
          submitted_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    if ("ignored" in result) throw new Error("expected normalized event");
    expect(result.eventType).toBe("pull_request_review");
  });

  it("ignores pull_request_review without app mention", () => {
    const result = normalizeGitHubEvent(
      {
        action: "submitted",
        installation: { id: 1 },
        repository: { full_name: "acme/repo" },
        sender: { login: "alice", type: "User" },
        pull_request: {
          number: 12,
          user: { login: "alice" },
          head: { ref: "main", repo: { full_name: "acme/repo" } },
          base: { repo: { full_name: "acme/repo" } },
        },
        review: {
          body: "looks good to me",
          html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-1",
          submitted_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "non_mention_comment" });
  });

  it("ignores empty pull_request_review body", () => {
    const result = normalizeGitHubEvent(
      {
        action: "submitted",
        installation: { id: 1 },
        repository: { full_name: "acme/repo" },
        sender: { login: "alice", type: "User" },
        pull_request: {
          number: 12,
          user: { login: "alice" },
          head: { ref: "main", repo: { full_name: "acme/repo" } },
          base: { repo: { full_name: "acme/repo" } },
        },
        review: {
          body: "   ",
          html_url: "https://github.com/acme/repo/pull/12#pullrequestreview-1",
          submitted_at: "2026-04-24T11:00:00Z",
        },
      },
      options,
    );
    expect(result).toEqual({ ignored: true, reason: "empty_review_body" });
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
