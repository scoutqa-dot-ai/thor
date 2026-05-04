import { z } from "zod/v4";
import { appendAlias, currentSessionForAnchor, resolveAlias } from "./event-log.js";
import type { AliasRecord } from "./event-log.js";

const SLACK_THREAD_PREFIX = "slack:thread:";
const GIT_BRANCH_PREFIX = "git:branch:";
export const ANCHOR_LOCK_PREFIX = "anchor:";
export const SESSION_LOCK_PREFIX = "session:";

const GIT_CORRELATION_SUBCOMMANDS = new Set(["push", "checkout", "switch", "worktree"]);

function isGitCorrelationCommand(args: string[]): boolean {
  return args.length > 0 && GIT_CORRELATION_SUBCOMMANDS.has(args[0]);
}

const SlackPostMessageInput = z.object({
  channel: z.string().optional(),
  thread_ts: z.string().optional(),
});

const SlackPostMessageOutput = z.object({
  ts: z.string().min(1),
  channel: z.string().optional(),
});

type CorrelationAlias = Pick<AliasRecord, "aliasType" | "aliasValue">;

function inferRepoFromPath(cwdPath: string): string | undefined {
  if (!cwdPath) return undefined;
  return cwdPath.match(/\/workspace\/(?:repos|worktrees)\/([^/]+)/)?.[1];
}

function extractBranchFromGitArgs(args: string[]): string | undefined {
  if (args.length < 2) return undefined;
  const subcommand = args[0];

  if (subcommand === "push") {
    const positional = args.slice(1).filter((a) => !a.startsWith("-"));
    const raw = positional.length >= 2 ? positional[positional.length - 1] : undefined;
    if (!raw) return undefined;
    const ref = raw.includes(":") ? raw.split(":").pop()! : raw;
    return ref.replace(/^refs\/heads\//, "");
  }

  if (subcommand === "checkout" || subcommand === "switch") {
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (["-b", "-c", "-B", "-C"].includes(args[i])) {
        i++;
        if (i < args.length) positional.push(args[i]);
      } else if (!args[i].startsWith("-")) {
        positional.push(args[i]);
      }
    }
    return positional[0]?.replace(/^origin\//, "");
  }

  if (subcommand === "worktree" && args[1] === "add") {
    const wtArgs = args.slice(2);
    for (let i = 0; i < wtArgs.length; i++) {
      if (wtArgs[i] === "-b" || wtArgs[i] === "-B") return wtArgs[i + 1];
    }
    const positional = wtArgs.filter((a) => !a.startsWith("-"));
    if (positional[1]) return positional[1].replace(/^origin\//, "");
    return positional[0]?.split("/").pop();
  }

  return undefined;
}

export function computeGitCorrelationKey(args: string[], cwd: string): string | undefined {
  if (!isGitCorrelationCommand(args)) return undefined;
  const branch = extractBranchFromGitArgs(args);
  const repo = inferRepoFromPath(cwd);
  if (!branch || !repo) return undefined;
  return `${GIT_BRANCH_PREFIX}${repo}:${branch}`;
}

export function computeSlackCorrelationKey(
  toolArgs: Record<string, unknown>,
  result: string,
): string | undefined {
  const input = SlackPostMessageInput.safeParse(toolArgs);
  if (!input.success) return undefined;
  if (input.data.thread_ts) return `${SLACK_THREAD_PREFIX}${input.data.thread_ts}`;

  try {
    const output = SlackPostMessageOutput.safeParse(JSON.parse(result));
    if (!output.success) return undefined;
    return `${SLACK_THREAD_PREFIX}${output.data.ts}`;
  } catch {
    return undefined;
  }
}

/** Bind a correlation-key alias directly to a known anchor id. */
export function appendCorrelationAliasForAnchor(
  anchorId: string,
  correlationKey: string,
): { ok: true } | { ok: false; error: Error } {
  const alias = aliasForCorrelationKey(correlationKey);
  if (!alias) return { ok: true };
  return appendAlias({ ...alias, anchorId });
}

/**
 * Producer-side helper: bind a correlation-key alias to the executing
 * session's anchor. Fails closed when the session has no anchor binding —
 * surfaces producers that run before the runner registers opencode.session.
 */
export function appendCorrelationAlias(
  sessionId: string,
  correlationKey: string,
): { ok: true } | { ok: false; error: Error } {
  if (!aliasForCorrelationKey(correlationKey)) return { ok: true };
  const anchorId = resolveAlias({ aliasType: "opencode.session", aliasValue: sessionId });
  if (!anchorId) {
    return {
      ok: false,
      error: new Error(
        `cannot bind correlation alias: session ${sessionId} has no anchor binding yet`,
      ),
    };
  }
  return appendCorrelationAliasForAnchor(anchorId, correlationKey);
}

export function resolveCorrelationKeys(rawKeys: string[]): string {
  if (rawKeys.length === 0) return "";
  for (const key of rawKeys) {
    if (resolveAnchorForCorrelationKey(key)) return key;
  }
  return rawKeys[0];
}

export function hasSessionForCorrelationKey(key: string): boolean {
  const anchorId = resolveAnchorForCorrelationKey(key);
  if (!anchorId) return false;
  return currentSessionForAnchor(anchorId) !== undefined;
}

export function resolveCorrelationLockKey(key: string): string {
  const anchorId = resolveAnchorForCorrelationKey(key);
  return anchorId ? `${ANCHOR_LOCK_PREFIX}${anchorId}` : key;
}

function aliasForCorrelationKey(key: string): CorrelationAlias | undefined {
  if (key.startsWith(SLACK_THREAD_PREFIX)) {
    return {
      aliasType: "slack.thread_id",
      aliasValue: key.slice(SLACK_THREAD_PREFIX.length),
    };
  }
  if (key.startsWith(GIT_BRANCH_PREFIX)) {
    return {
      aliasType: "git.branch",
      aliasValue: Buffer.from(key).toString("base64url"),
    };
  }
  return undefined;
}

export function resolveAnchorForCorrelationKey(key: string): string | undefined {
  const alias = aliasForCorrelationKey(key);
  return alias ? resolveAlias(alias) : undefined;
}

export function resolveSessionForCorrelationKey(key: string): string | undefined {
  const anchorId = resolveAnchorForCorrelationKey(key);
  return anchorId ? currentSessionForAnchor(anchorId) : undefined;
}
