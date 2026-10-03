import { describe, expect, it } from "vitest";
import {
  ADMIN_AUDIT_LOG_PATH,
  loadAdminEnv,
  loadGatewayEnv,
  loadMetabaseEnv,
  loadRemoteCliEnv,
  loadRunnerEnv,
} from "./service-env.js";

const githubEnv = {
  GITHUB_APP_ID: "app-id",
  GITHUB_APP_SLUG: "thor-app",
  GITHUB_APP_BOT_ID: "12345",
  GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
};

const gatewayEnv = {
  THOR_INTERNAL_SECRET: "dummy-secret",
  GITHUB_APP_SLUG: "thor-app",
  GITHUB_APP_BOT_ID: "12345",
  GITHUB_WEBHOOK_SECRET: "dummy-webhook",
  SLACK_DEFAULT_REPO: "thor",
};

describe("service startup configuration boundaries", () => {
  it("derives the external bot identity and rejects invalid bot IDs or a missing Slack repo", () => {
    expect(loadGatewayEnv(gatewayEnv).githubAppBotEmail).toBe(
      "12345+thor-app[bot]@users.noreply.github.com",
    );
    expect(() => loadGatewayEnv({ ...gatewayEnv, GITHUB_APP_BOT_ID: "0" })).toThrow(
      "GITHUB_APP_BOT_ID must be a positive integer",
    );
    expect(() => loadGatewayEnv({ ...gatewayEnv, SLACK_DEFAULT_REPO: undefined })).toThrow(
      "Missing required env var SLACK_DEFAULT_REPO",
    );
  });

  it("rejects noncanonical numeric configuration rather than accepting a parseInt prefix", () => {
    expect(() => loadRunnerEnv({ PORT: "+3000" })).toThrow("PORT must be an integer");
  });

  it("requires the remote CLI bot credential and preserves its external git identity", () => {
    expect(
      loadRemoteCliEnv({
        ...githubEnv,
        THOR_INTERNAL_SECRET: "dummy-secret",
        SLACK_BOT_TOKEN: "dummy-slack-token",
      }),
    ).toMatchObject({
      gitIdentityName: "thor-app[bot]",
      gitIdentityEmail: "12345+thor-app[bot]@users.noreply.github.com",
    });
    expect(() => loadRemoteCliEnv({ ...githubEnv, THOR_INTERNAL_SECRET: "dummy-secret" })).toThrow(
      "Missing required env var SLACK_BOT_TOKEN",
    );
  });

  it("limits Metabase schemas and rejects partially numeric database IDs", () => {
    const env = {
      METABASE_URL: "https://metabase.test",
      METABASE_API_KEY: "dummy-metabase-key",
      METABASE_DATABASE_ID: "42",
      METABASE_ALLOWED_SCHEMAS: "dm_products, dm_growth,, dw_testops",
    };
    expect([...loadMetabaseEnv(env).schemas]).toEqual(["dm_products", "dm_growth", "dw_testops"]);
    expect(() => loadMetabaseEnv({ ...env, METABASE_DATABASE_ID: "042dw" })).toThrow(
      "METABASE_DATABASE_ID must be an integer",
    );
  });

  it("normalizes service bases before callers append API paths", () => {
    expect(loadGatewayEnv({ ...gatewayEnv, RUNNER_URL: "http://runner:3000///" }).runnerUrl).toBe(
      "http://runner:3000",
    );
    expect(loadRunnerEnv({ OPENCODE_URL: "http://127.0.0.1:4096/" }).opencodeUrl).toBe(
      "http://127.0.0.1:4096",
    );
  });

  it("does not redirect the admin audit log when the editable config path changes", () => {
    expect(loadAdminEnv({ CONFIG_PATH: "/workspace/config/custom.json" }).auditLogPath).toBe(
      ADMIN_AUDIT_LOG_PATH,
    );
  });
});
