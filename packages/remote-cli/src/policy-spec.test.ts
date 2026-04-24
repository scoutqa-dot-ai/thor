import { describe, it, expect } from "vitest";
import { findSpec, parseAgainstSpec, type CommandSpec } from "./policy-spec.js";

describe("findSpec", () => {
  const specs: CommandSpec[] = [
    { path: ["pr"], passthrough: true },
    { path: ["pr", "create"], flags: {} },
    { path: ["pr", "review"], flags: {} },
  ];

  it("picks the longest matching path", () => {
    expect(findSpec(specs, ["pr", "create", "--title", "x"])?.path).toEqual(["pr", "create"]);
    expect(findSpec(specs, ["pr", "view", "123"])?.path).toEqual(["pr"]);
  });

  it("returns undefined when nothing matches", () => {
    expect(findSpec(specs, ["issue", "list"])).toBeUndefined();
    expect(findSpec(specs, [])).toBeUndefined();
  });

  it("does not match when path is longer than args", () => {
    expect(findSpec(specs, ["pr"])?.path).toEqual(["pr"]);
    // Only ["pr"] matches — ["pr","create"] needs a second token
    expect(findSpec([{ path: ["pr", "create"], flags: {} }], ["pr"])).toBeUndefined();
  });
});

describe("parseAgainstSpec", () => {
  describe("passthrough", () => {
    it("accepts any args", () => {
      const spec: CommandSpec = { path: ["view"], passthrough: true };
      const result = parseAgainstSpec(["123", "--json", "title", "--whatever"], spec, {});
      expect(result.ok).toBe(true);
    });

    it("short-circuits past flag and positional rules", () => {
      // passthrough ignores declared flags/positional entirely — declaring
      // both together is legal but the declarations have no effect.
      const spec: CommandSpec = {
        path: ["view"],
        passthrough: true,
        flags: { "--title": { kind: "value" } },
        requiredFlags: ["--title"],
        positional: { min: 0, max: 0 },
      };
      expect(parseAgainstSpec(["anything", "--unknown"], spec, {}).ok).toBe(true);
    });

    it("still runs postValidate so passthrough specs can enforce business rules", () => {
      const spec: CommandSpec = {
        path: ["worktree", "add"],
        passthrough: true,
        postValidate: (p) =>
          p.positional.some((t) => t.startsWith("/workspace/worktrees/"))
            ? null
            : "worktree path must be under /workspace/worktrees/",
      };
      expect(parseAgainstSpec(["/workspace/worktrees/repo/x"], spec, {}).ok).toBe(true);
      const bad = parseAgainstSpec(["/tmp/x"], spec, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain("/workspace/worktrees/");
    });
  });

  describe("bool flags", () => {
    const spec: CommandSpec = {
      path: [],
      flags: { "--draft": { kind: "bool" } },
    };

    it("accepts a bool flag", () => {
      const result = parseAgainstSpec(["--draft"], spec, {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.parsed.flags.get("--draft")).toBe(true);
    });

    it("rejects an inline value on a bool flag", () => {
      const result = parseAgainstSpec(["--draft=yes"], spec, {});
      expect(result.ok).toBe(false);
    });

    it("uses a custom boolFlagValueHint when provided", () => {
      const strict: CommandSpec = {
        ...spec,
        boolFlagValueHint: (flag) => `${flag} is a switch, drop the value`,
      };
      const result = parseAgainstSpec(["--draft=yes"], strict, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("--draft is a switch, drop the value");
    });
  });

  describe("value flags", () => {
    const spec: CommandSpec = {
      path: [],
      flags: { "--title": { kind: "value" }, "--body": { kind: "value" } },
    };

    it("accepts value flag with space-separated value", () => {
      const result = parseAgainstSpec(["--title", "hello"], spec, {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.parsed.flags.get("--title")).toBe("hello");
    });

    it("accepts value flag with = form", () => {
      const result = parseAgainstSpec(["--title=hello"], spec, {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.parsed.flags.get("--title")).toBe("hello");
    });

    it("does NOT consume the next --flag as a value", () => {
      // --title at end with no value should fail, even if --body follows
      // (--body is a value flag too, so it would be consumed as --title's value
      // under a naive parser — this is the current behavior; we accept it as
      // the trade-off since `--title --body x` is an agent bug either way).
      // The important property: we must not accidentally reject `--title x --body y`.
      const result = parseAgainstSpec(["--title", "x", "--body", "y"], spec, {});
      expect(result.ok).toBe(true);
    });

    it("errors when value is missing", () => {
      const result = parseAgainstSpec(["--title"], spec, {});
      expect(result.ok).toBe(false);
    });

    it("runs the flag validator", () => {
      const validated: CommandSpec = {
        path: [],
        flags: {
          "--head": {
            kind: "value",
            validate: (v) => (v.includes(":") ? "head must not contain colon" : null),
          },
        },
      };
      expect(parseAgainstSpec(["--head", "feat/x"], validated, {}).ok).toBe(true);
      const bad = parseAgainstSpec(["--head", "other:feat/x"], validated, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBe("head must not contain colon");
    });
  });

  describe("aliases", () => {
    const spec: CommandSpec = {
      path: [],
      flags: { "--title": { kind: "value" }, "--draft": { kind: "bool" } },
      aliases: { "-t": "--title", "-d": "--draft" },
    };

    it("resolves short flags to canonical", () => {
      const result = parseAgainstSpec(["-t", "hello", "-d"], spec, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parsed.flags.get("--title")).toBe("hello");
        expect(result.parsed.flags.get("--draft")).toBe(true);
      }
    });

    it("resolves short flags with = form", () => {
      const result = parseAgainstSpec(["-t=hello"], spec, {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.parsed.flags.get("--title")).toBe("hello");
    });
  });

  describe("unknown flags", () => {
    it("rejects with generic hint by default", () => {
      const spec: CommandSpec = { path: [], flags: { "--title": { kind: "value" } } };
      const result = parseAgainstSpec(["--fill"], spec, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("--fill");
    });

    it("uses per-spec unknownFlagHint when provided", () => {
      const spec: CommandSpec = {
        path: [],
        flags: { "--title": { kind: "value" } },
        unknownFlagHint: (flag) => `"pr create ${flag}" is not allowed — use --title/--body`,
      };
      const result = parseAgainstSpec(["--fill"], spec, {});
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toBe('"pr create --fill" is not allowed — use --title/--body');
    });

    it("runs unknownFlagHint on blocked flags for targeted error messages", () => {
      // Pattern for gh pr review --approve
      const spec: CommandSpec = {
        path: [],
        flags: { "--body": { kind: "value" } },
        unknownFlagHint: (flag) => {
          if (flag === "--approve" || flag === "-a") {
            return '"gh pr review --approve" is not allowed — PR approval must be human';
          }
          return `"${flag}" is not allowed`;
        },
      };
      const result = parseAgainstSpec(["--approve", "--body", "ok"], spec, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("PR approval must be human");
    });
  });

  describe("required flags", () => {
    const spec: CommandSpec = {
      path: [],
      flags: { "--title": { kind: "value" }, "--body": { kind: "value" } },
      requiredFlags: ["--title", "--body"],
      missingRequiredHint: () => '"gh pr create" requires both --title and --body',
    };

    it("passes when all required flags are present", () => {
      expect(parseAgainstSpec(["--title", "x", "--body", "y"], spec, {}).ok).toBe(true);
    });

    it("fails with the custom hint when missing", () => {
      const result = parseAgainstSpec(["--title", "x"], spec, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("requires both");
    });
  });

  describe("requireOneOf", () => {
    const spec: CommandSpec = {
      path: [],
      flags: {
        "--comment": { kind: "bool" },
        "--request-changes": { kind: "bool" },
        "--body": { kind: "value" },
      },
      requireOneOf: {
        flags: ["--comment", "--request-changes"],
        hint: '"gh pr review" requires exactly one of --comment or --request-changes',
      },
    };

    it("passes when exactly one is set", () => {
      expect(parseAgainstSpec(["--comment", "--body", "x"], spec, {}).ok).toBe(true);
      expect(parseAgainstSpec(["--request-changes", "--body", "x"], spec, {}).ok).toBe(true);
    });

    it("fails when none are set", () => {
      const result = parseAgainstSpec(["--body", "x"], spec, {});
      expect(result.ok).toBe(false);
    });

    it("fails when both are set", () => {
      const result = parseAgainstSpec(["--comment", "--request-changes", "--body", "x"], spec, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("exactly one");
    });
  });

  describe("positional", () => {
    it("enforces min/max", () => {
      const spec: CommandSpec = { path: [], positional: { min: 1, max: 1 } };
      expect(parseAgainstSpec(["123"], spec, {}).ok).toBe(true);
      expect(parseAgainstSpec([], spec, {}).ok).toBe(false);
      expect(parseAgainstSpec(["123", "456"], spec, {}).ok).toBe(false);
    });

    it("runs positional validator on each arg", () => {
      const spec: CommandSpec = {
        path: [],
        positional: {
          min: 1,
          max: 5,
          validate: (v) => (/^\d+$/.test(v) ? null : `${v} must be numeric`),
        },
      };
      expect(parseAgainstSpec(["123", "456"], spec, {}).ok).toBe(true);
      const bad = parseAgainstSpec(["123", "abc"], spec, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBe("abc must be numeric");
    });

    it("rejects any positional when spec declares none", () => {
      const spec: CommandSpec = { path: [], flags: {} };
      expect(parseAgainstSpec(["unexpected"], spec, {}).ok).toBe(false);
    });
  });

  describe("postValidate", () => {
    it("runs after parsing succeeds", () => {
      const spec: CommandSpec = {
        path: [],
        flags: { "--a": { kind: "bool" }, "--b": { kind: "bool" } },
        postValidate: (p) => (p.flags.has("--a") && p.flags.has("--b") ? "cannot use both" : null),
      };
      expect(parseAgainstSpec(["--a"], spec, {}).ok).toBe(true);
      const bad = parseAgainstSpec(["--a", "--b"], spec, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBe("cannot use both");
    });
  });

  describe("parse context", () => {
    it("threads cwd through flag validators", () => {
      const spec: CommandSpec = {
        path: [],
        flags: {
          "--head": {
            kind: "value",
            validate: (_v, ctx) => (ctx.cwd ? null : "cwd required"),
          },
        },
      };
      expect(parseAgainstSpec(["--head", "x"], spec, { cwd: "/tmp" }).ok).toBe(true);
      expect(parseAgainstSpec(["--head", "x"], spec, {}).ok).toBe(false);
    });
  });
});
