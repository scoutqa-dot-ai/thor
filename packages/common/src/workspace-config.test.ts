import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  createConfigLoader,
  getAllowedChannelIds,
  getChannelRepoMap,
  getProxyConfig,
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
    expect(config.proxies).toBeUndefined();
  });

  it("loads a valid config with repos and proxies", () => {
    const path = writeConfig("config.json", {
      repos: { "my-repo": { channels: ["C123"] } },
      proxies: {
        atlassian: {
          upstream: { url: "https://mcp.atlassian.com/v1/mcp" },
          allow: ["getJiraIssue"],
          approve: ["createJiraIssue"],
        },
      },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.proxies!.atlassian.upstream.url).toBe("https://mcp.atlassian.com/v1/mcp");
    expect(config.proxies!.atlassian.allow).toEqual(["getJiraIssue"]);
    expect(config.proxies!.atlassian.approve).toEqual(["createJiraIssue"]);
  });

  it("defaults allow and approve to empty arrays", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: {
        slack: { upstream: { url: "http://slack-mcp:3003/mcp" } },
      },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.proxies!.slack.allow).toEqual([]);
    expect(config.proxies!.slack.approve).toEqual([]);
  });

  it("loads proxy upstream headers", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: {
        atlassian: {
          upstream: {
            url: "https://mcp.atlassian.com/v1/mcp",
            headers: { Authorization: "Basic ${ATLASSIAN_BASIC_AUTH}" },
          },
        },
      },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.proxies!.atlassian.upstream.headers).toEqual({
      Authorization: "Basic ${ATLASSIAN_BASIC_AUTH}",
    });
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
    const path = writeConfig("config.json", { proxies: {} });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid workspace config");
  });

  it("throws on invalid proxy schema (missing upstream url)", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: { bad: { upstream: {} } },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid workspace config");
  });

  it("throws on reserved proxy name", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: { health: { upstream: { url: "http://localhost" } } },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow('Reserved proxy name "health"');
  });

  it("throws on proxy name with path traversal chars", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: { "../etc": { upstream: { url: "http://localhost" } } },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid proxy name");
  });

  it("throws on proxy name with uppercase", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: { Atlassian: { upstream: { url: "http://localhost" } } },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("Invalid proxy name");
  });

  it("allows valid proxy names with hyphens", () => {
    const path = writeConfig("config.json", {
      repos: {},
      proxies: { "my-proxy-1": { upstream: { url: "http://localhost" } } },
    });
    const config = loadWorkspaceConfig(path);
    expect(config.proxies!["my-proxy-1"]).toBeDefined();
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

describe("getProxyConfig", () => {
  it("returns proxy config by name", () => {
    const config = loadWorkspaceConfig(
      writeConfig("config.json", {
        repos: {},
        proxies: {
          slack: { upstream: { url: "http://slack:3003/mcp" }, allow: ["post_message"] },
        },
      }),
    );
    const proxy = getProxyConfig(config, "slack");
    expect(proxy?.upstream.url).toBe("http://slack:3003/mcp");
  });

  it("returns undefined for unknown proxy", () => {
    const config = loadWorkspaceConfig(writeConfig("config.json", { repos: {} }));
    expect(getProxyConfig(config, "unknown")).toBeUndefined();
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
