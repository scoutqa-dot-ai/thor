import {
  appendCorrelationAlias,
  buildSlackCorrelationKey,
  currentSessionForAnchor,
  isPathWithin,
  realpathOrNull,
  resolveAlias,
  resolveSessionAnchorId,
  type ExecResult,
} from "@thor/common";
import MarkdownIt from "markdown-it";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const markdownParser = new MarkdownIt("commonmark");

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_POST_MESSAGE_PATH = "/chat.postMessage";
const MAX_MRKDWN_BYTES = 40 * 1024;
const MAX_BLOCKS_FILE_BYTES = 128 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const FILE_ALLOWED_ROOTS = [
  "/tmp",
  "/workspace/memory",
  "/workspace/config",
  "/workspace/repos",
  "/workspace/worklog",
  "/workspace/cron",
  "/workspace/runs",
  "/workspace/worktrees",
] as const;
const FILE_ALLOWED_ROOTS_DESCRIPTION = FILE_ALLOWED_ROOTS.join(", ");
const MARKDOWN_TABLE_SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const COMMONMARK_DOUBLE_STAR = /\*\*/;
const LITERAL_BACKSLASH_N = /\\n/;
const SLACK_MRKDWN_STEERING =
  "Use Slack mrkdwn instead: `*bold*` (not `**bold**`), `_italic_`, bullets, and code spans/fences as needed.";

