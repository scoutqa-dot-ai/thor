import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mockedWorkspace = vi.hoisted(() => ({ configPath: "" }));

vi.mock("@thor/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thor/common")>();
  return {
    ...actual,
    get WORKSPACE_CONFIG_PATH() {
      return mockedWorkspace.configPath;
    },
  };
});

import {
  parseOwnerFromRemoteUrl,
  parseOwnerRepoFromRemoteUrl,
  generateAppJWT,
  getInstallationIdFromWorkspace,
  getInstallationToken,
} from "./github-app-auth.js";

describe("parseOwnerFromRemoteUrl", () => {
  it("parses HTTPS remote", () => {
    expect(parseOwnerFromRemoteUrl("https://github.com/acme/web.git")).toBe("acme");
  });

  it("parses SSH remote", () => {
    expect(parseOwnerFromRemoteUrl("git@github.com:acme/web.git")).toBe("acme");
  });

  it("returns undefined for unparseable URL", () => {
    expect(parseOwnerFromRemoteUrl("not-a-url")).toBeUndefined();
  });
});

describe("parseOwnerRepoFromRemoteUrl", () => {
  it("parses HTTPS and SSH remotes", () => {
    expect(parseOwnerRepoFromRemoteUrl("https://github.com/acme/web.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "web",
    });
    expect(parseOwnerRepoFromRemoteUrl("git@github.com:acme/web.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "web",
    });
    expect(parseOwnerRepoFromRemoteUrl("git@github.com:acme/web.git/")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "web",
    });
  });

  it("includes non-GitHub remote hosts for policy-level checks", () => {
    expect(parseOwnerRepoFromRemoteUrl("git@gitlab.com:acme/web.git")).toEqual({
      host: "gitlab.com",
      owner: "acme",
      repo: "web",
    });
    expect(parseOwnerRepoFromRemoteUrl("https://example.com/acme/web.git")).toEqual({
      host: "example.com",
      owner: "acme",
      repo: "web",
    });
  });

  it("rejects malformed owner/repo remotes", () => {
    expect(parseOwnerRepoFromRemoteUrl("https://github.com/acme/web/extra.git")).toBeUndefined();
    expect(parseOwnerRepoFromRemoteUrl("git@github.com:acme/web/extra.git")).toBeUndefined();
    expect(parseOwnerRepoFromRemoteUrl("not-a-url")).toBeUndefined();
  });
});

describe("getInstallationIdFromWorkspace", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "thor-workspace-config-"));
    mockedWorkspace.configPath = join(configDir, "config.json");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    mockedWorkspace.configPath = "";
  });

  it("reads installation ID from config.owners", () => {
    writeFileSync(
      mockedWorkspace.configPath,
      JSON.stringify({
        owners: { acme: { github_app_installation_id: 123456 } },
      }),
    );

    expect(getInstallationIdFromWorkspace("acme")).toBe(123456);
  });

  it("throws with configured owner list when owner is missing", () => {
    writeFileSync(
      mockedWorkspace.configPath,
      JSON.stringify({
        owners: {
          alpha: { github_app_installation_id: 1 },
          zeta: { github_app_installation_id: 2 },
        },
      }),
    );

    expect(() => getInstallationIdFromWorkspace("acme")).toThrow(
      "Configured owners: alpha, zeta. Add owners.acme.github_app_installation_id",
    );
  });
});

describe("getInstallationToken", () => {
  let tempDir: string;
  let configDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "thor-gh-auth-"));
    configDir = mkdtempSync(join(tmpdir(), "thor-workspace-config-"));
    mockedWorkspace.configPath = join(configDir, "config.json");
    process.env.GITHUB_APP_DIR = tempDir;
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = join(tempDir, "private-key.pem");
    writeFileSync(process.env.GITHUB_APP_PRIVATE_KEY_FILE, "not-used-in-cache-hit");

    writeFileSync(
      mockedWorkspace.configPath,
      JSON.stringify({
        owners: { acme: { github_app_installation_id: 999 } },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    mockedWorkspace.configPath = "";
    delete process.env.GITHUB_APP_DIR;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_FILE;
    delete process.env.GITHUB_API_URL;
  });

  it("returns cached token without minting", async () => {
    const cacheDir = join(tempDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "acme.json"),
      JSON.stringify({
        token: "cached-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(getInstallationToken("acme")).resolves.toEqual({
      token: "cached-token",
      owner: "acme",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints and caches when cache is missing", async () => {
    const keyDir = join(tmpdir(), `thor-test-jwt-${process.pid}-${Date.now()}`);
    const keyPath = join(keyDir, "test-key.pem");
    mkdirSync(keyDir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "pipe" });
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = keyPath;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "minted-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      ),
    );

    await expect(getInstallationToken("acme")).resolves.toEqual({
      token: "minted-token",
      owner: "acme",
    });

    const cached = JSON.parse(readFileSync(join(tempDir, "cache", "acme.json"), "utf8")) as {
      token: string;
    };
    expect(cached.token).toBe("minted-token");

    rmSync(keyDir, { recursive: true, force: true });
  });

  it("evicts cache and raises installation_gone on 401/403", async () => {
    const keyDir = join(tmpdir(), `thor-test-jwt-${process.pid}-${Date.now()}`);
    const keyPath = join(keyDir, "test-key.pem");
    mkdirSync(keyDir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "pipe" });
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = keyPath;

    const cacheDir = join(tempDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "acme.json"),
      JSON.stringify({ token: "stale", expires_at: "2000-01-01T00:00:00.000Z" }),
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    await expect(getInstallationToken("acme")).rejects.toThrow(
      'installation_gone for owner "acme"',
    );
    expect(() => readFileSync(join(cacheDir, "acme.json"), "utf8")).toThrow();

    rmSync(keyDir, { recursive: true, force: true });
  });
});

describe("generateAppJWT", () => {
  const keyDir = join(tmpdir(), `thor-test-jwt-${process.pid}`);
  const keyPath = join(keyDir, "test-key.pem");

  beforeEach(async () => {
    mkdirSync(keyDir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  it("generates a valid JWT with three parts", () => {
    const jwt = generateAppJWT("123", keyPath);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header.alg).toBe("RS256");

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.iss).toBe("123");
  });
});
