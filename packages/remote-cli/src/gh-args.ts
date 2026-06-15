import {
  buildThorDisclaimer,
  buildThorDisclaimerForSession,
  createLogger,
  getRunnerBaseUrl,
  logInfo,
  type ConfigLoader,
} from "@thor/common";
import { attributionFields, resolveTriggerUser } from "./attribution.ts";

const log = createLogger("remote-cli");

type FlagMatch = { index: number; valueIndex?: number; inlinePrefix?: string };

export function rewriteValueFlag(
  args: string[],
  names: string[],
  append: string | ((value: string) => string),
  options: { valuePrefix?: string; match: "single" | "last" } = { match: "single" },
): string[] | { error: "duplicate" | "notFound" } {
  const { valuePrefix, match: mode } = options;
  const matches: FlagMatch[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && i + 1 < args.length) {
        if (valuePrefix && !args[i + 1].startsWith(valuePrefix)) continue;
        matches.push({ index: i, valueIndex: i + 1 });
        i += 1;
        break;
      }
      if (args[i].startsWith(`${name}=`)) {
        const value = args[i].slice(name.length + 1);
        if (valuePrefix && !value.startsWith(valuePrefix)) continue;
        matches.push({ index: i, inlinePrefix: `${name}=` });
        break;
      }
    }
  }
  if (matches.length === 0) return { error: "notFound" };
  if (matches.length > 1 && mode === "single") return { error: "duplicate" };
  const m = mode === "last" ? matches[matches.length - 1] : matches[0];
  const out = [...args];
  const rewrite = (value: string) =>
    typeof append === "function" ? append(value) : `${value}${append}`;
  if (m.valueIndex !== undefined) {
    out[m.valueIndex] = rewrite(out[m.valueIndex]);
  } else if (m.inlinePrefix) {
    out[m.index] = `${m.inlinePrefix}${rewrite(out[m.index].slice(m.inlinePrefix.length))}`;
  }
  return out;
}

export function hasFlag(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function logAttribution(surface: string, outcome: string, extra: Record<string, unknown> = {}) {
  logInfo(log, "attribution_applied", { surface, outcome, ...extra });
}

export function withGitAttribution(
  args: string[],
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): string[] {
  if (args[0] !== "commit") return args;
  const resolved = resolveTriggerUser(sessionId, getConfig);
  if (!resolved.user) {
    logAttribution(
      "git",
      resolved.reason ?? "skipped_no_user_record",
      attributionFields(resolved.actor),
    );
    return args;
  }
  if (hasFlag(args, ["-F", "--file"])) {
    logAttribution(
      "git",
      "skipped_unsupported_arg_shape",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  const trailerLine = `Co-authored-by: ${resolved.user.name} <${resolved.user.email}>`;
  const attributionEmail = resolved.user.email.toLowerCase();
  let alreadyAttributed = false;
  const rewritten = rewriteValueFlag(
    args,
    ["-m", "--message"],
    (message) => {
      if (message.toLowerCase().includes(attributionEmail)) {
        alreadyAttributed = true;
        return message;
      }
      return `${message}${message.endsWith("\n") ? "\n" : "\n\n"}${trailerLine}`;
    },
    { match: "last" },
  );
  if ("error" in rewritten) {
    logAttribution(
      "git",
      "skipped_unsupported_arg_shape",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  if (alreadyAttributed) {
    logAttribution(
      "git",
      "skipped_already_attributed",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  logAttribution("git", "applied", attributionFields(resolved.actor, resolved.user));
  return rewritten;
}

export function withGhAttribution(
  args: string[],
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): string[] {
  if (!((args[0] === "pr" || args[0] === "issue") && args[1] === "create")) return args;
  if (isGhHelpRequest(args)) return args;
  const resolved = resolveTriggerUser(sessionId, getConfig);
  if (hasFlag(args, ["--assignee", "-a"])) {
    logAttribution(
      "gh-assignee",
      "skipped_existing_assignee",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  if (!resolved.user) {
    logAttribution(
      "gh-assignee",
      resolved.reason ?? "skipped_no_user_record",
      attributionFields(resolved.actor),
    );
    return args;
  }
  if (!resolved.user.github) {
    logAttribution("gh-assignee", "skipped_missing_identity_field", {
      field: "github",
      ...attributionFields(resolved.actor, resolved.user),
    });
    return args;
  }
  logAttribution("gh-assignee", "applied", attributionFields(resolved.actor, resolved.user));
  return [...args, "--assignee", resolved.user.github];
}

export function isGhHelpRequest(args: string[]): boolean {
  if (args[0] === "help") return true;
  if (args.length === 1 && ["-h", "--help"].includes(args[0] ?? "")) return true;
  if (args.length === 2 && ["-h", "--help"].includes(args[1] ?? "")) return true;
  if (args.length === 3 && ["-h", "--help"].includes(args[2] ?? "")) return true;
  return false;
}

export function withGhDisclaimer(args: string[], sessionId?: string): string[] | { error: string } {
  if (isGhHelpRequest(args)) return args;
  const eligible =
    (args[0] === "pr" && ["create", "comment", "review"].includes(args[1] ?? "")) ||
    (args[0] === "issue" && ["create", "comment"].includes(args[1] ?? "")) ||
    (args[0] === "api" && args.some((arg) => /pulls\/\d+\/comments\/\d+\/replies/.test(arg)));
  if (!eligible) return args;
  let footer: string;
  try {
    footer = `\n${buildThorDisclaimerForSession(sessionId, getRunnerBaseUrl()).footer}`;
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : "Disclaimer required: unable to build Thor disclaimer",
    };
  }
  return injectBodyFooter(args, footer);
}

/**
 * Post-approval injection for `gh issue create`: builds the disclaimer from the
 * trigger snapshotted onto the action (not a live lookup) and appends the
 * assignee, so neither appears on the approval card.
 */
export function injectGhIssueCreateExec(
  args: string[],
  opts: {
    trigger?: { anchorId: string; triggerId?: string };
    sessionId?: string;
    getConfig: ConfigLoader;
  },
): string[] | { error: string } {
  if (!opts.trigger) {
    return { error: "Disclaimer required: approval action is missing Thor trigger context" };
  }
  const footer = `\n${buildThorDisclaimer(opts.trigger, getRunnerBaseUrl()).footer}`;
  const withFooter = injectBodyFooter(args, footer);
  if ("error" in withFooter) return withFooter;
  return withGhAttribution(withFooter, opts.sessionId, opts.getConfig);
}

function injectBodyFooter(args: string[], footer: string): string[] | { error: string } {
  const result =
    args[0] === "api"
      ? rewriteValueFlag(args, ["-f", "--raw-field"], footer, {
          match: "single",
          valuePrefix: "body=",
        })
      : rewriteValueFlag(args, ["--body", "-b"], footer, { match: "single" });
  if ("error" in result) {
    return {
      error:
        result.error === "duplicate"
          ? "Disclaimer required: multiple mutable gh body fields"
          : "Disclaimer required: could not find a mutable gh body field",
    };
  }
  return result;
}
