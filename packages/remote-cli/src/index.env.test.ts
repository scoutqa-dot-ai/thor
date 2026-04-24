import { describe, expect, it } from "vitest";
import { validateRemoteCliGitHubEnv } from "./index.js";

describe("validateRemoteCliGitHubEnv", () => {
  it("accepts required GitHub App vars", () => {
    expect(() =>
      validateRemoteCliGitHubEnv({
        GITHUB_APP_ID: "123",
        GITHUB_APP_SLUG: "thor",
        GITHUB_APP_BOT_ID: "456",
        GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/thor-app.pem",
      }),
    ).not.toThrow();
  });

  it("throws with missing var name", () => {
    expect(() =>
      validateRemoteCliGitHubEnv({
        GITHUB_APP_ID: "123",
        GITHUB_APP_SLUG: "thor",
        GITHUB_APP_BOT_ID: "456",
      }),
    ).toThrow("Missing required env var GITHUB_APP_PRIVATE_KEY_PATH");
  });
});
