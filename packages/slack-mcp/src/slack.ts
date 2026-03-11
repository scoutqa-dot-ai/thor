import { WebClient, type FilesInfoResponse } from "@slack/web-api";

export type SlackDeps = {
  client: WebClient;
  token?: string;
  fetchFn?: typeof fetch;
};

export type SlackAttachment = Record<string, unknown>;
export type SlackFile = Record<string, unknown>;
type SlackFileObject = NonNullable<FilesInfoResponse["file"]>;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/yaml",
  "application/x-yaml",
]);

const TEXT_FILE_TYPES = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "json",
  "js",
  "ts",
  "tsx",
  "jsx",
  "yaml",
  "yml",
  "log",
  "html",
  "css",
  "xml",
]);

export interface SlackFileMetadata {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
}

export type SlackFileReadResult =
  | {
      kind: "text";
      file: SlackFileMetadata;
      text: string;
      truncated: boolean;
      source: "inline" | "download";
    }
  | {
      kind: "image";
      file: SlackFileMetadata;
      mimeType: string;
      data: string;
    };

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  deps: SlackDeps,
): Promise<{ ts: string; channel: string }> {
  const result = await deps.client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return { ts: result.ts ?? "", channel: result.channel ?? channel };
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  type?: string;
  attachments?: SlackAttachment[];
  files?: SlackFile[];
}

export async function readThread(
  channel: string,
  threadTs: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

export async function getChannelHistory(
  channel: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.history({
    channel,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

export async function readSlackFile(
  fileId: string,
  maxBytes: number,
  deps: SlackDeps,
): Promise<SlackFileReadResult> {
  const result = await deps.client.files.info({ file: fileId });
  const file = result.file;

  if (!file) {
    throw new Error(`Slack file not found: ${fileId}`);
  }

  const metadata = toSlackFileMetadata(file);
  const inlineText = getInlineFileText(result, file);
  if (inlineText) {
    return {
      kind: "text",
      file: metadata,
      text: inlineText,
      truncated: Boolean(result.is_truncated || file.preview_is_truncated),
      source: "inline",
    };
  }

  const downloadUrl = file.url_private_download ?? file.url_private;
  if (!downloadUrl) {
    throw new Error(`Slack file is not downloadable: ${fileId}`);
  }

  const downloaded = await downloadSlackFile(downloadUrl, maxBytes, deps);
  if (isImageFile(file, downloaded.mimeType)) {
    return {
      kind: "image",
      file: metadata,
      mimeType: downloaded.mimeType,
      data: downloaded.bytes.toString("base64"),
    };
  }

  if (isTextLikeFile(file, downloaded.mimeType)) {
    return {
      kind: "text",
      file: metadata,
      text: downloaded.bytes.toString("utf8"),
      truncated: false,
      source: "download",
    };
  }

  throw new Error(
    `Unsupported Slack file type: ${file.mimetype ?? file.filetype ?? downloaded.mimeType}`,
  );
}

function getInlineFileText(result: FilesInfoResponse, file: SlackFileObject): string | undefined {
  return result.content ?? file.plain_text ?? file.preview_plain_text ?? file.preview;
}

function toSlackFileMetadata(file: SlackFileObject): SlackFileMetadata {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    pretty_type: file.pretty_type,
    size: file.size,
    permalink: file.permalink,
    url_private: file.url_private,
    url_private_download: file.url_private_download,
  };
}

function isImageFile(file: SlackFileObject, mimeType?: string): boolean {
  return (mimeType ?? file.mimetype ?? "").startsWith("image/");
}

function isTextLikeFile(file: SlackFileObject, mimeType?: string): boolean {
  const effectiveMimeType = mimeType ?? file.mimetype ?? "";
  if (effectiveMimeType.startsWith("text/") || TEXT_MIME_TYPES.has(effectiveMimeType)) {
    return true;
  }

  const filetype = (file.filetype ?? "").toLowerCase();
  return TEXT_FILE_TYPES.has(filetype);
}

async function downloadSlackFile(
  url: string,
  maxBytes: number,
  deps: SlackDeps,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!deps.token) {
    throw new Error("Slack bot token is required to download files");
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${deps.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new Error(`Slack file exceeds max_bytes (${contentLength} > ${maxBytes})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`Slack file exceeds max_bytes (${bytes.length} > ${maxBytes})`);
  }

  return {
    bytes,
    mimeType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}
