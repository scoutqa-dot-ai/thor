import { describe, expect, it, vi } from "vitest";

import thorPluginExport, {
  ThorPlugin,
  allowedSearchRoot,
  applySearchDefinitionGuidance,
  applySearchScopePolicy,
  findGuardedDynamicShellCommand,
  hasDynamicShellSubstitution,
} from "./thor.js";

describe("Thor OpenCode dynamic shell guard", () => {
  it("finds guarded top-level commands with dynamic substitution", () => {
    expect(findGuardedDynamicShellCommand('gh pr comment 1 --body "$(cat /tmp/body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand("gh api repos/`whoami`")).toBe("gh");
    expect(findGuardedDynamicShellCommand('curl -H "X: $(token)" https://example.invalid')).toBe(
      "curl",
    );
    expect(findGuardedDynamicShellCommand('slack-post-message --text "$(cat msg)"')).toBe(
      "slack-post-message",
    );
    expect(findGuardedDynamicShellCommand('BODY=$(cat body) gh pr comment 1 --body "$BODY"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('git status && gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('sleep 1 & gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('echo hi |& curl "$(token)"')).toBe("curl");
    expect(findGuardedDynamicShellCommand('env -u FOO gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('env -C /tmp curl "$(token)"')).toBe("curl");
    expect(findGuardedDynamicShellCommand('env -S "gh pr comment 1 --body $(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('env --split-string="curl $(token)"')).toBe("curl");
    expect(findGuardedDynamicShellCommand('> /tmp/out gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('2>/tmp/e curl "$(token)"')).toBe("curl");
    expect(
      findGuardedDynamicShellCommand('FOO=bar >/tmp/out slack-post-message --text "$(cat msg)"'),
    ).toBe("slack-post-message");
    expect(findGuardedDynamicShellCommand('exec gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('time gh pr comment 1 --body "$(cat body)"')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('time -p curl "$(token)"')).toBe("curl");
    expect(findGuardedDynamicShellCommand('( gh pr comment 1 --body "$(cat body)" )')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('{ gh pr comment 1 --body "$(cat body)"; }')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('{ curl "$(token)"; }')).toBe("curl");
    expect(findGuardedDynamicShellCommand('( gh pr comment 1 --body "$(cat body)" ) >/tmp/out')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand('{ gh pr comment 1 --body "$(cat body)"; } >/tmp/out')).toBe(
      "gh",
    );
    expect(findGuardedDynamicShellCommand("/usr/bin/curl https://$(hostname)")).toBe("curl");
  });

  it("allows reviewed literals and nested guarded commands under unguarded commands", () => {
    expect(hasDynamicShellSubstitution("'$(cat body)'")).toBe(false);
    expect(hasDynamicShellSubstitution('"$(cat body)"')).toBe(true);
    expect(findGuardedDynamicShellCommand('echo "$(gh pr view 1)"')).toBeUndefined();
    expect(
      findGuardedDynamicShellCommand('echo $(printf x; gh pr comment 1 --body "$(cat body)")'),
    ).toBeUndefined();
    expect(findGuardedDynamicShellCommand('echo $(printf x |& curl "$(token)")')).toBeUndefined();
    expect(findGuardedDynamicShellCommand('env -S \'gh pr comment 1 --body $(cat body)\'')).toBeUndefined();
    expect(findGuardedDynamicShellCommand('env -S "echo $(gh pr view 1)"')).toBeUndefined();
    expect(findGuardedDynamicShellCommand("( gh pr comment 1 --body '$(cat body)' )")).toBeUndefined();
    expect(findGuardedDynamicShellCommand("gh pr comment 1 --body '$(cat body)'")).toBeUndefined();
    expect(findGuardedDynamicShellCommand("gh pr view 1")).toBeUndefined();
    expect(findGuardedDynamicShellCommand('slack-post-message --text "done"')).toBeUndefined();
  });

  it("wires the bash hook to reject guarded dynamic commands only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await ThorPlugin({ directory: "/workspace/repos/thor" });

    await expect(
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command: 'gh pr comment 1 --body "$(cat body)"' } },
      ),
    ).rejects.toThrow(/dynamic shell substitution.*guarded command "gh"/);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "dynamic_shell_substitution_block",
        tool: "bash",
        command: "gh",
        sessionID: "s1",
        callID: "c1",
      }),
    );

    const nonBashOutput = { args: { command: 'gh pr comment 1 --body "$(cat body)"' } };
    await hooks["tool.execute.before"]({ tool: "not-bash" }, nonBashOutput);
    expect(nonBashOutput.args).toEqual({ command: 'gh pr comment 1 --body "$(cat body)"' });

    const bashOutput = { args: { command: 'echo "$(gh pr view 1)"' } };
    await hooks["tool.execute.before"]({ tool: "bash" }, bashOutput);
    expect(bashOutput.args).toEqual({ command: 'echo "$(gh pr view 1)"' });
    warn.mockRestore();
  });
});

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
    expect(allowedSearchRoot("/tmp", "glob")).toBe(true);
    expect(allowedSearchRoot("/tmp/any/arbitrary/path", "grep")).toBe(true);
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
        pattern: "../**/*",
      }),
    ).toThrow(/traversal in pattern/);
    expect(() =>
      applySearchScopePolicy("grep", {
        path: "/workspace/repos/thor",
        pattern: "TODO",
        include: "../**/*",
      }),
    ).toThrow(/traversal in include/);
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
    expect(guided.description).toContain("/tmp");
    expect(guided.description).toContain("absolute --glob");
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

    const allowedOutput = {
      args: { path: "/workspace/repos/thor", pattern: "TODO", include: "*.ts" },
    };
    await hooks["tool.execute.before"](
      { tool: "grep", sessionID: "s2", callID: "c2" },
      allowedOutput,
    );
    expect(allowedOutput.args).toEqual({
      path: "/workspace/repos/thor",
      pattern: "TODO",
      include: "*.ts",
    });
    expect(warn).toHaveBeenCalledTimes(1);

    const definitionOutput = { description: "Search." };
    await hooks["tool.definition"]({ toolID: "grep" }, definitionOutput);
    expect(definitionOutput.description).toContain("relative");
    warn.mockRestore();
  });
});
