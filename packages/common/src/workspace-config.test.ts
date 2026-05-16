import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  createConfigLoader,
  extractRepoFromCwd,
  getInstallationIdForOwner,
  interpolateEnv,
  interpolateHeaders,
  resolveSafeRepoDirectory,
  resolveSlackChannelRepoDirectory,
} from "./workspace-config.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "config-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(filename: string, data: unknown): string {
  const path = join(tempDir, filename);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("loadWorkspaceConfig", () => {
  it("loads an empty config", () => {
    const path = writeConfig("config.json", {});
    expect(loadWorkspaceConfig(path)).toEqual({});
  });

  it("throws on missing file", () => {
    expect(() => loadWorkspaceConfig("/nonexistent/path.json")).toThrow("Failed to read");
  });

  it("throws on invalid JSON", () => {
    const path = join(tempDir, "bad.json");
    writeFileSync(path, "not json {{{");
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid JSON");
  });

  it("rejects unknown top-level fields", () => {
    const path = writeConfig("config.json", { repos: {} });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid workspace config");
  });

  it("rejects non-positive owner installation IDs with path details", () => {
    const path = writeConfig("config.json", {
      owners: {
        acme: { github_app_installation_id: 0 },
      },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("owners.acme.github_app_installation_id");
  });

  it("loads the tracked workspace config example", () => {
    const config = loadWorkspaceConfig(
      join(process.cwd(), "docs/examples/workspace-config.example.json"),
    );
    expect(config.owners).toEqual({
      "scoutqa-dot-ai": { github_app_installation_id: 126669985 },
    });
  });

  it("accepts mitmproxy rules and passthrough host list", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [
        {
          host: "api.example.com",
          path_prefix: "/v1/",
          path_suffix: "/attachments",
          headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
        },
        {
          host_suffix: ".example.internal",
          headers: { "X-API-Key": "${INTERNAL_TOKEN}" },
          readonly: true,
        },
      ],
      mitmproxy_passthrough: ["api.openai.com", ".openai.com"],
    });

    const config = loadWorkspaceConfig(path);
    expect(config.mitmproxy?.[0].host).toBe("api.example.com");
    expect(config.mitmproxy?.[0].path_prefix).toBe("/v1/");
    expect(config.mitmproxy?.[0].path_suffix).toBe("/attachments");
    expect(config.mitmproxy?.[1].host_suffix).toBe(".example.internal");
    expect(config.mitmproxy?.[1].readonly).toBe(true);
    expect(config.mitmproxy_passthrough).toEqual(["api.openai.com", ".openai.com"]);
  });

  it("rejects mitmproxy rule without host selector", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [{ headers: { Authorization: "Bearer ${TOKEN}" } }],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow(
      'Exactly one of "host" or "host_suffix" is required',
    );
  });

  it("rejects mitmproxy rule with both host and host_suffix", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [
        {
          host: "api.example.com",
          host_suffix: ".example.com",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      ],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow(
      'Exactly one of "host" or "host_suffix" is required',
    );
  });

  it("rejects invalid passthrough entries", () => {
    const path = writeConfig("config.json", {
      mitmproxy_passthrough: ["https://openai.com"],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow(
      "Passthrough entries must be an exact host or a suffix starting with '.'",
    );
  });

  it("rejects mitmproxy rules with invalid path_prefix", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [
        {
          host: "api.example.com",
          path_prefix: "v1",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      ],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow('Invalid string: must start with "/"');
  });

  it("rejects mitmproxy rules with invalid path_suffix", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [
        {
          host: "api.example.com",
          path_suffix: "attachments",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      ],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow('Invalid string: must start with "/"');
  });

  it("rejects mitmproxy rules with empty headers", () => {
    const path = writeConfig("config.json", {
      mitmproxy: [{ host: "api.example.com", headers: {} }],
    });

    expect(() => loadWorkspaceConfig(path)).toThrow('"headers" must contain at least one entry');
  });
});

describe("createConfigLoader", () => {
  it("picks up file changes on next call", () => {
    const path = writeConfig("config.json", {
      mitmproxy_passthrough: ["api.openai.com"],
    });
    const getConfig = createConfigLoader(path);
    expect(getConfig().mitmproxy_passthrough).toEqual(["api.openai.com"]);

    writeFileSync(
      path,
      JSON.stringify({ mitmproxy_passthrough: ["api.openai.com", ".anthropic.com"] }),
    );
    expect(getConfig().mitmproxy_passthrough).toEqual(["api.openai.com", ".anthropic.com"]);
  });

  it("falls back to last good config on corrupt file", () => {
    const path = writeConfig("config.json", {
      mitmproxy_passthrough: ["api.openai.com"],
    });
    const getConfig = createConfigLoader(path);
    expect(getConfig().mitmproxy_passthrough).toEqual(["api.openai.com"]);

    writeFileSync(path, "corrupt{{{");
    expect(getConfig().mitmproxy_passthrough).toEqual(["api.openai.com"]);
  });

  it("throws when no file and no previous config", () => {
    const getConfig = createConfigLoader("/nonexistent/config.json");
    expect(() => getConfig()).toThrow("no previous config available");
  });
});

describe("Slack channel repo routing helpers", () => {
  const resolverFor = (mapping: Record<string, string>) => (repoName: string) => mapping[repoName];

  it("rejects unsafe repo names and missing directories", () => {
    expect(resolveSafeRepoDirectory("../escape", resolverFor({})).reason).toContain(
      "repo name only",
    );
    expect(resolveSafeRepoDirectory("ghost", resolverFor({})).reason).toContain("not found");
  });

  it("rejects repo realpaths outside /workspace/repos", () => {
    expect(resolveSafeRepoDirectory("thor", resolverFor({ thor: tempDir })).reason).toContain(
      "outside /workspace/repos",
    );
  });

  it("falls back to default repo for missing or invalid channel overrides", () => {
    const root = join(tempDir, "repo-by-slack-channel");
    mkdirSync(root);
    const resolveRepo = resolverFor({
      thor: "/workspace/repos/thor",
      opencode: "/workspace/repos/opencode",
    });

    expect(resolveSlackChannelRepoDirectory("C_MISSING", "thor", root, resolveRepo)).toMatchObject({
      directory: "/workspace/repos/thor",
      source: "default",
    });

    writeFileSync(join(root, "C123.txt"), "opencode\n");
    expect(resolveSlackChannelRepoDirectory("C123", "thor", root, resolveRepo)).toMatchObject({
      directory: "/workspace/repos/opencode",
      source: "override",
    });

    writeFileSync(join(root, "C_BAD.txt"), "unknown-repo\n");
    expect(resolveSlackChannelRepoDirectory("C_BAD", "thor", root, resolveRepo)).toMatchObject({
      directory: "/workspace/repos/thor",
      source: "default",
      fallbackReason: "repo directory not found for unknown-repo",
    });
  });

  it("rejects unsafe channel IDs and falls back silently when override is missing", () => {
    const root = join(tempDir, "repo-by-slack-channel");
    mkdirSync(root);
    const resolveRepo = resolverFor({ thor: "/workspace/repos/thor" });

    expect(resolveSlackChannelRepoDirectory("../C123", "thor", root, resolveRepo)).toMatchObject({
      directory: "/workspace/repos/thor",
      source: "default",
      fallbackReason: "invalid channel id",
    });

    const missing = resolveSlackChannelRepoDirectory("C_NONE", "thor", root, resolveRepo);
    expect(missing).toMatchObject({ directory: "/workspace/repos/thor", source: "default" });
    expect(missing.fallbackReason).toBeUndefined();
  });
});

describe("interpolateEnv", () => {
  it("replaces ${VAR} with env value", () => {
    vi.stubEnv("TEST_SECRET", "mysecret");
    expect(interpolateEnv("Bearer ${TEST_SECRET}")).toBe("Bearer mysecret");
    vi.unstubAllEnvs();
  });

  it("throws on missing env var", () => {
    delete process.env.NONEXISTENT_VAR;
    expect(() => interpolateEnv("${NONEXISTENT_VAR}")).toThrow("is not set");
  });

  it("returns string unchanged if no placeholders", () => {
    expect(interpolateEnv("plain string")).toBe("plain string");
  });
});

describe("interpolateHeaders", () => {
  it("interpolates all header values", () => {
    vi.stubEnv("AUTH_TOKEN", "abc123");
    const result = interpolateHeaders({ Authorization: "Bearer ${AUTH_TOKEN}" });
    expect(result).toEqual({ Authorization: "Bearer abc123" });
    vi.unstubAllEnvs();
  });

  it("returns undefined for undefined input", () => {
    expect(interpolateHeaders(undefined)).toBeUndefined();
  });
});

describe("extractRepoFromCwd", () => {
  it("extracts repo name from direct repo path", () => {
    expect(extractRepoFromCwd("/workspace/repos/acme-app")).toBe("acme-app");
  });

  it("extracts repo name from nested path", () => {
    expect(extractRepoFromCwd("/workspace/repos/acme-app/src/lib")).toBe("acme-app");
  });

  it("returns undefined for non-repo path", () => {
    expect(extractRepoFromCwd("/tmp")).toBeUndefined();
  });

  it("returns undefined for /workspace/repos/ without repo name", () => {
    expect(extractRepoFromCwd("/workspace/repos/")).toBeUndefined();
  });

  it("returns undefined for path traversal", () => {
    expect(extractRepoFromCwd("/workspace/repos/../etc/passwd")).toBeUndefined();
  });
});

describe("getInstallationIdForOwner", () => {
  it("returns installation id for known owner", () => {
    expect(
      getInstallationIdForOwner(
        { owners: { acme: { github_app_installation_id: 12345 } } },
        "acme",
      ),
    ).toBe(12345);
  });

  it("returns undefined for unknown or missing owner map", () => {
    expect(getInstallationIdForOwner({}, "acme")).toBeUndefined();
    expect(
      getInstallationIdForOwner({ owners: { other: { github_app_installation_id: 1 } } }, "acme"),
    ).toBeUndefined();
  });
});
