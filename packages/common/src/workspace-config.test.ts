import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  createConfigLoader,
  getAllowedChannelIds,
  getChannelRepoMap,
  extractRepoFromCwd,
  getRepoUpstreams,
  getInstallationIdForOrg,
  interpolateEnv,
  interpolateHeaders,
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
  it("loads a valid config with repos only", () => {
    const path = writeConfig("config.json", {
      repos: { "my-repo": { channels: ["C123"] } },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.repos["my-repo"].channels).toEqual(["C123"]);
  });

  it("throws on missing file", () => {
    expect(() => loadWorkspaceConfig("/nonexistent/path.json")).toThrow("Failed to read");
  });

  it("throws on invalid JSON", () => {
    const path = join(tempDir, "bad.json");
    writeFileSync(path, "not json {{{");
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid JSON");
  });

  it("throws on schema violation (missing repos)", () => {
    const path = writeConfig("config.json", { orgs: {} });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid workspace config");
  });

  it("rejects non-positive org installation IDs with path details", () => {
    const path = writeConfig("config.json", {
      repos: { "my-repo": {} },
      orgs: {
        acme: { github_app_installation_id: 0 },
      },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("orgs.acme.github_app_installation_id");
  });

  it("rejects the legacy top-level proxies block with a migration hint", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: {},
    });
    expect(() => loadWorkspaceConfig(path)).toThrow('Top-level "proxies" has moved to code');
  });

  it("throws on duplicate channel IDs across repos", () => {
    const path = writeConfig("config.json", {
      repos: {
        "repo-a": { channels: ["C123"] },
        "repo-b": { channels: ["C123"] },
      },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow('Duplicate channel ID "C123"');
  });

  it("accepts repo with valid proxies array", () => {
    const path = writeConfig("config.json", {
      repos: { "my-repo": { channels: ["C1"], proxies: ["slack"] } },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.repos["my-repo"].proxies).toEqual(["slack"]);
  });

  it("throws when repo references unknown proxy", () => {
    const path = writeConfig("config.json", {
      repos: { "my-repo": { proxies: ["nonexistent"] } },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow(
      "Available proxies: atlassian, grafana, posthog, slack",
    );
  });

  it("loads the tracked workspace config example", () => {
    const config = loadWorkspaceConfig(
      join(process.cwd(), "docs/examples/workspace-config.example.json"),
    );

    expect(config.repos["your-repo"]).toBeDefined();
    expect(config.repos["your-repo"].proxies).toEqual(["atlassian", "grafana", "slack"]);
    expect(config.orgs).toEqual({
      "scoutqa-dot-ai": { github_app_installation_id: 126669985 },
    });
  });
});

describe("createConfigLoader", () => {
  it("loads config on first call", () => {
    const path = writeConfig("config.json", {
      repos: { r: { channels: ["C1"] } },
    });
    const getConfig = createConfigLoader(path);
    const config = getConfig();
    expect(config.repos.r.channels).toEqual(["C1"]);
  });

  it("picks up file changes on next call", () => {
    const path = writeConfig("config.json", {
      repos: { r: { channels: ["C1"] } },
    });
    const getConfig = createConfigLoader(path);
    expect(getConfig().repos.r.channels).toEqual(["C1"]);

    writeFileSync(path, JSON.stringify({ repos: { r: { channels: ["C1", "C2"] } } }));
    expect(getConfig().repos.r.channels).toEqual(["C1", "C2"]);
  });

  it("falls back to last good config on corrupt file", () => {
    const path = writeConfig("config.json", {
      repos: { r: { channels: ["C1"] } },
    });
    const getConfig = createConfigLoader(path);
    expect(getConfig().repos.r.channels).toEqual(["C1"]);

    writeFileSync(path, "corrupt{{{");
    const config = getConfig();
    expect(config.repos.r.channels).toEqual(["C1"]);
  });

  it("throws when no file and no previous config", () => {
    const getConfig = createConfigLoader("/nonexistent/config.json");
    expect(() => getConfig()).toThrow("no previous config available");
  });
});

describe("getAllowedChannelIds", () => {
  it("returns union of all channel IDs", () => {
    const ids = getAllowedChannelIds({
      repos: {
        a: { channels: ["C1", "C2"] },
        b: { channels: ["C3"] },
      },
    });
    expect(ids).toEqual(new Set(["C1", "C2", "C3"]));
  });

  it("handles repos without channels", () => {
    const ids = getAllowedChannelIds({ repos: { a: {} } });
    expect(ids.size).toBe(0);
  });
});

describe("getChannelRepoMap", () => {
  it("maps channels to repo names", () => {
    const map = getChannelRepoMap({
      repos: {
        "repo-a": { channels: ["C1"] },
        "repo-b": { channels: ["C2", "C3"] },
      },
    });
    expect(map.get("C1")).toBe("repo-a");
    expect(map.get("C2")).toBe("repo-b");
    expect(map.get("C3")).toBe("repo-b");
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

describe("getRepoUpstreams", () => {
  it("returns proxies array for a configured repo", () => {
    const config = loadWorkspaceConfig(
      writeConfig("config.json", {
        repos: { "acme-app": { proxies: ["slack", "atlassian"] } },
      }),
    );
    expect(getRepoUpstreams(config, "acme-app")).toEqual(["slack", "atlassian"]);
  });

  it("returns empty array for repo without proxies field", () => {
    const config = loadWorkspaceConfig(
      writeConfig("config.json", { repos: { "acme-app": { channels: ["C1"] } } }),
    );
    expect(getRepoUpstreams(config, "acme-app")).toEqual([]);
  });

  it("returns undefined for unknown repo", () => {
    const config = loadWorkspaceConfig(writeConfig("config.json", { repos: {} }));
    expect(getRepoUpstreams(config, "unknown")).toBeUndefined();
  });
});

describe("getInstallationIdForOrg", () => {
  it("returns installation id for known org", () => {
    expect(
      getInstallationIdForOrg(
        {
          repos: {},
          orgs: { acme: { github_app_installation_id: 12345 } },
        },
        "acme",
      ),
    ).toBe(12345);
  });

  it("matches org names case-insensitively", () => {
    expect(
      getInstallationIdForOrg(
        {
          repos: {},
          orgs: { "scoutqa-dot-ai": { github_app_installation_id: 126669985 } },
        },
        "ScoutQA-Dot-AI",
      ),
    ).toBe(126669985);
  });

  it("returns undefined for unknown or missing org map", () => {
    expect(getInstallationIdForOrg({ repos: {} }, "acme")).toBeUndefined();
    expect(
      getInstallationIdForOrg(
        {
          repos: {},
          orgs: { other: { github_app_installation_id: 1 } },
        },
        "acme",
      ),
    ).toBeUndefined();
  });
});
