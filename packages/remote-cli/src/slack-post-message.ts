import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import {
  appendCorrelationAlias,
  buildSlackCorrelationKey,
  currentSessionForAnchor,
  isPathWithin,
  realpathOrNull,
  resolveAlias,
  resolveSessionAnchorId,
  SUPPORTED_SLACK_CHANNEL_ID,
  type ExecResult,
} from "@thor/common";
import MarkdownIt from "markdown-it";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const markdownParser = new MarkdownIt("commonmark");

const MAX_MRKDWN_BYTES = 40 * 1024;
const MAX_BLOCKS_FILE_BYTES = 128 * 1024;
const BLOCKS_FILE_ALLOWED_ROOTS = ["/tmp", "/workspace"] as const;
const MARKDOWN_TABLE_SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const COMMONMARK_DOUBLE_STAR = /\*\*/;
const LITERAL_BACKSLASH_N = /\\n/;
const SLACK_MRKDWN_STEERING =
  "Use Slack mrkdwn instead: `*bold*` (not `**bold**`), `_italic_`, bullets, and code spans/fences as needed.";

export interface SlackPostMessageDeps {
  client?: WebClient;
  env?: { SLACK_BOT_TOKEN?: string; SLACK_API_BASE_URL?: string };
  appendAlias?: typeof appendCorrelationAlias;
  logAliasError?: (error: Error, meta: { sessionId: string; correlationKey: string }) => void;
}

export interface SlackPostApiRequest {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown;
}

export interface SlackCreatedMessageResponse {
  ts: string;
  thread_ts: string;
}

function buildCreatedMessageResponse(input: {
  responseTs: string;
  responseThreadTs?: string;
}): SlackCreatedMessageResponse {
  return {
    ts: input.responseTs,
    thread_ts: input.responseThreadTs ?? input.responseTs,
  };
}

export interface SlackPostMessageRequest {
  args: unknown;
  stdin: unknown;
  sessionId?: string;
  cwd?: string;
}

interface ParsedArgs {
  channel: string;
  threadTs?: string;
  blocksFile?: string;
}

