import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseOrgFromRemoteUrl,
  resolveOrgFromArgs,
  generateAppJWT,
  getInstallationIdFromWorkspace,
  getInstallationToken,
} from "./github-app-auth.js";

const CONFIG_PATH = "/workspace/config.json";

describe("resolveOrgFromArgs", () => {
  it("extracts org from -R owner/repo", () => {
    expect(resolveOrgFromArgs(["pr", "create", "-R", "acme/web"])).toBe("acme");
  });

  it("extracts org from --repo=owner/repo", () => {
    expect(resolveOrgFromArgs(["pr", "view", "--repo=acme/web"])).toBe("acme");
  });

  it("returns undefined when repo flag is absent", () => {
    expect(resolveOrgFromArgs(["pr", "list"])).toBeUndefined();
  });
});

describe("parseOrgFromRemoteUrl", () => {
  it("parses HTTPS remote", () => {
    expect(parseOrgFromRemoteUrl("https://github.com/acme/web.git")).toBe("acme");
  });

  it("parses SSH remote", () => {
    expect(parseOrgFromRemoteUrl("git@github.com:acme/web.git")).toBe("acme");
  });

  it("returns undefined for unparseable URL", () => {
    expect(parseOrgFromRemoteUrl("not-a-url")).toBeUndefined();
  });
});

describe("getInstallationIdFromWorkspace", () => {
  beforeEach(() => {
    mkdirSync("/workspace", { recursive: true });
  });

  afterEach(() => {
    rmSync(CONFIG_PATH, { force: true });
  });

  it("reads installation ID from config.orgs", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: { thor: {} },
        orgs: { acme: { github_app_installation_id: 123456 } },
      }),
    );

    expect(getInstallationIdFromWorkspace("acme")).toBe(123456);
  });

  it("throws with configured org list when org is missing", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: { thor: {} },
        orgs: {
          alpha: { github_app_installation_id: 1 },
          zeta: { github_app_installation_id: 2 },
        },
      }),
    );

    expect(() => getInstallationIdFromWorkspace("acme")).toThrow(
      'Configured orgs: alpha, zeta. Add orgs.acme.github_app_installation_id',
    );
  });
});

describe("getInstallationToken", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "thor-gh-auth-"));
    process.env.GITHUB_APP_DIR = tempDir;
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = join(tempDir, "private-key.pem");
    writeFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "not-used-in-cache-hit");

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: { thor: {} },
        orgs: { acme: { github_app_installation_id: 999 } },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(CONFIG_PATH, { force: true });
    delete process.env.GITHUB_APP_DIR;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
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
    await expect(getInstallationToken("acme")).resolves.toEqual({ token: "cached-token", org: "acme" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints and caches when cache is missing", async () => {
    const keyDir = join(tmpdir(), `thor-test-jwt-${process.pid}-${Date.now()}`);
    const keyPath = join(keyDir, "test-key.pem");
    mkdirSync(keyDir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "pipe" });
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "minted-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      ),
    );

    await expect(getInstallationToken("acme")).resolves.toEqual({ token: "minted-token", org: "acme" });

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
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;

    const cacheDir = join(tempDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "acme.json"), JSON.stringify({ token: "stale", expires_at: "2000-01-01T00:00:00.000Z" }));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    await expect(getInstallationToken("acme")).rejects.toThrow('installation_gone for org "acme"');
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
