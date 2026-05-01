import { describe, expect, it } from "vitest";
import { loadGatewayConfig, validateGatewayGitHubEnv } from "./env.js";

const requiredEnv = {
  THOR_INTERNAL_SECRET: "secret",
  GITHUB_APP_SLUG: "thor-app",
  GITHUB_APP_BOT_ID: "12345",
  GITHUB_WEBHOOK_SECRET: "webhook",
};

describe("gateway env", () => {
  it("loads defaults, normalizes URLs, and derives GitHub bot identity", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      RUNNER_URL: "http://runner:3000///",
      SLACK_API_BASE_URL: "https://slack.test/api/",
    });

    expect(config.port).toBe(3002);
    expect(config.runnerUrl).toBe("http://runner:3000");
    expect(config.slackApiBaseUrl).toBe("https://slack.test/api");
    expect(config.remoteCliHost).toBe("remote-cli");
    expect(config.remoteCliPort).toBe(3004);
    expect(config.githubAppBotEmail).toBe("12345+thor-app[bot]@users.noreply.github.com");
  });

  it("strictly parses integer fields", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      PORT: "3002",
      REMOTE_CLI_PORT: "3004",
      SLACK_TIMESTAMP_TOLERANCE_SECONDS: "300",
    });

    expect(config.port).toBe(3002);
    expect(config.remoteCliPort).toBe(3004);
    expect(config.slackTimestampToleranceSeconds).toBe(300);
    expect(() => loadGatewayConfig({ ...requiredEnv, PORT: "03002x" })).toThrow(
      "PORT must be an integer",
    );
    expect(() => loadGatewayConfig({ ...requiredEnv, REMOTE_CLI_PORT: "+03004" })).toThrow(
      "REMOTE_CLI_PORT must be an integer",
    );
  });

  it("requires internal and GitHub vars and validates bot id", () => {
    expect(() => loadGatewayConfig({ ...requiredEnv, THOR_INTERNAL_SECRET: "" })).toThrow(
      "Missing required env var THOR_INTERNAL_SECRET",
    );
    expect(() => validateGatewayGitHubEnv({ ...requiredEnv, GITHUB_APP_BOT_ID: "0" })).toThrow(
      "GITHUB_APP_BOT_ID must be a positive integer",
    );
    expect(() => validateGatewayGitHubEnv({ ...requiredEnv, GITHUB_APP_SLUG: "" })).toThrow(
      "Missing required env var GITHUB_APP_SLUG",
    );
  });
});
