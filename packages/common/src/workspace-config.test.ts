import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  createConfigLoader,
  extractRepoFromCwd,
  getInstallationIdForOwner,
  findUserBySlack,
  findUserByGithub,
  getProfileForSlackChannel,
  getProfileForRepo,
  isSlackChannelInProfile,
  getSlackPrivateChannelAllowlist,
  isSlackPrivateChannelAllowed,
  resolveSafeRepoDirectory,
  resolveSlackChannelRepoDirectory,
  resolveStrictProfileForSession,
} from "./workspace-config.ts";
import { appendAlias } from "./event-log.ts";

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

  it("rejects non-positive owner installation IDs with path details", () => {
    const path = writeConfig("config.json", {
      owners: {
        acme: { github_app_installation_id: 0 },
      },
    });
    expect(() => loadWorkspaceConfig(path)).toThrow("owners.acme.github_app_installation_id");
  });

  it("loads the tracked workspace config example", () => {
    const config = loadWorkspaceConfig(join(process.cwd(), "docs/examples/thor.json"));
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

  it("loads users and resolves identities case-insensitively where appropriate", () => {
    const path = writeConfig("config.json", {
      users: [
        { email: "alice@example.com", name: "Alice", slack: "UABCDEF1", github: "Alice-Dev" },
        { email: "bob@example.com", name: "Bob" },
      ],
    });
    const config = loadWorkspaceConfig(path);
    expect(findUserBySlack(config, "UABCDEF1")?.email).toBe("alice@example.com");
    expect(findUserByGithub(config, "alice-dev")?.slack).toBe("UABCDEF1");
    expect(findUserBySlack(config, "UNOMATCH")).toBeUndefined();
  });

  it("accepts profiles and exposes channel lookup helpers", () => {
    const path = writeConfig("config.json", {
      profiles: {
        QA: { channels: ["G123", "D456"] },
        LABS: { channels: ["C789"] },
      },
    });

    const config = loadWorkspaceConfig(path);
    expect(getProfileForSlackChannel(config, "G123")).toBe("QA");
    expect(getProfileForSlackChannel(config, "C789")).toBe("LABS");
    expect(getProfileForSlackChannel(config, "C000")).toBeUndefined();
    expect(isSlackChannelInProfile(config, "D456")).toBe(true);
    expect(isSlackChannelInProfile(config, "D000")).toBe(false);
  });

  it("accepts the Slack private-channel allowlist independently from profiles", () => {
    const path = writeConfig("config.json", {
      slack: { private_channel_allowlist: ["G123", "D456"] },
      profiles: {
        QA: { channels: ["G_PROFILE_ONLY"] },
      },
    });

    const config = loadWorkspaceConfig(path);
    expect(getSlackPrivateChannelAllowlist(config)).toEqual(["G123", "D456"]);
    expect(isSlackPrivateChannelAllowed(config, "G123")).toBe(true);
    expect(isSlackPrivateChannelAllowed(config, "G_PROFILE_ONLY")).toBe(false);
  });

  it("rejects duplicate Slack private-channel allowlist entries", () => {
    const path = writeConfig("config.json", {
      slack: { private_channel_allowlist: ["G123", "G123"] },
    });

    expect(() => loadWorkspaceConfig(path)).toThrow("Slack private channel allowlist");
  });

  describe("resolveStrictProfileForSession", () => {
    const anchor = "00000000-0000-7000-8000-000000000aa1";
    const worklogRoot = "/tmp/thor-strict-profile-test";

    beforeEach(() => {
      vi.stubEnv("WORKLOG_DIR", `${worklogRoot}/worklog`);
      rmSync(worklogRoot, { recursive: true, force: true });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(worklogRoot, { recursive: true, force: true });
    });

    function makeConfig() {
      return loadWorkspaceConfig(
        writeConfig("profiles.json", {
          profiles: {
            QA: { channels: ["C123"] },
            LABS: { channels: ["C456"] },
          },
        }),
      );
    }

    it("returns undefined when the session has no anchor binding", () => {
      const config = makeConfig();
      expect(resolveStrictProfileForSession(config, "unknown-session")).toEqual({
        ok: true,
        profile: undefined,
      });
    });

    it("returns undefined when the anchor has no slack.thread aliases", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "s1", anchorId: anchor });
      const config = makeConfig();
      expect(resolveStrictProfileForSession(config, "s1")).toEqual({
        ok: true,
        profile: undefined,
      });
    });

    it("returns the unique profile when every Slack channel maps to the same profile", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "s2", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C123/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C123/1710000000.005",
        anchorId: anchor,
      });
      const config = makeConfig();
      expect(resolveStrictProfileForSession(config, "s2")).toEqual({
        ok: true,
        profile: "QA",
      });
    });

    it("fails hard when channels map to different profiles", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "s3", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C123/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C456/1710000000.002",
        anchorId: anchor,
      });
      const config = makeConfig();
      const result = resolveStrictProfileForSession(config, "s3");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/multiple profiles/);
    });

    it("fails hard when a profile-bound channel coexists with a no-profile channel", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "s4", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C123/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C999/1710000000.002",
        anchorId: anchor,
      });
      const config = makeConfig();
      const result = resolveStrictProfileForSession(config, "s4");
      expect(result.ok).toBe(false);
    });

    function makeRepoConfig() {
      return loadWorkspaceConfig(
        writeConfig("repo-profiles.json", {
          profiles: {
            QA: { repos: ["repo-qa"] },
            LABS: { channels: ["C456"], repos: ["repo-labs"] },
          },
        }),
      );
    }

    it("resolves a profile from the anchor repo alias when there is no Slack binding", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs1", anchorId: anchor });
      appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: anchor });
      const config = makeRepoConfig();
      expect(resolveStrictProfileForSession(config, "rs1")).toEqual({
        ok: true,
        profile: "QA",
      });
    });

    it("lets an anchor repo alias upgrade a channel that maps to no profile when the profile is repo-only", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs2", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C999/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: anchor });
      const config = makeRepoConfig();
      expect(resolveStrictProfileForSession(config, "rs2")).toEqual({
        ok: true,
        profile: "QA",
      });
    });

    it("resolves a mixed profile from the anchor repo alias when there is no Slack binding", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs5", anchorId: anchor });
      appendAlias({ aliasType: "repo", aliasValue: "repo-labs", anchorId: anchor });
      const config = makeRepoConfig();
      expect(resolveStrictProfileForSession(config, "rs5")).toEqual({
        ok: true,
        profile: "LABS",
      });
    });

    it("blocks unlisted Slack channels from adopting a mixed channel+repo profile", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs6", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C999/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({ aliasType: "repo", aliasValue: "repo-labs", anchorId: anchor });
      const config = makeRepoConfig();
      const result = resolveStrictProfileForSession(config, "rs6");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/mixed channel\+repo profile/);
    });

    it("fails when the channel profile and anchor repo alias disagree", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs3", anchorId: anchor });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C456/1710000000.001",
        anchorId: anchor,
      });
      appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: anchor });
      const config = makeRepoConfig();
      const result = resolveStrictProfileForSession(config, "rs3");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/conflicting profiles/);
    });

    it("fails when repo aliases map to different profiles", () => {
      appendAlias({ aliasType: "opencode.session", aliasValue: "rs4", anchorId: anchor });
      appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: anchor });
      appendAlias({ aliasType: "repo", aliasValue: "repo-labs", anchorId: anchor });
      const config = makeRepoConfig();
      const result = resolveStrictProfileForSession(config, "rs4");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/repos in multiple profiles/);
    });
  });

  it("rejects invalid or duplicate profile channel entries", () => {
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("empty-channel.json", { profiles: { QA: { channels: [""] } } }),
      ),
    ).toThrow("profiles.QA.channels.0");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("duplicate-channel.json", {
          profiles: { QA: { channels: ["G123", "G123"] } },
        }),
      ),
    ).toThrow("Profile channels must not contain duplicates");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("duplicate-across-profiles.json", {
          profiles: { QA: { channels: ["G123"] }, LABS: { channels: ["G123"] } },
        }),
      ),
    ).toThrow("Slack channel G123 is assigned to both profiles QA and LABS");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("lowercase-profile.json", {
          profiles: { qa: { channels: ["G123"] } },
        }),
      ),
    ).toThrow("uppercase ASCII letters and underscores");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("hyphen-profile.json", {
          profiles: { "QA-LABS": { channels: ["G123"] } },
        }),
      ),
    ).toThrow("uppercase ASCII letters and underscores");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("digit-profile.json", {
          profiles: { QA1: { channels: ["G123"] } },
        }),
      ),
    ).toThrow("uppercase ASCII letters and underscores");
  });

  it("accepts repo-only and mixed profiles and exposes repo lookup", () => {
    const path = writeConfig("repos.json", {
      profiles: {
        QA: { repos: ["repo-qa"] },
        LABS: { channels: ["C789"], repos: ["repo-labs"] },
      },
    });
    const config = loadWorkspaceConfig(path);
    expect(getProfileForRepo(config, "repo-qa")).toBe("QA");
    expect(getProfileForRepo(config, "repo-labs")).toBe("LABS");
    expect(getProfileForRepo(config, "repo-none")).toBeUndefined();
    expect(getProfileForSlackChannel(config, "C789")).toBe("LABS");
  });

  it("rejects a profile with neither channels nor repos", () => {
    expect(() =>
      loadWorkspaceConfig(writeConfig("empty-profile.json", { profiles: { QA: {} } })),
    ).toThrow("at least one channel or repo");
  });

  it("rejects duplicate repos within and across profiles", () => {
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("dup-repo.json", { profiles: { QA: { repos: ["r", "r"] } } }),
      ),
    ).toThrow("Profile repos must not contain duplicates");
    expect(() =>
      loadWorkspaceConfig(
        writeConfig("dup-repo-across.json", {
          profiles: { QA: { repos: ["r"] }, LABS: { repos: ["r"] } },
        }),
      ),
    ).toThrow("Repo r is assigned to both profiles QA and LABS");
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