export interface SlackPostMessageDeps {
  fetch?: typeof fetch;
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

function slackApiUrl(path: string, apiBaseUrl?: string): string {
  const base = (apiBaseUrl && apiBaseUrl.trim()) || DEFAULT_SLACK_API_BASE_URL;
  return `${base.replace(/\/$/, "")}${path}`;
}

function slackPostMessageUrl(apiBaseUrl?: string): string {
  return slackApiUrl(SLACK_POST_MESSAGE_PATH, apiBaseUrl);
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
  files: string[];
}

function result(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function allowedFileRoots(): string[] {
  const roots = new Set<string>();
  for (const root of FILE_ALLOWED_ROOTS) {
    roots.add(resolve(root));
    const realRoot = realpathOrNull(root);
    if (realRoot) roots.add(realRoot);
  }
  return [...roots];
}

function isAllowedFilePath(path: string): boolean {
  const normalized = resolve(path);
  return allowedFileRoots().some((root) => isPathWithin(root, normalized));
}

/**
 * Resolve a user-supplied path (from `--blocks-file` or `--file`) to a real path
 * confined to the exact filesystem roots shared with the agent container.
 * `flag` names the originating option for error messages. Rejects server-only
 * workspace paths, absolute escapes, `..` traversal, and symlinks that resolve
 * outside the allowed roots, so the agent cannot make remote-cli read arbitrary
 * files off its own disk.
 */
function resolveAllowedFilePath(
  rawPath: string,
  cwd: string | undefined,
  flag: string,
): string | { error: string } {
  if (!cwd && !rawPath.startsWith("/")) {
    return { error: `cwd is required when using relative ${flag} paths` };
  }

  const candidatePath = rawPath.startsWith("/")
    ? resolve(rawPath)
    : resolve(resolve("/", cwd ?? "/"), rawPath);
  if (!isAllowedFilePath(candidatePath)) {
    return { error: `${flag} must be under one of: ${FILE_ALLOWED_ROOTS_DESCRIPTION}` };
  }

  const realPath = realpathOrNull(candidatePath);
  if (!realPath) {
    return { error: `failed to read ${flag} ${rawPath}: path does not exist` };
  }

  if (!isAllowedFilePath(realPath)) {
    return { error: `${flag} must be under one of: ${FILE_ALLOWED_ROOTS_DESCRIPTION}` };
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
  const files: string[] = [];

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
    } else if (arg === "--file") {
      const value = requireValue("--file", args[++i]);
      if (typeof value !== "string") return value;
      files.push(value);
    } else if (arg.startsWith("--file=")) {
      const value = requireValue("--file", arg.slice("--file=".length));
      if (typeof value !== "string") return value;
      files.push(value);
    } else {
      return { error: `unsupported argument: ${arg}` };
    }
  }

  if (!channel) return { error: "--channel is required" };

  return {
    channel,
    files,
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
    const blocksPath = resolveAllowedFilePath(parsed.blocksFile, request.cwd, "--blocks-file");
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

  // Attachments are uploaded into the thread first, each with the stdin message
  // as its comment so it remains useful even if a later upload or message post
  // fails. Successfully shared files are intentionally left in the thread.
  for (const [index, rawPath] of parsed.files.entries()) {
    const filePath = resolveAllowedFilePath(rawPath, request.cwd, "--file");
    if (typeof filePath !== "string") return result(`${filePath.error}\n`);

    let fileStat;
    try {
      fileStat = statSync(filePath);
    } catch (err) {
      return result(
        `failed to read --file ${rawPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (!fileStat.isFile()) return result(`--file ${rawPath} must be a regular file\n`);
    if (fileStat.size > MAX_ATTACHMENT_BYTES) {
      return result(`--file ${rawPath} exceeds ${MAX_ATTACHMENT_BYTES} bytes\n`);
    }

    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch (err) {
      return result(
        `failed to read --file ${rawPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const label = `File ${index + 1}`;
    const upload = await uploadSlackFileApi(
      {
        channel: parsed.channel,
        ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}),
        filename: basename(filePath),
        title: basename(filePath),
        content,
        initialComment: text,
      },
      { fetch: deps.fetch, env: deps.env },
    );
    if ("error" in upload) {
      return result(`failed to upload ${label} (${basename(filePath)}): ${upload.error}\n`);
    }
  }

  const slackResponse = await postSlackMessageApi(
    {
      channel: parsed.channel,
      text,
      ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}),
      ...(payload.blocks ? { blocks: payload.blocks } : {}),
    },
    { fetch: deps.fetch, env: deps.env },
  );
  if ("error" in slackResponse) return result(`Slack post failed: ${slackResponse.error}\n`);

  const responseTs = slackResponse.ts;
  const responseChannel = slackResponse.channel;

  const aliasTs = parsed.threadTs ?? responseTs;
  if (responseChannel) {
    const correlationKey = buildSlackCorrelationKey(responseChannel, aliasTs);
    const appendAlias = deps.appendAlias ?? appendCorrelationAlias;
    try {
      appendAlias(sessionId, correlationKey);
    } catch (err) {
      deps.logAliasError?.(err instanceof Error ? err : new Error(String(err)), {
        sessionId,
        correlationKey,
      });
    }
  }

  void started;
  return { stdout: '{"ok":true}\n', stderr: "", exitCode: 0 };
}

export async function postSlackMessageApi(
  request: SlackPostApiRequest,
  deps: Pick<SlackPostMessageDeps, "fetch" | "env"> = {},
): Promise<{ ts: string; channel: string } | { error: string }> {
  if (!deps.env?.SLACK_BOT_TOKEN) return { error: "SLACK_BOT_TOKEN is not set" };

  const fetchImpl = deps.fetch ?? fetch;
  const payload: Record<string, unknown> = {
    channel: request.channel,
    text: request.text,
    mrkdwn: true,
    ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
    ...(request.blocks ? { blocks: request.blocks } : {}),
  };

  let slackJson: unknown;
  try {
    const response = await fetchImpl(slackPostMessageUrl(deps.env.SLACK_API_BASE_URL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    slackJson = await response.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  if (!slackJson || typeof slackJson !== "object" || (slackJson as { ok?: unknown }).ok !== true) {
    const error =
      slackJson &&
      typeof slackJson === "object" &&
      typeof (slackJson as { error?: unknown }).error === "string"
        ? (slackJson as { error: string }).error
        : "unknown_error";
    return { error: `Slack API error: ${error}` };
  }

  const responseTs = (slackJson as { ts?: unknown }).ts;
  const responseChannel = (slackJson as { channel?: unknown }).channel;
  if (typeof responseTs !== "string" || responseTs.length === 0) {
    return { error: "Slack API response missing ts" };
  }

  return {
    ts: responseTs,
    channel:
      typeof responseChannel === "string" && responseChannel.length > 0
        ? responseChannel
        : request.channel,
  };
}

async function slackApiForm(
  path: string,
  form: URLSearchParams,
  deps: Pick<SlackPostMessageDeps, "fetch" | "env">,
): Promise<{ ok: true; json: Record<string, unknown> } | { error: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const response = await fetchImpl(slackApiUrl(path, deps.env?.SLACK_API_BASE_URL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env?.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    });
    const json = (await response.json()) as unknown;
    if (!json || typeof json !== "object" || (json as { ok?: unknown }).ok !== true) {
      const error =
        json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
          ? (json as { error: string }).error
          : "unknown_error";
      return { error: `Slack API error: ${error}` };
    }
    return { ok: true, json: json as Record<string, unknown> };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Upload a file to Slack and share it into a channel/thread via the external
 * upload flow (getUploadURLExternal → raw POST → completeUploadExternal). The
 * returned `upload_url` is pre-signed, so step 2 uses it verbatim and carries
 * no Authorization header; only the first and third calls hit the Web API base.
 * Requires the bot's `files:write` scope. A successful completion is enough;
 * callers intentionally leave uploaded files in Slack and do not need a file
 * URL or file id.
 */
export async function uploadSlackFileApi(
  request: {
    channel: string;
    threadTs?: string;
    filename: string;
    title: string;
    content: string | Buffer;
    initialComment?: string;
  },
  deps: Pick<SlackPostMessageDeps, "fetch" | "env"> = {},
): Promise<{ ok: true } | { error: string }> {
  if (!deps.env?.SLACK_BOT_TOKEN) return { error: "SLACK_BOT_TOKEN is not set" };
  const fetchImpl = deps.fetch ?? fetch;

  const length = Buffer.byteLength(request.content, "utf8");
  const getUrl = await slackApiForm(
    "/files.getUploadURLExternal",
    new URLSearchParams({ filename: request.filename, length: String(length) }),
    deps,
  );
  if ("error" in getUrl) return getUrl;
  const uploadUrl = getUrl.json.upload_url;
  const fileId = getUrl.json.file_id;
  if (typeof uploadUrl !== "string" || typeof fileId !== "string") {
    return { error: "Slack files.getUploadURLExternal response missing upload_url or file_id" };
  }

  try {
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: request.content,
    });
    if (!uploadResponse.ok) {
      return { error: `Slack file upload failed with HTTP ${uploadResponse.status}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const completeForm = new URLSearchParams({
    files: JSON.stringify([{ id: fileId, title: request.title }]),
    channel_id: request.channel,
    ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
    ...(request.initialComment ? { initial_comment: request.initialComment } : {}),
  });
  const complete = await slackApiForm("/files.completeUploadExternal", completeForm, deps);
  if ("error" in complete) return complete;
  return { ok: true };
}
