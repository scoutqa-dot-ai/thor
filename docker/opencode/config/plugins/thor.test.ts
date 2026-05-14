import { describe, expect, it, vi } from "vitest";

import thorPluginExport, {
  ThorPlugin,
  allowedSearchRoot,
  applySearchDefinitionGuidance,
  applySearchScopePolicy,
} from "./thor.js";

describe("Thor OpenCode search scope policy", () => {
  it("rewrites absolute glob patterns under an allowed fixed prefix", () => {
    const result = applySearchScopePolicy(
      "glob",
      { path: "/workspace", pattern: "/workspace/repos/thor/**/*.ts" },
      { directory: "/workspace/repos/thor" },
    );

    expect(result).toMatchObject({
      changed: true,
      args: { path: "/workspace/repos/thor", pattern: "**/*.ts" },
    });
  });

  it("rewrites absolute grep includes but not grep regex patterns", () => {
    const result = applySearchScopePolicy(
      "grep",
      { path: "/", pattern: "/workspace/(.*)", include: "/workspace/repos/thor/src/**/*.ts" },
      { directory: "/workspace/repos/thor" },
    );

    expect(result.args).toEqual({
      path: "/workspace/repos/thor/src",
      pattern: "/workspace/(.*)",
      include: "**/*.ts",
    });
  });

  it("allows scoped explicit roots and grep-only tool output exceptions", () => {
    expect(allowedSearchRoot("/workspace/repos", "glob")).toBe(true);
    expect(allowedSearchRoot("/tmp/opencode/session", "glob")).toBe(true);
    expect(allowedSearchRoot("/tmp/slack-download.abc/file", "grep")).toBe(true);
    expect(allowedSearchRoot("/home/thor/.local/share/opencode/tool-output/1.txt", "grep")).toBe(
      true,
    );
    expect(allowedSearchRoot("/home/thor/.local/share/opencode/tool-output/1.txt", "glob")).toBe(
      false,
    );
  });

  it("rejects broad, ambiguous, unsafe, and conflicting shapes", () => {
    expect(() => applySearchScopePolicy("glob", { path: "/workspace", pattern: "**/*" })).toThrow(
      /broad path \/workspace/,
    );
    expect(() => applySearchScopePolicy("glob", { pattern: "/workspace/**/*.ts" })).toThrow(
      /ambiguous or unsafe/,
    );
    expect(() => applySearchScopePolicy("grep", { include: "/usr/local/**/*.js" })).toThrow(
      /ambiguous or unsafe/,
    );
    expect(() =>
      applySearchScopePolicy("glob", {
        path: "/workspace/repos/thor",
        pattern: "/workspace/repos/thor/**/*.ts",
      }),
    ).toThrow(/both explicit path/);
    expect(() =>
      applySearchScopePolicy("glob", {
        path: "/workspace",
        pattern: "/workspace/repos/thor",
      }),
    ).toThrow(/ambiguous or unsafe/);
  });

  it("adds tool-definition guidance for glob and grep only", () => {
    const guided = applySearchDefinitionGuidance("glob", { description: "Find files." });
    expect(guided.description).toContain("Thor search scope guardrail");
    expect(guided.description).toContain("/workspace/<segment>");
    expect(applySearchDefinitionGuidance("bash", { description: "Run shell." })).toEqual({
      description: "Run shell.",
    });
  });

  it("uses a v1 default export so helper exports are not legacy plugin factories", () => {
    expect(thorPluginExport).toEqual({ id: "thor", server: ThorPlugin });
  });

  it("wires real hook signatures without changing shell.env behavior", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await ThorPlugin({ directory: "/workspace/repos/thor" });
    const envOutput = { env: {} as Record<string, string> };
    await hooks["shell.env"]({ sessionID: "s1", callID: "c1" }, envOutput);
    expect(envOutput.env).toEqual({
      THOR_OPENCODE_DIRECTORY: "/workspace/repos/thor",
      THOR_OPENCODE_SESSION_ID: "s1",
      THOR_OPENCODE_CALL_ID: "c1",
    });

    const executeOutput = { args: { pattern: "/workspace/repos/thor/**/*.ts" } };
    await hooks["tool.execute.before"](
      { tool: "glob", sessionID: "s1", callID: "c1" },
      executeOutput,
    );
    expect(executeOutput.args).toEqual({ path: "/workspace/repos/thor", pattern: "**/*.ts" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "search_scope_rewrite" }));

    const definitionOutput = { description: "Search." };
    await hooks["tool.definition"]({ toolID: "grep" }, definitionOutput);
    expect(definitionOutput.description).toContain("relative");
    warn.mockRestore();
  });
});
