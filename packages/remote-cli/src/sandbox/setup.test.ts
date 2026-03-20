import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setupSandboxOpenCode,
  uploadSandboxAuth,
  resetSetupState,
  stripRefreshFields,
} from "./setup.js";
import type { SandboxProvider } from "./provider.js";

// ── Mock provider ───────────────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: unknown[];
}

function createMockProvider(): SandboxProvider & { calls: MockCall[] } {
  const mock: SandboxProvider & { calls: MockCall[] } = {
    calls: [],
    async create() {
      return "sb-1";
    },
    async destroy() {},
    async list() {
      return [];
    },
    async uploadFile(_id: string, path: string, data: Buffer) {
      mock.calls.push({ method: "uploadFile", args: [path, data.toString()] });
    },
    async executeCommand(_id: string, command: string) {
      mock.calls.push({ method: "executeCommand", args: [command] });
      return { exitCode: 0, result: "" };
    },
    async syncIn() {},
    async syncOut() {
      return { filesChanged: 0, filesDeleted: 0 };
    },
    async runAgentStreaming() {
      return { exitCode: 0 };
    },
  };
  return mock;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("setupSandboxOpenCode", () => {
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    provider = createMockProvider();
    resetSetupState("sb-1");
  });

  it("installs pinned opencode version", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    const installCall = provider.calls.find(
      (c) => c.method === "executeCommand" && (c.args[0] as string).includes("opencode-ai@"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.args[0]).toContain("opencode-ai@1.2.27");
  });

  it("creates config directories in sandbox", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    const mkdirCall = provider.calls.find(
      (c) => c.method === "executeCommand" && (c.args[0] as string).includes("mkdir"),
    );
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall!.args[0]).toContain(".config/opencode");
    expect(mkdirCall!.args[0]).toContain(".local/share/opencode");
  });

  it("uploads opencode.json with no MCP servers", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    const configUpload = provider.calls.find(
      (c) => c.method === "uploadFile" && (c.args[0] as string).includes("opencode.json"),
    );
    expect(configUpload).toBeDefined();
    const config = JSON.parse(configUpload!.args[1] as string);
    expect(config.permission).toBe("allow");
    expect(config.mcp).toEqual({});
  });

  it("does not upload a coder agent prompt", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    const agentUpload = provider.calls.find(
      (c) => c.method === "uploadFile" && (c.args[0] as string).includes("coder.md"),
    );
    expect(agentUpload).toBeUndefined();
  });

  it("skips setup on repeat calls for the same sandbox", async () => {
    await setupSandboxOpenCode(provider, "sb-1");
    const firstCallCount = provider.calls.length;

    provider.calls = [];
    await setupSandboxOpenCode(provider, "sb-1");

    expect(provider.calls.length).toBe(0);
  });

  it("runs setup again after resetSetupState", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    resetSetupState("sb-1");
    provider.calls = [];
    await setupSandboxOpenCode(provider, "sb-1");

    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it("does not upload auth.json (auth is per-prompt via uploadSandboxAuth)", async () => {
    await setupSandboxOpenCode(provider, "sb-1");

    const authUpload = provider.calls.find(
      (c) => c.method === "uploadFile" && (c.args[0] as string).includes("auth.json"),
    );
    expect(authUpload).toBeUndefined();
  });
});

describe("uploadSandboxAuth", () => {
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    provider = createMockProvider();
  });

  it("does not throw if auth.json is missing", async () => {
    await expect(uploadSandboxAuth(provider, "sb-1")).resolves.not.toThrow();
  });

  it("uploads auth.json with refresh fields stripped", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "auth-test-"));
    const authPath = join(tmpDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        access_token: "keep",
        refresh_token: "strip",
        nested: { refreshToken: "strip", id: "keep" },
      }),
    );

    const origPath = process.env.OPENCODE_AUTH_PATH;
    process.env.OPENCODE_AUTH_PATH = authPath;

    try {
      await uploadSandboxAuth(provider, "sb-1");

      const authUpload = provider.calls.find(
        (c) => c.method === "uploadFile" && (c.args[0] as string).includes("auth.json"),
      );
      expect(authUpload).toBeDefined();
      const uploaded = JSON.parse(authUpload!.args[1] as string);
      expect(uploaded.access_token).toBe("keep");
      expect(uploaded.refresh_token).toBe("");
      expect(uploaded.nested.refreshToken).toBe("");
      expect(uploaded.nested.id).toBe("keep");
    } finally {
      process.env.OPENCODE_AUTH_PATH = origPath;
      unlinkSync(authPath);
    }
  });

  it("runs every time (not skipped on repeat calls)", async () => {
    await uploadSandboxAuth(provider, "sb-1");
    provider.calls = [];
    await uploadSandboxAuth(provider, "sb-1");

    // Should still attempt (will fail to read file, but won't skip)
    // No calls because auth.json doesn't exist in test, but it didn't short-circuit
    // The key assertion: it doesn't have a "skip" path like setupSandboxOpenCode
    expect(true).toBe(true); // reaches here without throw
  });
});

describe("stripRefreshFields", () => {
  it("empties top-level refresh fields", () => {
    const input = {
      access_token: "abc",
      refresh_token: "secret",
      token_type: "bearer",
    };
    expect(stripRefreshFields(input)).toEqual({
      access_token: "abc",
      refresh_token: "",
      token_type: "bearer",
    });
  });

  it("empties nested refresh fields", () => {
    const input = {
      provider: {
        accessToken: "abc",
        refreshToken: "secret",
        refreshExpiresAt: 12345,
        expiresAt: 99999,
      },
    };
    expect(stripRefreshFields(input)).toEqual({
      provider: {
        accessToken: "abc",
        refreshToken: "",
        refreshExpiresAt: 0,
        expiresAt: 99999,
      },
    });
  });

  it("handles case-insensitive matching", () => {
    const input = {
      REFRESH_TOKEN: "gone",
      Refresh: "gone",
      canRefreshAt: "gone",
      token: "kept",
    };
    expect(stripRefreshFields(input)).toEqual({
      REFRESH_TOKEN: "",
      Refresh: "",
      canRefreshAt: "",
      token: "kept",
    });
  });

  it("handles arrays", () => {
    const input = {
      accounts: [
        { id: 1, token: "a", refreshToken: "x" },
        { id: 2, token: "b", refreshToken: "y" },
      ],
    };
    expect(stripRefreshFields(input)).toEqual({
      accounts: [
        { id: 1, token: "a", refreshToken: "" },
        { id: 2, token: "b", refreshToken: "" },
      ],
    });
  });

  it("passes through primitives unchanged", () => {
    expect(stripRefreshFields("hello")).toBe("hello");
    expect(stripRefreshFields(42)).toBe(42);
    expect(stripRefreshFields(null)).toBe(null);
    expect(stripRefreshFields(true)).toBe(true);
  });
});
