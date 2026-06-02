/**
 * Slack external file upload helper.
 *
 * Talks directly to slack.com/api endpoints via Node fetch so the mitmproxy
 * egress (HTTPS_PROXY + NODE_EXTRA_CA_CERTS in the opencode container) injects
 * authentication and trusts the proxy CA. Do not pass a Slack token.
 *
 * Usage: node slack-upload.mjs [options] <file>
 */

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { SUPPORTED_SLACK_CHANNEL_ID } from "@thor/common/slack";
import { z } from "zod";

const USAGE = `Usage:
  slack-upload [options] <file>

Upload a file to Slack using Slack's external upload flow.
Authentication is injected by mitmproxy; do not pass a token manually.

Options:
  --channel <id>     Share the file in channel/private group ID C... or G...
  --thread-ts <ts>   Reply in an existing thread; requires --channel
  --title <title>    Slack file title; defaults to the file basename
  --comment <text>   Initial comment when sharing; requires --channel
  -h, --help         Show this help

Examples:
  slack-upload ./report.txt --channel C123
  slack-upload ./report.txt --channel C123 --thread-ts 1710000000.001 \\
    --comment "Attached the report."
`;

function die(message: string): never {
  process.stderr.write(`slack-upload: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  file: string;
  channel: string;
  threadTs: string;
  title: string;
  comment: string;
} {
  let parsed: {
    values: {
      channel?: string;
      "thread-ts"?: string;
      title?: string;
      comment?: string;
      help?: boolean;
    };
    positionals: string[];
  };

  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        channel: { type: "string" },
        "thread-ts": { type: "string" },
        title: { type: "string" },
        comment: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    die(err instanceof Error ? err.message : "could not parse arguments");
  }

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (parsed.positionals.length > 1) die("unexpected extra arguments");
  const file = parsed.positionals[0] ?? "";

  return {
    file,
    channel: parsed.values.channel ?? "",
    threadTs: parsed.values["thread-ts"] ?? "",
    title: parsed.values.title ?? "",
    comment: parsed.values.comment ?? "",
  };
}

const GetUploadUrlSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  upload_url: z.string().optional(),
  file_id: z.string().optional(),
});

const SlackOkSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

async function fetchText(label: string, url: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  const body = await response.text();
  if (!response.ok) die(`${label} failed with HTTP ${response.status}: ${body}`);
  return body;
}

async function slackApiPost(method: string, params: Record<string, string>): Promise<string> {
  return fetchText(method, `https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function uploadFile(uploadUrl: string, file: string): Promise<void> {
  const body = await openAsBlob(file, { type: "application/octet-stream" });
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    redirect: "manual",
  });
  const responseBody = await response.text();
  if (response.status !== 200) {
    die(`raw upload failed with HTTP ${response.status}: ${responseBody}`);
  }
}

function parseJson<T>(label: string, schema: z.ZodType<T>, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`could not parse ${label} response`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) die(`could not parse ${label} response`);
  return result.data;
}

const { file, channel, threadTs, title: titleArg, comment } = parseArgs(process.argv.slice(2));

if (!file) die("file path is required");
if (channel && !SUPPORTED_SLACK_CHANNEL_ID.test(channel)) {
  die("--channel must be a Slack channel or private group ID starting with C or G");
}

const fileStat = await stat(file).catch(() => null);
if (!fileStat || !fileStat.isFile()) die(`file not found: ${file}`);

if (threadTs && !channel) die("--thread-ts requires --channel");
if (comment && !channel) die("--comment requires --channel");

const size = fileStat.size;
const name = basename(file);
const title = titleArg || name;

const getUploadRaw = await slackApiPost("files.getUploadURLExternal", {
  filename: name,
  length: `${size}`,
});

const getUpload = parseJson("files.getUploadURLExternal", GetUploadUrlSchema, getUploadRaw);
if (!getUpload.ok) die(getUpload.error || "files.getUploadURLExternal failed");
if (!getUpload.upload_url || !getUpload.file_id) {
  die("Slack response is missing upload_url or file_id");
}

const uploadUrl = getUpload.upload_url;
const fileId = getUpload.file_id;

await uploadFile(uploadUrl, file);

const filesArg = JSON.stringify([{ id: fileId, title }]);
const completeParams: Record<string, string> = { files: filesArg };
if (channel) completeParams.channel_id = channel;
if (threadTs) completeParams.thread_ts = threadTs;
if (comment) completeParams.initial_comment = comment;

const completeRaw = await slackApiPost("files.completeUploadExternal", completeParams);
const complete = parseJson("files.completeUploadExternal", SlackOkSchema, completeRaw);
if (!complete.ok) die(complete.error || "files.completeUploadExternal failed");

process.stdout.write(completeRaw.endsWith("\n") ? completeRaw : `${completeRaw}\n`);
