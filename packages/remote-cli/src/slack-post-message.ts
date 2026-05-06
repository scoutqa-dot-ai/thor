import {
  appendCorrelationAlias,
  currentSessionForAnchor,
  isPathWithin,
  resolveAlias,
  type ExecResult,
} from "@thor/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const MAX_MRKDWN_BYTES = 40 * 1024;
const MAX_BLOCKS_FILE_BYTES = 128 * 1024;
const SLACK_TS_RE = /^\d{10,}\.\d{6}$/;

export interface SlackPostMessageDeps {
  fetch?: typeof fetch;
  env?: { SLACK_BOT_TOKEN?: string };
  appendAlias?: typeof appendCorrelationAlias;
  logAliasError?: (error: Error, meta: { sessionId: string; correlationKey: string }) => void;
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

function hasUsableThorSession(sessionId: string): boolean {
  const sessionAnchor = resolveAlias({ aliasType: "opencode.session", aliasValue: sessionId });
  if (!sessionAnchor) return false;
  return currentSessionForAnchor(sessionAnchor) === sessionId;
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
  if (threadTs && !SLACK_TS_RE.test(threadTs)) {
    return { error: "--thread-ts must be a Slack timestamp like 1234567890.123456" };
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
  if (Buffer.byteLength(text, "utf8") > MAX_MRKDWN_BYTES) {
    return result(`mrkdwn stdin exceeds ${MAX_MRKDWN_BYTES} bytes\n`);
  }

  if (!deps.env?.SLACK_BOT_TOKEN) return result("SLACK_BOT_TOKEN is not set\n");

  const fetchImpl = deps.fetch ?? fetch;
  const payload: Record<string, unknown> = {
    channel: parsed.channel,
    text,
    mrkdwn: true,
    ...(parsed.threadTs ? { thread_ts: parsed.threadTs } : {}),
  };
  if (parsed.blocksFile) {
    if (!request.cwd) return result("cwd is required when using --blocks-file\n");
    const cwdPath = resolve("/", request.cwd);
    const blocksPath = resolve(cwdPath, parsed.blocksFile);
    if (!isPathWithin(cwdPath, blocksPath)) {
      return result("--blocks-file must stay within the current working directory\n");
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

  let slackJson: unknown;
  try {
    const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
      method: "POST",
        headers: {
          Authorization: `Bearer ${deps.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
        },
      body: JSON.stringify(payload),
    });
    slackJson = await response.json();
  } catch (err) {
    return result(`Slack post failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  if (!slackJson || typeof slackJson !== "object" || (slackJson as { ok?: unknown }).ok !== true) {
    const error =
      slackJson && typeof slackJson === "object" && typeof (slackJson as { error?: unknown }).error === "string"
        ? (slackJson as { error: string }).error
        : "unknown_error";
    return result(`Slack API error: ${error}\n`);
  }

  const responseTs = (slackJson as { ts?: unknown }).ts;
  if (typeof responseTs !== "string" || responseTs.length === 0) {
    return result("Slack API response missing ts\n");
  }

  const aliasTs = parsed.threadTs ?? responseTs;
  const correlationKey = `slack:thread:${aliasTs}`;
  const appendAlias = deps.appendAlias ?? appendCorrelationAlias;
  const aliasResult = appendAlias(sessionId, correlationKey);
  if (!aliasResult.ok) {
    deps.logAliasError?.(aliasResult.error, { sessionId, correlationKey });
  }

  void started;
  return { stdout: `${JSON.stringify(slackJson)}\n`, stderr: "", exitCode: 0 };
}