function result(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function allowedBlocksFileRoots(): string[] {
  const roots = new Set<string>();
  for (const root of BLOCKS_FILE_ALLOWED_ROOTS) {
    roots.add(resolve(root));
    const realRoot = realpathOrNull(root);
    if (realRoot) roots.add(realRoot);
  }
  return [...roots];
}

function isAllowedBlocksFilePath(path: string): boolean {
  const normalized = resolve(path);
  return allowedBlocksFileRoots().some((root) => isPathWithin(root, normalized));
}

function resolveBlocksFilePath(blocksFile: string, cwd?: string): string | { error: string } {
  if (!cwd && !blocksFile.startsWith("/")) {
    return { error: "cwd is required when using relative --blocks-file paths" };
  }

  const candidatePath = blocksFile.startsWith("/")
    ? resolve(blocksFile)
    : resolve(resolve("/", cwd ?? "/"), blocksFile);
  if (!isAllowedBlocksFilePath(candidatePath)) {
    return { error: "--blocks-file must be under /tmp or /workspace" };
  }

  const realPath = realpathOrNull(candidatePath);
  if (!realPath) {
    return {
      error: `failed to read --blocks-file ${blocksFile}: path does not exist`,
    };
  }

  if (!isAllowedBlocksFilePath(realPath)) {
    return { error: "--blocks-file must be under /tmp or /workspace" };
  }

  return realPath;
}

function hasUsableThorSession(sessionId: string): boolean {
  const anchorId = resolveSessionAnchorId(sessionId);
  if (!anchorId) return false;

  const sessionAnchor = resolveAlias({ aliasType: "opencode.session", aliasValue: sessionId });
  return sessionAnchor
    ? currentSessionForAnchor(anchorId) === sessionId
    : currentSessionForAnchor(anchorId) !== undefined;
}

function stripCodeSegments(text: string): string {
  const lines = text.split(/\r?\n/);
  const blockCodeLines = new Set<number>();
  const tokens = markdownParser.parse(text, {});
  for (const token of tokens) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      const [start, end] = token.map;
      for (let i = start; i < end; i++) blockCodeLines.add(i);
    }
  }
  return lines
    .map((line, index) => {
      if (blockCodeLines.has(index)) return "";
      return line.replace(/`+[^`\n]*`+/g, "");
    })
    .join("\n");
}

function containsMarkdownTableSeparator(text: string): boolean {
  const lines = stripCodeSegments(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!MARKDOWN_TABLE_SEPARATOR_LINE.test(lines[i] ?? "")) continue;
    const previous = lines[i - 1]?.trim() ?? "";
    if (previous.includes("|")) return true;
  }
  return false;
}

function containsCommonMarkDoubleStar(text: string): boolean {
  return COMMONMARK_DOUBLE_STAR.test(stripCodeSegments(text));
}

function containsLiteralBackslashN(text: string): boolean {
  return LITERAL_BACKSLASH_N.test(stripCodeSegments(text));
}

export function parseSlackPostMessageArgs(args: unknown): ParsedArgs | { error: string } {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return { error: "args must be an array of strings" };
  }

  let channel: string | undefined;
  let threadTs: string | undefined;
  let blocksFile: string | undefined;

  const requireValue = (flag: string, value: string | undefined): string | { error: string } => {
    if (value === undefined || value.length === 0) return { error: `${flag} requires a value` };
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--channel") {
      const value = requireValue("--channel", args[++i]);
      if (typeof value !== "string") return value;
      channel = value;
    } else if (arg.startsWith("--channel=")) {
      const value = requireValue("--channel", arg.slice("--channel=".length));
      if (typeof value !== "string") return value;
      channel = value;
    } else if (arg === "--thread-ts") {
      const value = requireValue("--thread-ts", args[++i]);
      if (typeof value !== "string") return value;
      threadTs = value;
    } else if (arg.startsWith("--thread-ts=")) {
      const value = requireValue("--thread-ts", arg.slice("--thread-ts=".length));
      if (typeof value !== "string") return value;
      threadTs = value;
    } else if (arg === "--blocks-file") {
      const value = requireValue("--blocks-file", args[++i]);
      if (typeof value !== "string") return value;
      blocksFile = value;
    } else if (arg.startsWith("--blocks-file=")) {
      const value = requireValue("--blocks-file", arg.slice("--blocks-file=".length));
      if (typeof value !== "string") return value;
      blocksFile = value;
    } else {
      return { error: `unsupported argument: ${arg}` };
    }
  }

  if (!channel) return { error: "--channel is required" };
  if (!SUPPORTED_SLACK_CHANNEL_ID.test(channel)) {
    return { error: "--channel must be a Slack channel or private group ID starting with C or G" };
  }

  return {
    channel,
    ...(threadTs ? { threadTs } : {}),
    ...(blocksFile ? { blocksFile } : {}),
  };
}

export async function handleSlackPostMessage(
  request: SlackPostMessageRequest,
  deps: SlackPostMessageDeps = {},
): Promise<ExecResult> {
  const started = Date.now();
  const sessionId = request.sessionId;
  if (!sessionId) {
    return result("missing x-thor-session-id; slack-post-message requires a Thor session\n");
  }
  if (!hasUsableThorSession(sessionId)) {
    return result(`invalid x-thor-session-id; no live Thor session binding for ${sessionId}\n`);
  }

  const parsed = parseSlackPostMessageArgs(request.args);
  if ("error" in parsed) return result(`${parsed.error}\n`);

  if (typeof request.stdin !== "string") return result("stdin body is required\n");
  const text = request.stdin;
  if (text.trim().length === 0) return result("mrkdwn stdin must not be empty\n");
  if (containsMarkdownTableSeparator(text)) {
    return result(
      `mrkdwn stdin must not include markdown table separators; use --blocks-file with Slack blocks/table output instead. ${SLACK_MRKDWN_STEERING}\n`,
    );
  }
  if (containsCommonMarkDoubleStar(text)) {
    return result(
      `mrkdwn stdin must not include CommonMark double-star emphasis. ${SLACK_MRKDWN_STEERING}\n`,
    );
  }
  if (containsLiteralBackslashN(text)) {
    return result(
      "mrkdwn stdin must not contain literal `\\n` escape sequences; pipe a heredoc or printf so newlines are real newlines.\n",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MRKDWN_BYTES) {
    return result(`mrkdwn stdin exceeds ${MAX_MRKDWN_BYTES} bytes\n`);
  }

  if (!deps.env?.SLACK_BOT_TOKEN) return result("SLACK_BOT_TOKEN is not set\n");

  const payload: Record<string, unknown> = {
    channel: parsed.channel,
    text,
    mrkdwn: true,
    ...(parsed.threadTs ? { thread_ts: parsed.threadTs } : {}),
  };
  if (parsed.blocksFile) {
    const blocksPath = resolveBlocksFilePath(parsed.blocksFile, request.cwd);
    if (typeof blocksPath !== "string") return result(`${blocksPath.error}\n`);

    let blocksStat;
    try {
      blocksStat = statSync(blocksPath);
    } catch (err) {
      return result(
        `failed to read --blocks-file ${parsed.blocksFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (!blocksStat.isFile()) {
      return result("--blocks-file must be a regular file\n");
    }
    if (blocksStat.size > MAX_BLOCKS_FILE_BYTES) {
      return result(`blocks file exceeds ${MAX_BLOCKS_FILE_BYTES} bytes\n`);
    }

    let blocksRaw: string;
    try {
      blocksRaw = readFileSync(blocksPath, "utf8");
    } catch (err) {
      return result(
        `failed to read --blocks-file ${parsed.blocksFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (Buffer.byteLength(blocksRaw, "utf8") > MAX_BLOCKS_FILE_BYTES) {
      return result(`blocks file exceeds ${MAX_BLOCKS_FILE_BYTES} bytes\n`);
    }
    let blocks: unknown;
    try {
      blocks = JSON.parse(blocksRaw);
    } catch (err) {
      return result(
        `invalid JSON in --blocks-file ${parsed.blocksFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (!Array.isArray(blocks)) {
      return result("--blocks-file must contain a top-level JSON array\n");
    }
    payload.blocks = blocks;
  }

  const slackResponse = await postSlackMessageApi(
    {
      channel: parsed.channel,
      text,
      ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}),
      ...(payload.blocks ? { blocks: payload.blocks } : {}),
    },
    { client: deps.client, env: deps.env },
  );
  if ("error" in slackResponse) return result(`Slack post failed: ${slackResponse.error}\n`);

  const correlationKey = buildSlackCorrelationKey(parsed.channel, slackResponse.thread_ts);
  const appendAlias = deps.appendAlias ?? appendCorrelationAlias;
  try {
    appendAlias(sessionId, correlationKey);
  } catch (err) {
    deps.logAliasError?.(err instanceof Error ? err : new Error(String(err)), {
      sessionId,
      correlationKey,
    });
  }

  void started;
  return { stdout: `${JSON.stringify(slackResponse)}\n`, stderr: "", exitCode: 0 };
}

export async function postSlackMessageApi(
  request: SlackPostApiRequest,
  deps: Pick<SlackPostMessageDeps, "client" | "env"> = {},
): Promise<SlackCreatedMessageResponse | { error: string }> {
  let client = deps.client;
  if (!client) {
    if (!deps.env?.SLACK_BOT_TOKEN) return { error: "SLACK_BOT_TOKEN is not set" };
    client = new WebClient(deps.env.SLACK_BOT_TOKEN, {
      ...(deps.env.SLACK_API_BASE_URL ? { slackApiUrl: deps.env.SLACK_API_BASE_URL } : {}),
    });
  }

  try {
    const result = await client.chat.postMessage({
      channel: request.channel,
      text: request.text,
      mrkdwn: true,
      ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
      ...(request.blocks ? { blocks: request.blocks as KnownBlock[] } : {}),
    });
    if (typeof result.ts !== "string" || result.ts.length === 0) {
      return { error: "Slack API response missing ts" };
    }
    const responseThreadTs = result.message?.thread_ts;
    return buildCreatedMessageResponse({
      responseTs: result.ts,
      ...(responseThreadTs ? { responseThreadTs } : {}),
    });
  } catch (err) {
    const slackError =
      err && typeof err === "object" && "data" in err
        ? ((err as { data?: { error?: unknown } }).data?.error ?? undefined)
        : undefined;
    const message =
      typeof slackError === "string"
        ? slackError
        : err instanceof Error
          ? err.message
          : String(err);
    return { error: `Slack API error: ${message}` };
  }
}
