import { z } from "zod/v4";
import {
  appendAlias,
  currentSessionForAnchor,
  mintAnchor,
  resolveAlias,
  resolveSessionAnchorId,
} from "./event-log.ts";
import type { AliasRecord } from "./event-log.ts";
import { withKeyLock } from "./key-lock.ts";

const SLACK_THREAD_PREFIX = "slack:thread:";
const GIT_BRANCH_PREFIX = "git:branch:";
const GITHUB_ISSUE_PREFIX = "github:issue:";
const ANCHOR_LOCK_PREFIX = "anchor:";
export const SESSION_LOCK_PREFIX = "session:";

const SlackPostMessageInput = z.object({
  channel: z.string().optional(),
  thread_ts: z.string().optional(),
});

const SlackPostMessageOutput = z.object({
  ts: z.string().min(1),
  channel: z.string().optional(),
});

type CorrelationAlias = Pick<AliasRecord, "aliasType" | "aliasValue">;
export type EnsureAnchorResult =
  | { anchorId: string; minted: boolean }
  | { anchorId: undefined; minted: false; reason: "unsupported_prefix" };

const anchorEnsureLocks = new Map<string, Promise<unknown>>();

function inferRepoFromPath(cwdPath: string): string | undefined {
  if (!cwdPath) return undefined;
  return cwdPath.match(/\/workspace\/(?:repos|worktrees)\/([^/]+)/)?.[1];
}

function extractBranchFromGitArgs(args: string[]): string | undefined {
  if (args.length < 2) return undefined;
  const subcommand = args[0];

  if (subcommand === "push") {
    if (args.includes("--dry-run")) return undefined;
    const positional = args.slice(1).filter((a) => !a.startsWith("-"));
    if (positional.length !== 2 || positional[0] !== "origin") return undefined;
    const prefix = "HEAD:refs/heads/";
    const refspec = positional[1];
    return refspec.startsWith(prefix) ? refspec.slice(prefix.length) : undefined;
  }

  return undefined;
}

export function computeGitCorrelationKey(args: string[], cwd: string): string | undefined {
  if (args[0] !== "push") return undefined;
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
  const channelFromArgs = input.data.channel;
  if (input.data.thread_ts) {
    if (!channelFromArgs) return undefined;
    return buildSlackCorrelationKey(channelFromArgs, input.data.thread_ts);
  }

  try {
    const output = SlackPostMessageOutput.safeParse(JSON.parse(result));
    if (!output.success) return undefined;
    const channel = channelFromArgs ?? output.data.channel;
    if (!channel) return undefined;
    return buildSlackCorrelationKey(channel, output.data.ts);
  } catch {
    return undefined;
  }
}

/**
 * Build the channel-qualified `slack:thread:<channel>/<ts>` correlation key.
 * Channel is required — anchor binding under the strict channel/profile model
 * has no meaning without a channel, so callers that may not have one must
 * guard before calling.
 */
export function buildSlackCorrelationKey(channel: string, threadTs: string): string {
  return `${SLACK_THREAD_PREFIX}${channel}/${threadTs}`;
}

/** Bind a correlation-key alias directly to a known anchor id. */
export function appendCorrelationAliasForAnchor(anchorId: string, correlationKey: string): void {
  const alias = aliasForCorrelationKey(correlationKey);
  if (!alias) return;
  appendAlias({ ...alias, anchorId });
}

export function ensureAnchorForCorrelationKey(key: string): Promise<EnsureAnchorResult> {
  if (!aliasForCorrelationKey(key)) {
    return Promise.resolve({
      anchorId: undefined,
      minted: false,
      reason: "unsupported_prefix",
    });
  }

  return withKeyLock(anchorEnsureLocks, key, () => {
    const existing = resolveAnchorForCorrelationKey(key);
    if (existing) return { anchorId: existing, minted: false };

    const anchorId = mintAnchor();
    appendCorrelationAliasForAnchor(anchorId, key);
    return { anchorId, minted: true };
  });
}

/**
 * Producer-side helper: bind a correlation-key alias to the executing
 * session's anchor. Fails closed when the session has no anchor binding —
 * surfaces producers that run before the runner registers opencode.session.
 */
export function appendCorrelationAlias(sessionId: string, correlationKey: string): void {
  if (!aliasForCorrelationKey(correlationKey)) return;
  const anchorId = resolveSessionAnchorId(sessionId);
  if (!anchorId) {
    throw new Error(
      `cannot bind correlation alias: session ${sessionId} has no anchor binding yet`,
    );
  }
  appendCorrelationAliasForAnchor(anchorId, correlationKey);
}

export function resolveCorrelationKeys(rawKeys: string[]): string {
  if (rawKeys.length === 0) return "";
  for (const key of rawKeys) {
    if (resolveAnchorForCorrelationKey(key)) return key;
  }
  return rawKeys[0];
}

export function hasSessionForCorrelationKey(key: string | string[]): boolean {
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    const anchorId = resolveAnchorForCorrelationKey(k);
    if (anchorId && currentSessionForAnchor(anchorId) !== undefined) return true;
  }
  return false;
}

export function resolveCorrelationLockKey(key: string): string {
  const anchorId = resolveAnchorForCorrelationKey(key);
  return anchorId ? `${ANCHOR_LOCK_PREFIX}${anchorId}` : key;
}

function aliasForCorrelationKey(key: string): CorrelationAlias | undefined {
  if (key.startsWith(SLACK_THREAD_PREFIX)) {
    const suffix = key.slice(SLACK_THREAD_PREFIX.length);
    if (!suffix.includes("/")) return undefined;
    return { aliasType: "slack.thread", aliasValue: suffix };
  }
  if (key.startsWith(GIT_BRANCH_PREFIX)) {
    return {
      aliasType: "git.branch",
      aliasValue: Buffer.from(key).toString("base64url"),
    };
  }
  if (key.startsWith(GITHUB_ISSUE_PREFIX)) {
    return {
      aliasType: "github.issue",
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
