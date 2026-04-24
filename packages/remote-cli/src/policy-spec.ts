/**
 * Declarative command spec engine for server-side policy.
 *
 * A CommandSpec describes one allowed invocation shape (e.g. "gh pr create"
 * with --title/--body required). The parser walks argv against the spec and
 * either returns null (allowed), an error string (denied with a hint), or a
 * rewritten args array (for specs that normalize shape before exec, like
 * implicit `git push` upstream resolution).
 *
 * Specs are data; the parser is generic. Per-command logic that does not fit
 * the flag/positional shape lives in `rewrite` and `postValidate` hooks so
 * the common 80% stays declarative.
 */

export interface ParseContext {
  cwd?: string;
}

export type FlagValidator = (value: string, ctx: ParseContext) => string | null;
export type PositionalValidator = (value: string, ctx: ParseContext) => string | null;

export type FlagSpec = { kind: "bool" } | { kind: "value"; validate?: FlagValidator };

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export interface CommandSpec {
  /** Command prefix identifying this spec, e.g. ["pr", "create"] or ["push"]. */
  path: string[];

  /**
   * When true, any tokens after `path` are allowed without validation.
   * Used for read-only commands (e.g. `gh pr view`, `git status`) where
   * flag whitelisting adds friction without improving safety.
   */
  passthrough?: boolean;

  /** Canonical flag definitions. Ignored when `passthrough` is true. */
  flags?: Record<string, FlagSpec>;

  /** Alias -> canonical, e.g. { "-t": "--title" }. */
  aliases?: Record<string, string>;

  /** Required canonical flags. */
  requiredFlags?: string[];

  /** Exactly-one-of constraint across canonical flags. */
  requireOneOf?: { flags: string[]; hint: string };

  /** Positional constraints. When absent, no positional args are allowed. */
  positional?: {
    min: number;
    max: number;
    validate?: PositionalValidator;
  };

  /** Hint for an unknown or explicitly-blocked flag token. */
  unknownFlagHint?: (flag: string) => string;

  /** Hint when required flags are missing. */
  missingRequiredHint?: (missing: string[]) => string;

  /** Hint when positional count is outside [min, max]. */
  missingPositionalHint?: string;
  extraPositionalHint?: string;

  /** Hint when a value flag is missing its value. */
  missingValueHint?: (flag: string) => string;

  /** Hint when a bool flag is given an inline value. */
  boolFlagValueHint?: (flag: string) => string;

  /** Runs after parse succeeds. Return an error string to deny. */
  postValidate?: (parsed: ParsedArgs, ctx: ParseContext) => string | null;

  /**
   * Effective-args rewriter. Declared on the spec but NOT called by
   * parseAgainstSpec — the caller (resolveGitArgs / validateGhArgs) invokes
   * it after a successful parse to normalize shape before exec (e.g. implicit
   * `git push` -> explicit refspec). If omitted, the original args are passed
   * through unchanged.
   */
  rewrite?: (
    parsed: ParsedArgs,
    originalArgs: string[],
    ctx: ParseContext,
  ) => string[] | { error: string };
}

/**
 * Find the longest spec path that prefixes `args`. Longest wins so
 * `["pr", "create"]` takes precedence over `["pr"]`.
 */
export function findSpec(specs: readonly CommandSpec[], args: string[]): CommandSpec | undefined {
  let best: CommandSpec | undefined;
  for (const spec of specs) {
    if (spec.path.length > args.length) continue;
    let matches = true;
    for (let i = 0; i < spec.path.length; i += 1) {
      if (args[i] !== spec.path[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (!best || spec.path.length > best.path.length) {
      best = spec;
    }
  }
  return best;
}

/**
 * Validate args against a spec. `args` is expected to be the tokens AFTER
 * `spec.path` has been matched off — the parser does not re-check the path.
 *
 * Returns null on success (possibly rewritten args via `rewrite`), or an
 * error string with a user-facing hint on failure.
 */
export function parseAgainstSpec(
  args: string[],
  spec: CommandSpec,
  ctx: ParseContext,
): { ok: true; parsed: ParsedArgs } | { ok: false; error: string } {
  if (spec.passthrough) {
    return { ok: true, parsed: { positional: [...args], flags: new Map() } };
  }

  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (!arg.startsWith("-")) {
      positional.push(arg);
      i += 1;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const rawFlag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const canonical = spec.aliases?.[rawFlag] ?? rawFlag;
    const flagSpec = spec.flags?.[canonical];

    if (!flagSpec) {
      return { ok: false, error: denyUnknownFlag(spec, arg) };
    }

    if (flagSpec.kind === "bool") {
      if (eqIdx >= 0) {
        return {
          ok: false,
          error: spec.boolFlagValueHint?.(rawFlag) ?? `"${rawFlag}" does not take a value`,
        };
      }
      flags.set(canonical, true);
      i += 1;
      continue;
    }

    // value flag
    let value: string;
    if (eqIdx >= 0) {
      value = arg.slice(eqIdx + 1);
      i += 1;
    } else {
      if (i + 1 >= args.length) {
        return {
          ok: false,
          error: spec.missingValueHint?.(rawFlag) ?? `"${rawFlag}" requires a value`,
        };
      }
      value = args[i + 1];
      i += 2;
    }

    if (flagSpec.validate) {
      const err = flagSpec.validate(value, ctx);
      if (err) return { ok: false, error: err };
    }
    flags.set(canonical, value);
  }

  if (spec.requiredFlags) {
    const missing = spec.requiredFlags.filter((f) => !flags.has(f));
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          spec.missingRequiredHint?.(missing) ?? `missing required flag(s): ${missing.join(", ")}`,
      };
    }
  }

  if (spec.requireOneOf) {
    const setCount = spec.requireOneOf.flags.filter((f) => flags.has(f)).length;
    if (setCount !== 1) {
      return { ok: false, error: spec.requireOneOf.hint };
    }
  }

  if (spec.positional) {
    if (positional.length < spec.positional.min) {
      return {
        ok: false,
        error:
          spec.missingPositionalHint ??
          `expected at least ${spec.positional.min} positional argument(s)`,
      };
    }
    if (positional.length > spec.positional.max) {
      return {
        ok: false,
        error:
          spec.extraPositionalHint ??
          `expected at most ${spec.positional.max} positional argument(s)`,
      };
    }
    if (spec.positional.validate) {
      for (const p of positional) {
        const err = spec.positional.validate(p, ctx);
        if (err) return { ok: false, error: err };
      }
    }
  } else if (positional.length > 0) {
    return {
      ok: false,
      error: spec.extraPositionalHint ?? "unexpected positional argument(s)",
    };
  }

  const parsed: ParsedArgs = { positional, flags };

  if (spec.postValidate) {
    const err = spec.postValidate(parsed, ctx);
    if (err) return { ok: false, error: err };
  }

  return { ok: true, parsed };
}

function denyUnknownFlag(spec: CommandSpec, arg: string): string {
  if (spec.unknownFlagHint) return spec.unknownFlagHint(arg);
  return `"${arg}" is not allowed`;
}
