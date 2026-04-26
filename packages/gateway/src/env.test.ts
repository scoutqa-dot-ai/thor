import { describe, expect, it } from "vitest";
import { validateGatewayGitHubEnv } from "./env.js";

describe("validateGatewayGitHubEnv", () => {
  it("requires only GitHub slug and webhook secret", () => {
    expect(
      validateGatewayGitHubEnv({
        GITHUB_APP_SLUG: "thor",
        GITHUB_WEBHOOK_SECRET: "super-secret",
      }),
    ).toEqual({ githubAppSlug: "thor", githubWebhookSecret: "super-secret" });
  });

  it("throws when required vars are missing", () => {
    expect(() => validateGatewayGitHubEnv({ GITHUB_APP_SLUG: "thor" })).toThrow(
      "Missing required env var GITHUB_WEBHOOK_SECRET",
    );
  });
});
