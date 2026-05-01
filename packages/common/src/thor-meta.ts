import { z } from "zod/v4";
import { resolveAlias } from "./event-log.js";
import type { AliasRecord } from "./event-log.js";

export interface ToolArtifact {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ExtractedAlias {
  alias: string;
  context: string;
}

export type CorrelationAlias = Pick<AliasRecord, "aliasType" | "aliasValue">;

const ALIASABLE_TOOLS = new Set(["slack_post_message", "bash"]);

export function isAliasableTool(tool: string): boolean {
  return ALIASABLE_TOOLS.has(tool);
}

const ALIASABLE_GIT_SUBCOMMANDS = new Set(["push", "checkout", "switch", "worktree"]);

export function isAliasableGitCommand(args: string[]): boolean {
  return args.length > 0 && ALIASABLE_GIT_SUBCOMMANDS.has(args[0]);
}

const ALIASABLE_MCP_TOOLS = new Set(["post_message"]);

export function isAliasableMcpTool(tool: string): boolean {
  return ALIASABLE_MCP_TOOLS.has(tool);
}

const SlackPostMessageInput = z.object({
  channel: z.string().optional(),
  thread_ts: z.string().optional(),
});

const SlackPostMessageOutput = z.object({
  ts: z.string().min(1),
  channel: z.string().optional(),
});

export function extractAliases(artifacts: ToolArtifact[]): ExtractedAlias[] {
  const aliases: ExtractedAlias[] = [];

  for (const raw of artifacts) {
    try {
      if (raw.tool === "bash") {
        for (const meta of extractThorMeta(raw.output)) {
          if (meta.type === "alias") aliases.push({ alias: meta.alias, context: meta.context });
        }
        continue;
      }

      if (raw.tool === "slack_post_message") {
        const input = SlackPostMessageInput.safeParse(raw.input);
        if (!input.success) continue;
        const channel = input.data.channel || "unknown";

        if (input.data.thread_ts) {
          aliases.push({
            alias: `slack:thread:${input.data.thread_ts}`,
            context: `Replied in thread in ${channel}`,
          });
        } else {
          const output = SlackPostMessageOutput.safeParse(JSON.parse(raw.output));
          if (!output.success) continue;
          aliases.push({
            alias: `slack:thread:${output.data.ts}`,
            context: `New thread posted to ${output.data.channel || channel}`,
          });
        }
      }
    } catch {
      // Best-effort: skip malformed tool output.
    }
  }

  return aliases;
}

export const ThorMetaAliasSchema = z.object({
  type: z.literal("alias"),
  alias: z.string(),
  context: z.string(),
});

export const ThorMetaApprovalSchema = z.object({
  type: z.literal("approval"),
  actionId: z.string(),
  proxyName: z.string(),
  tool: z.string(),
});

export const ThorMetaSchema = z.discriminatedUnion("type", [
  ThorMetaAliasSchema,
  ThorMetaApprovalSchema,
]);

export type ThorMetaAlias = z.infer<typeof ThorMetaAliasSchema>;
export type ThorMetaApproval = z.infer<typeof ThorMetaApprovalSchema>;
export type ThorMeta = z.infer<typeof ThorMetaSchema>;

export function extractThorMeta(output: string): ThorMeta[] {
  const results: ThorMeta[] = [];
  const regex = /\[thor:meta]\s*(.+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    try {
      const parsed = ThorMetaSchema.safeParse(JSON.parse(match[1]));
      if (parsed.success) results.push(parsed.data);
    } catch {
      // skip malformed JSON
    }
  }
  return results;
}

export function inferRepoFromPath(cwdPath: string): string | undefined {
  if (!cwdPath) return undefined;
  return cwdPath.match(/\/workspace\/(?:repos|worktrees)\/([^/]+)/)?.[1];
}

export function extractBranchFromGitArgs(args: string[]): string | undefined {
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

export function formatThorMeta(meta: ThorMeta): string {
  return `\n[thor:meta] ${JSON.stringify(meta)}\n`;
}

export function computeGitAlias(
  cmd: "git" | "gh",
  args: string[],
  cwd: string,
): ThorMetaAlias | undefined {
  if (!isAliasableGitCommand(args)) return undefined;
  const branch = extractBranchFromGitArgs(args);
  const repo = inferRepoFromPath(cwd);
  if (!branch || !repo) return undefined;
  return {
    type: "alias",
    alias: `git:branch:${repo}:${branch}`,
    context: `${cmd} ${args[0]} in ${cwd}`,
  };
}

export function computeSlackAlias(
  toolArgs: Record<string, unknown>,
  result: string,
): ThorMetaAlias | undefined {
  const channel = (toolArgs.channel as string) || "unknown";
  if (toolArgs.thread_ts) {
    return {
      type: "alias",
      alias: `slack:thread:${toolArgs.thread_ts}`,
      context: `Replied in thread in ${channel}`,
    };
  }
  try {
    const output = SlackPostMessageOutput.safeParse(JSON.parse(result));
    if (!output.success) return undefined;
    return {
      type: "alias",
      alias: `slack:thread:${output.data.ts}`,
      context: `New thread posted to ${output.data.channel || channel}`,
    };
  } catch {
    return undefined;
  }
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

export function aliasForCorrelationKey(key: string): CorrelationAlias | undefined {
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
