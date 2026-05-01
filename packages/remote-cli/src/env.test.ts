import { describe, expect, it } from "vitest";
import {
  loadDaytonaConfig,
  loadGitHubAppAuthConfig,
  loadMetabaseConfig,
  loadRemoteCliConfig,
  loadRemoteCliGitHubConfig,
  loadRemoteCliInternalConfig,
} from "./env.js";

const requiredEnv = {
  THOR_INTERNAL_SECRET: "secret",
  GITHUB_APP_ID: "app-id",
  GITHUB_APP_SLUG: "thor-app",
  GITHUB_APP_BOT_ID: "12345",
  GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
};

describe("remote-cli env", () => {
  it("loads defaults and derives GitHub bot identity", () => {
    const config = loadRemoteCliConfig(requiredEnv);

    expect(config.port).toBe(3004);
    expect(config.nodeEnv).toBe("");
    expect(config.gitIdentityName).toBe("thor-app[bot]");
    expect(config.gitIdentityEmail).toBe("12345+thor-app[bot]@users.noreply.github.com");
  });

  it("strictly parses port", () => {
    expect(loadRemoteCliConfig({ ...requiredEnv, PORT: "3004" }).port).toBe(3004);
    expect(() => loadRemoteCliConfig({ ...requiredEnv, PORT: "+03004x" })).toThrow(
      "PORT must be an integer",
    );
    expect(() => loadRemoteCliConfig({ ...requiredEnv, PORT: "bad" })).toThrow(
      "PORT must be an integer",
    );
  });

  it("validates required GitHub and internal vars separately", () => {
    expect(() => loadRemoteCliGitHubConfig({ ...requiredEnv, GITHUB_APP_ID: "" })).toThrow(
      "Missing required env var GITHUB_APP_ID",
    );
    expect(() => loadRemoteCliInternalConfig({ THOR_INTERNAL_SECRET: "" })).toThrow(
      "Missing required env var THOR_INTERNAL_SECRET",
    );
  });

  it("loads GitHub app auth defaults and normalizes API URL", () => {
    const config = loadGitHubAppAuthConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
      GITHUB_API_URL: "https://github.test/api///",
    });

    expect(config.apiUrl).toBe("https://github.test/api");
    expect(config.appDir).toBe("/var/lib/remote-cli/github-app");
  });

  it("loads Metabase config with strict database id parsing and required vars", () => {
    const config = loadMetabaseConfig({
      METABASE_URL: "https://metabase.test///",
      METABASE_API_KEY: "mb-key",
      METABASE_DATABASE_ID: "42",
      METABASE_ALLOWED_SCHEMAS: "dm_products, dm_growth,, dw_testops",
    });

    expect(config.url).toBe("https://metabase.test");
    expect(config.dbId).toBe(42);
    expect([...config.schemas]).toEqual(["dm_products", "dm_growth", "dw_testops"]);
    expect(() => loadMetabaseConfig({ METABASE_URL: "https://metabase.test" })).toThrow(
      "Missing required env var METABASE_API_KEY",
    );
    expect(() =>
      loadMetabaseConfig({
        METABASE_URL: "https://metabase.test",
        METABASE_API_KEY: "mb-key",
        METABASE_DATABASE_ID: "042dw",
        METABASE_ALLOWED_SCHEMAS: "dm_products",
      }),
    ).toThrow("METABASE_DATABASE_ID must be an integer");
  });

  it("loads Daytona defaults and requires API key", () => {
    expect(loadDaytonaConfig({ DAYTONA_API_KEY: "daytona-key" })).toEqual({
      apiKey: "daytona-key",
      apiUrl: "https://app.daytona.io/api",
      snapshot: "daytona-medium",
    });
    expect(() => loadDaytonaConfig({})).toThrow("Missing required env var DAYTONA_API_KEY");
  });
});
