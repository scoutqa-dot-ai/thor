import { z } from "zod/v4";
import { appendAlias, resolveAlias } from "./event-log.js";
import type { AliasRecord } from "./event-log.js";

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
  return `git:branch:${repo}:${branch}`;
}

export function computeSlackCorrelationKey(
  toolArgs: Record<string, unknown>,
  result: string,
): string | undefined {
  const input = SlackPostMessageInput.safeParse(toolArgs);
  if (!input.success) return undefined;
  if (input.data.thread_ts) return `slack:thread:${input.data.thread_ts}`;

  try {
    const output = SlackPostMessageOutput.safeParse(JSON.parse(result));
    if (!output.success) return undefined;
    return `slack:thread:${output.data.ts}`;
  } catch {
    return undefined;
  }
}

export function appendCorrelationAlias(
  sessionId: string,
  correlationKey: string,
): { ok: true } | { ok: false; error: Error } {
  const alias = aliasForCorrelationKey(correlationKey);
  if (!alias) return { ok: true };
  return appendAlias({ ...alias, sessionId });
}

export function resolveCorrelationKeys(rawKeys: string[]): string {
  if (rawKeys.length === 0) return "";
  for (const key of rawKeys) {
    if (resolveSessionForCorrelationKey(key)) return key;
  }
  return rawKeys[0];
}

export function hasSessionForCorrelationKey(key: string): boolean {
  return resolveSessionForCorrelationKey(key) !== undefined;
}

function aliasForCorrelationKey(key: string): CorrelationAlias | undefined {
  if (key.startsWith("slack:thread:")) {
    return {
      aliasType: "slack.thread_id",
      aliasValue: key.slice("slack:thread:".length),
    };
  }
  if (key.startsWith("git:branch:")) {
    return {
      aliasType: "git.branch",
      aliasValue: Buffer.from(key).toString("base64url"),
    };
  }
  return undefined;
}

export function resolveSessionForCorrelationKey(key: string): string | undefined {
  const alias = aliasForCorrelationKey(key);
  return alias ? resolveAlias(alias) : undefined;
}
