import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_CONFIG_PATH } from "./workspace-config.js";
import {
  loadAdminEnv,
  loadDaytonaEnv,
  loadGatewayEnv,
  loadGitHubAppAuthEnv,
  loadMetabaseEnv,
  loadRemoteCliAppEnv,
  loadRemoteCliEnv,
  loadRunnerEnv,
} from "./service-env.js";

const githubEnv = {
  GITHUB_APP_ID: "app-id",
  GITHUB_APP_SLUG: "thor-app",
  GITHUB_APP_BOT_ID: "12345",
  GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
};

describe("service env", () => {
  it("loads gateway defaults, required vars, and derived GitHub values", () => {
    const config = loadGatewayEnv({
      THOR_INTERNAL_SECRET: "secret",
      GITHUB_APP_SLUG: "thor-app",
      GITHUB_APP_BOT_ID: "12345",
      GITHUB_WEBHOOK_SECRET: "webhook",
      RUNNER_URL: "http://runner:3000",
      SLACK_DEFAULT_REPO: "thor",
    });

    expect(config.port).toBe(3002);
    expect(config.runnerUrl).toBe("http://runner:3000");
    expect(config.slackApiBaseUrl).toBe("https://slack.com/api");
    expect(config.slackDefaultRepo).toBe("thor");
    expect(config.githubAppBotEmail).toBe("12345+thor-app[bot]@users.noreply.github.com");
    expect(() =>
      loadGatewayEnv({
        THOR_INTERNAL_SECRET: "secret",
        GITHUB_APP_SLUG: "thor-app",
        GITHUB_APP_BOT_ID: "0",
        GITHUB_WEBHOOK_SECRET: "webhook",
        SLACK_DEFAULT_REPO: "thor",
      }),
    ).toThrow("GITHUB_APP_BOT_ID must be a positive integer");
    expect(() =>
      loadGatewayEnv({
        THOR_INTERNAL_SECRET: "secret",
        GITHUB_APP_SLUG: "thor-app",
        GITHUB_APP_BOT_ID: "12345",
        GITHUB_WEBHOOK_SECRET: "webhook",
      }),
    ).toThrow("Missing required env var SLACK_DEFAULT_REPO");
  });

  it("loads runner defaults and strictly validates integers", () => {
    expect(loadRunnerEnv({ OPENCODE_URL: "http://127.0.0.1:4096" })).toMatchObject({
      port: 3000,
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeConnectTimeout: 15000,
    });
    expect(() => loadRunnerEnv({ PORT: "+3000" })).toThrow("PORT must be an integer");
  });

  it("loads remote-cli env and helper configs", () => {
    expect(
      loadRemoteCliEnv({
        ...githubEnv,
        THOR_INTERNAL_SECRET: "secret",
        SLACK_BOT_TOKEN: "xoxb-test",
      }),
    ).toMatchObject({
      port: 3004,
      slackBotToken: "xoxb-test",
      gitIdentityName: "thor-app[bot]",
      gitIdentityEmail: "12345+thor-app[bot]@users.noreply.github.com",
    });
    expect(() => loadRemoteCliEnv({ ...githubEnv, THOR_INTERNAL_SECRET: "secret" })).toThrow(
      "Missing required env var SLACK_BOT_TOKEN",
    );
    expect(loadRemoteCliAppEnv({ THOR_INTERNAL_SECRET: "secret", NODE_ENV: "production" })).toEqual(
      {
        thorInternalSecret: "secret",
        isProduction: true,
      },
    );
    expect(
      loadGitHubAppAuthEnv({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
        GITHUB_API_URL: "https://github.test/api",
      }),
    ).toMatchObject({ apiUrl: "https://github.test/api" });
    expect(loadDaytonaEnv({ DAYTONA_API_KEY: "daytona-key" })).toMatchObject({
      apiUrl: "https://app.daytona.io/api",
      snapshot: "daytona-medium",
    });
  });

  it("loads metabase env with csv schemas and strict database id", () => {
    const config = loadMetabaseEnv({
      METABASE_URL: "https://metabase.test",
      METABASE_API_KEY: "mb-key",
      METABASE_DATABASE_ID: "42",
      METABASE_ALLOWED_SCHEMAS: "dm_products, dm_growth,, dw_testops",
    });

    expect(config.url).toBe("https://metabase.test");
    expect(config.dbId).toBe(42);
    expect([...config.schemas]).toEqual(["dm_products", "dm_growth", "dw_testops"]);
    expect(() =>
      loadMetabaseEnv({
        METABASE_URL: "https://metabase.test",
        METABASE_API_KEY: "mb-key",
        METABASE_DATABASE_ID: "042dw",
        METABASE_ALLOWED_SCHEMAS: "dm_products",
      }),
    ).toThrow("METABASE_DATABASE_ID must be an integer");
  });

  it("loads admin defaults and derived audit log path", () => {
    expect(loadAdminEnv({})).toEqual({
      port: 3005,
      configPath: WORKSPACE_CONFIG_PATH,
      auditLogPath: join(dirname(WORKSPACE_CONFIG_PATH), "config.audit.log"),
    });
  });
});
