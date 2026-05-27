/**
 * Slack external file upload helper.
 *
 * Talks directly to slack.com/api endpoints via curl so the mitmproxy egress
 * (HTTPS_PROXY + CURL_CA_BUNDLE in the opencode container) injects
 * authentication and trusts the proxy CA. Do not pass a Slack token.
 *
 * Usage: node slack-upload.mjs [options] <file>
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const USAGE = `Usage:
  slack-upload [options] <file>

Upload a file to Slack using Slack's external upload flow.
Authentication is injected by mitmproxy; do not pass a token manually.

Options:
  --channel <id>     Share the file in channel ID C...
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
  let file = "";
  let channel = "";
  let threadTs = "";
  let title = "";
  let comment = "";

  const takeValue = (flag: string, queue: string[]): string => {
    const value = queue.shift();
    if (value === undefined) die(`missing value for ${flag}`);
    return value;
  };

  const queue = [...argv];
  while (queue.length > 0) {
    const arg = queue.shift()!;
    switch (arg) {
      case "--channel":
        channel = takeValue("--channel", queue);
        break;
      case "--thread-ts":
        threadTs = takeValue("--thread-ts", queue);
        break;
      case "--title":
        title = takeValue("--title", queue);
        break;
      case "--comment":
        comment = takeValue("--comment", queue);
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      case "--": {
        if (queue.length === 0) break;
        if (file) die("unexpected extra arguments");
        if (queue.length > 1) die("unexpected extra arguments");
        file = queue.shift()!;
        break;
      }
      default:
        if (arg.startsWith("-")) die(`unknown option: ${arg}`);
        if (file) die("only one file path is supported");
        file = arg;
    }
  }

  return { file, channel, threadTs, title, comment };
}

const GetUploadUrlSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  upload_url: z.string().optional(),
  file_id: z.string().optional(),
});

const SlackFileSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    permalink: z.string().optional(),
    permalink_public: z.string().optional(),
  })
  .passthrough();

const CompleteUploadSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  files: z.array(SlackFileSchema).optional(),
});

async function curl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
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

type NormalizedFile = {
  id: string;
  title?: string;
  name?: string;
  permalink?: string;
  permalink_public?: string;
};

function normalizeFile(file: z.infer<typeof SlackFileSchema>): NormalizedFile | undefined {
  if (typeof file.id !== "string" || file.id.length === 0) return undefined;
  const out: NormalizedFile = { id: file.id };
  for (const key of ["title", "name", "permalink", "permalink_public"] as const) {
    const value = file[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

const { file, channel, threadTs, title: titleArg, comment } = parseArgs(process.argv.slice(2));

if (!file) die("file path is required");

const fileStat = await stat(file).catch(() => null);
if (!fileStat || !fileStat.isFile()) die(`file not found: ${file}`);

if (threadTs && !channel) die("--thread-ts requires --channel");
if (comment && !channel) die("--comment requires --channel");

const size = fileStat.size;
const name = basename(file);
const title = titleArg || name;

const getUploadRaw = await curl([
  "-sS",
  "-X",
  "POST",
  "https://slack.com/api/files.getUploadURLExternal",
  "-H",
  "content-type: application/x-www-form-urlencoded",
  "--data-urlencode",
  `filename=${name}`,
  "--data-urlencode",
  `length=${size}`,
]);

const getUpload = parseJson("files.getUploadURLExternal", GetUploadUrlSchema, getUploadRaw);
if (!getUpload.ok) die(getUpload.error || "files.getUploadURLExternal failed");
if (!getUpload.upload_url || !getUpload.file_id) {
  die("Slack response is missing upload_url or file_id");
}

const uploadUrl = getUpload.upload_url;
const fileId = getUpload.file_id;

const tmpDir = await mkdtemp(join(tmpdir(), "slack-upload-"));
const bodyPath = join(tmpDir, "body");
try {
  const uploadStatus = (
    await curl([
      "-sS",
      "-o",
      bodyPath,
      "-w",
      "%{http_code}",
      "-X",
      "POST",
      uploadUrl,
      "-H",
      "content-type: application/octet-stream",
      "--data-binary",
      `@${file}`,
    ])
  ).trim();
  if (uploadStatus !== "200") {
    const body = await readFile(bodyPath, "utf8").catch(() => "");
    die(`raw upload failed with HTTP ${uploadStatus}: ${body}`);
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

const filesArg = JSON.stringify([{ id: fileId, title }]);
const completeArgs = [
  "-sS",
  "-X",
  "POST",
  "https://slack.com/api/files.completeUploadExternal",
  "-H",
  "content-type: application/x-www-form-urlencoded",
  "--data-urlencode",
  `files=${filesArg}`,
];
if (channel) completeArgs.push("--data-urlencode", `channel_id=${channel}`);
if (threadTs) completeArgs.push("--data-urlencode", `thread_ts=${threadTs}`);
if (comment) completeArgs.push("--data-urlencode", `initial_comment=${comment}`);

const completeRaw = await curl(completeArgs);
const complete = parseJson("files.completeUploadExternal", CompleteUploadSchema, completeRaw);
if (!complete.ok) die(complete.error || "files.completeUploadExternal failed");

let normalized: NormalizedFile[] = (complete.files ?? [])
  .map(normalizeFile)
  .filter((file): file is NormalizedFile => file !== undefined);
if (normalized.length === 0) normalized = [{ id: fileId, title }];

const output: Record<string, unknown> = {
  ok: true,
  file_id: normalized[0].id,
  file: normalized[0],
  files: normalized,
};
if (channel) output.channel = channel;
if (threadTs) output.thread_ts = threadTs;

process.stdout.write(`${JSON.stringify(output)}\n`);
