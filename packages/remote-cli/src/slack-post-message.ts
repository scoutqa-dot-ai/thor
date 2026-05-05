import { appendCorrelationAlias, type ExecResult } from "@thor/common";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const MAX_MRKDWN_BYTES = 40 * 1024;
const SLACK_TS_RE = /^\d{10,}\.\d{6}$/;

export interface SlackPostMessageDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  appendAlias?: typeof appendCorrelationAlias;
  logAliasError?: (error: Error, meta: { sessionId: string; correlationKey: string }) => void;
}

export interface SlackPostMessageRequest {
  args: unknown;
  stdin: unknown;
  sessionId?: string;
}

interface ParsedArgs {
  channel: string;
  threadTs?: string;
  format: "mrkdwn";
}

function result(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

export function parseSlackPostMessageArgs(args: unknown): ParsedArgs | { error: string } {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return { error: "args must be an array of strings" };
  }

  let channel: string | undefined;
  let threadTs: string | undefined;
  let format = "mrkdwn";

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
    } else if (arg === "--format") {
      const value = requireValue("--format", args[++i]);
      if (typeof value !== "string") return value;
      format = value;
    } else if (arg.startsWith("--format=")) {
      const value = requireValue("--format", arg.slice("--format=".length));
      if (typeof value !== "string") return value;
      format = value;
    } else {
      return { error: `unsupported argument: ${arg}` };
    }
  }

  if (!channel) return { error: "--channel is required" };
  if (threadTs && !SLACK_TS_RE.test(threadTs)) {
    return { error: "--thread-ts must be a Slack timestamp like 1234567890.123456" };
  }
  if (format === "blocks") {
    return { error: "--format blocks is not yet supported; use mrkdwn text on stdin" };
  }
  if (format !== "mrkdwn") return { error: "--format must be mrkdwn or blocks" };

  return { channel, ...(threadTs ? { threadTs } : {}), format: "mrkdwn" };
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

  const parsed = parseSlackPostMessageArgs(request.args);
  if ("error" in parsed) return result(`${parsed.error}\n`);

  if (typeof request.stdin !== "string") return result("stdin body is required\n");
  const text = request.stdin;
  if (text.trim().length === 0) return result("mrkdwn stdin must not be empty\n");
  if (Buffer.byteLength(text, "utf8") > MAX_MRKDWN_BYTES) {
    return result(`mrkdwn stdin exceeds ${MAX_MRKDWN_BYTES} bytes\n`);
  }

  const token = deps.env?.SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
  if (!token) return result("SLACK_BOT_TOKEN is not set\n");

  const fetchImpl = deps.fetch ?? fetch;
  const payload: Record<string, unknown> = {
    channel: parsed.channel,
    text,
    mrkdwn: true,
    ...(parsed.threadTs ? { thread_ts: parsed.threadTs } : {}),
  };

  let slackJson: unknown;
  try {
    const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
