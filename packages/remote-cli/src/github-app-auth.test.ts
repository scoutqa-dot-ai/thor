import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveOrgFromArgs,
  parseOrgFromRemoteUrl,
  findInstallation,
  resolveInstallation,
  generateAppJWT,
} from "./github-app-auth.js";
import { loadWorkspaceConfig } from "@thor/common";

// ── Org resolution from args ─────────────────────────────────────────────────

describe("resolveOrgFromArgs", () => {
  it("extracts org from -R owner/repo", () => {
    expect(resolveOrgFromArgs(["pr", "create", "-R", "acme/web"])).toBe("acme");
  });

  it("extracts org from --repo=owner/repo", () => {
    expect(resolveOrgFromArgs(["pr", "view", "--repo=acme/web"])).toBe("acme");
  });

  it("returns undefined when no -R flag", () => {
    expect(resolveOrgFromArgs(["pr", "list"])).toBeUndefined();
  });

  it("returns undefined when -R has no value", () => {
    expect(resolveOrgFromArgs(["pr", "create", "-R"])).toBeUndefined();
  });

  it("returns undefined for -R with no slash", () => {
    expect(resolveOrgFromArgs(["-R", "just-a-name"])).toBeUndefined();
  });
});

// ── Org resolution from remote URL ───────────────────────────────────────────

describe("parseOrgFromRemoteUrl", () => {
  it("parses HTTPS remote", () => {
    expect(parseOrgFromRemoteUrl("https://github.com/acme/web.git")).toBe("acme");
  });

  it("parses HTTPS remote without .git suffix", () => {
    expect(parseOrgFromRemoteUrl("https://github.com/acme/web")).toBe("acme");
  });

  it("parses SSH remote", () => {
    expect(parseOrgFromRemoteUrl("git@github.com:acme/web.git")).toBe("acme");
  });

  it("parses SSH remote without .git suffix", () => {
    expect(parseOrgFromRemoteUrl("git@github.com:acme/web")).toBe("acme");
  });

  it("parses GitHub Enterprise HTTPS remote", () => {
    expect(parseOrgFromRemoteUrl("https://github.example.com/acme/web.git")).toBe("acme");
  });

  it("parses GitHub Enterprise SSH remote", () => {
    expect(parseOrgFromRemoteUrl("git@github.example.com:acme/web.git")).toBe("acme");
  });

  it("returns undefined for unparseable URL", () => {
    expect(parseOrgFromRemoteUrl("not-a-url")).toBeUndefined();
  });
});

// ── Config lookup ────────────────────────────────────────────────────────────

describe("findInstallation", () => {
  const configDir = join(tmpdir(), `thor-test-config-${process.pid}`);
  const configPath = join(configDir, "config.json");

  beforeEach(() => {
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_FILE;
    delete process.env.GITHUB_API_URL;
  });

  // findInstallation reads from WORKSPACE_CONFIG_PATH which is hardcoded.
  // We test resolveInstallation separately since findInstallation depends on the
  // real config file path.

  it("resolveInstallation applies defaults from env", () => {
    process.env.GITHUB_APP_ID = "999";
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = "/keys/app.pem";
    process.env.GITHUB_API_URL = "https://ghe.example.com/api/v3";

    const result = resolveInstallation({
      org: "acme",
      installation_id: 12345,
      app_id: "",
      private_key_path: "",
      api_url: "",
    });

    expect(result.appId).toBe("999");
    expect(result.privateKeyPath).toBe("/keys/app.pem");
    expect(result.apiUrl).toBe("https://ghe.example.com/api/v3");
  });

  it("resolveInstallation prefers explicit config over env", () => {
    process.env.GITHUB_APP_ID = "999";

    const result = resolveInstallation({
      org: "acme",
      installation_id: 12345,
      app_id: "111",
      private_key_path: "/custom/key.pem",
      api_url: "https://custom.api.github.com",
    });

    expect(result.appId).toBe("111");
    expect(result.privateKeyPath).toBe("/custom/key.pem");
    expect(result.apiUrl).toBe("https://custom.api.github.com");
  });

  it("resolveInstallation uses defaults when no env set", () => {
    const result = resolveInstallation({
      org: "acme",
      installation_id: 12345,
      app_id: "777",
      private_key_path: "",
      api_url: "",
    });

    expect(result.privateKeyPath).toBe("/var/lib/remote-cli/github-app/private-key.pem");
    expect(result.apiUrl).toBe("https://api.github.com");
  });

  it("resolveInstallation throws when no app_id anywhere", () => {
    expect(() =>
      resolveInstallation({
        org: "acme",
        installation_id: 12345,
        app_id: "",
        private_key_path: "",
        api_url: "",
      }),
    ).toThrow('No app_id for org "acme"');
  });
});

// ── JWT generation ───────────────────────────────────────────────────────────

describe("generateAppJWT", () => {
  const keyDir = join(tmpdir(), `thor-test-jwt-${process.pid}`);
  const keyPath = join(keyDir, "test-key.pem");

  beforeEach(() => {
    mkdirSync(keyDir, { recursive: true });
    // Generate a test RSA key using openssl
    const { execFileSync } = require("node:child_process");
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], {
      stdio: "pipe",
    });
  });

  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  it("generates a valid JWT with three parts", () => {
    const jwt = generateAppJWT("123", keyPath);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode header
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.iss).toBe("123");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("throws when private key file does not exist", () => {
    expect(() => generateAppJWT("123", "/nonexistent/key.pem")).toThrow("Cannot read private key");
  });
});

// ── Workspace config schema ──────────────────────────────────────────────────

describe("workspace config with github_app", () => {
  it("accepts config with github_app.installations", () => {
    const dir = join(tmpdir(), `thor-test-ws-${process.pid}`);
    const path = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      path,
      JSON.stringify({
        repos: { "my-repo": { channels: ["C123"] } },
        github_app: {
          installations: [{ org: "acme", installation_id: 12345678 }],
        },
      }),
    );

    const config = loadWorkspaceConfig(path);
    expect(config.github_app?.installations).toHaveLength(1);
    expect(config.github_app?.installations[0].org).toBe("acme");
    expect(config.github_app?.installations[0].installation_id).toBe(12345678);
    // Defaults should be applied
    expect(config.github_app?.installations[0].app_id).toBe("");
    expect(config.github_app?.installations[0].private_key_path).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts config without github_app (backward compat)", () => {
    const dir = join(tmpdir(), `thor-test-ws2-${process.pid}`);
    const path = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      path,
      JSON.stringify({
        repos: { "my-repo": {} },
      }),
    );

    const config = loadWorkspaceConfig(path);
    expect(config.github_app).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });
});
