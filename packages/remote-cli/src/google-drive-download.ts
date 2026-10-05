import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES,
  GOOGLE_DRIVE_DOWNLOAD_MAX_DEPTH,
  GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES,
  GOOGLE_DRIVE_DOWNLOAD_MAX_NAME_BYTES,
  GOOGLE_DRIVE_DOWNLOAD_VERSION,
  GoogleDriveDownloadNameSchema,
  GoogleDriveDownloadSchema,
  GoogleDriveFileIdSchema,
  foldGoogleDriveDownloadName,
  type GoogleDriveDownload,
  type GoogleDriveDownloadEntry,
  type GoogleDriveFileId,
} from "@thor/common";
import type { GwsAccessToken } from "./gws-oauth.js";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const METADATA_MAX_BYTES = 1024 * 1024;
// Empty folders each need a page in addition to their parent's paginated listing.
// Bound even distinct empty continuation tokens without rejecting a valid 1000-directory tree.
const MAX_METADATA_PAGES = 2 * GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES;
const METADATA_FIELDS = "id,name,mimeType,size,trashed";
const EXPORT_FORMATS = new Map([
  ["application/vnd.google-apps.document", { mimeType: "text/plain", extension: ".txt" }],
  [
    "application/vnd.google-apps.spreadsheet",
    {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
    },
  ],
  [
    "application/vnd.google-apps.presentation",
    {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
    },
  ],
  ["application/vnd.google-apps.drawing", { mimeType: "application/pdf", extension: ".pdf" }],
]);
const MetadataSchema = z.object({
  id: GoogleDriveFileIdSchema,
  name: z.string().min(1).max(4096),
  mimeType: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
  size: z
    .string()
    .regex(/^\d{1,20}$/)
    .transform(Number)
    .refine(Number.isSafeInteger)
    .optional(),
  trashed: z.boolean().default(false),
});
type DriveMetadata = z.infer<typeof MetadataSchema>;
const ListingSchema = z.object({
  files: z.array(MetadataSchema).max(100),
  nextPageToken: z.string().min(1).max(4096).optional(),
  incompleteSearch: z.boolean().optional(),
});
type DownloadErrorCode = "provider" | "limit" | "unsupported" | "invalid";

/** Safe Google Drive download failures contain no response bodies, names, URLs or credentials. */
export class GoogleDriveDownloadError extends Error {
  /** Stable failure classification for callers and safe diagnostics. */
  readonly _tag = "GoogleDriveDownloadError" as const;
  /** The category is safe to expose; no raw provider error is retained. */
  readonly code: DownloadErrorCode;

  /** Construct an allowlisted error message rather than rendering an upstream exception. */
  constructor(code: DownloadErrorCode) {
    const messages: Record<DownloadErrorCode, string> = {
      provider:
        "Google Drive download failed while reading from Google; check access and try again. No files were returned.",
      limit:
        "Google Drive download exceeds transfer limits (50 MiB, 1000 entries, depth 32); request a smaller file or subfolder. No files were returned.",
      unsupported:
        "Google Drive download contains an unsupported native document or a shortcut root; request supported files or a smaller subfolder. No files were returned.",
      invalid:
        "Google Drive download received invalid metadata or an inconsistent tree; request a smaller file or subfolder. No files were returned.",
    };
    super(messages[code]);
    this.code = code;
  }
}
type DriveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GoogleDriveDownloadError };

/** Download success is atomic: callers never receive a partially acquired manifest. */
export type GoogleDriveDownloadResult = DriveResult<GoogleDriveDownload>;

/** Acquires a bounded tree using only the active requester's short-lived Google token. */
export interface IGoogleDriveDownloader {
  /** No broker filesystem output or caller-selected URL; expected failures are returned values. */
  download(
    fileId: GoogleDriveFileId,
    accessToken: GwsAccessToken,
  ): Promise<GoogleDriveDownloadResult>;
}

/** Owns Drive REST, pagination, portable names and binary buffering, separate from generic exec orchestration. */
export class GoogleDriveDownloader implements IGoogleDriveDownloader {
  /** Trusted fetch injection preserves fixed production endpoints and allows inert HTTP fixtures. */
  constructor(private readonly trustedFetch: typeof fetch = fetch) {}

  /** Returns every file and empty directory, or one safe error without a partial manifest. */
  async download(
    fileId: GoogleDriveFileId,
    accessToken: GwsAccessToken,
  ): Promise<GoogleDriveDownloadResult> {
    const rootUrl = new URL(`${DRIVE_FILES_URL}/${fileId}`);
    rootUrl.searchParams.set("fields", METADATA_FIELDS);
    rootUrl.searchParams.set("supportsAllDrives", "true");
    const rootBytes = await this.#requestBytes(rootUrl, accessToken, METADATA_MAX_BYTES);
    if (!rootBytes.ok) return rootBytes;
    const root = parseDriveJson(rootBytes.value, MetadataSchema);
    if (!root.ok) return root;
    if (root.value.id !== fileId) return failure("invalid");

    const entries: GoogleDriveDownloadEntry[] = [];
    const skipped: GoogleDriveDownload["skipped"] = [];
    const seenIds = new Set<GoogleDriveFileId>();
    let totalBytes = 0;
    let pages = 0;

    const visit = async (metadata: DriveMetadata, path: string[]): Promise<DriveResult<void>> => {
      if (
        path.length > GOOGLE_DRIVE_DOWNLOAD_MAX_DEPTH ||
        entries.length + skipped.length >= GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES
      )
        return failure("limit");
      if (seenIds.has(metadata.id) || metadata.trashed) return failure("invalid");
      seenIds.add(metadata.id);
      if (metadata.mimeType === SHORTCUT_MIME) {
        if (path.length === 1) return failure("unsupported");
        skipped.push({ fileId: metadata.id, name: path[path.length - 1], reason: "shortcut" });
        return { ok: true, value: undefined };
      }
      if (metadata.mimeType === FOLDER_MIME) {
        entries.push({ kind: "directory", path });
        const names = new Set<string>();
        const pageTokens = new Set<string>();
        let pageToken: string | undefined;
        do {
          if (++pages > MAX_METADATA_PAGES) return failure("limit");
          const listUrl = new URL(DRIVE_FILES_URL);
          listUrl.searchParams.set("q", `'${metadata.id}' in parents and trashed = false`);
          listUrl.searchParams.set(
            "fields",
            `nextPageToken,incompleteSearch,files(${METADATA_FIELDS})`,
          );
          listUrl.searchParams.set("pageSize", "100");
          listUrl.searchParams.set("supportsAllDrives", "true");
          listUrl.searchParams.set("includeItemsFromAllDrives", "true");
          if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
          const listBytes = await this.#requestBytes(listUrl, accessToken, METADATA_MAX_BYTES);
          if (!listBytes.ok) return listBytes;
          const listing = parseDriveJson(listBytes.value, ListingSchema);
          if (!listing.ok) return listing;
          if (listing.value.incompleteSearch) return failure("invalid");
          for (const child of listing.value.files) {
            const childName = reserveDriveName(child, names);
            const result = await visit(child, [...path, childName]);
            if (!result.ok) return result;
          }
          pageToken = listing.value.nextPageToken;
          if (pageToken) {
            if (pageTokens.has(pageToken)) return failure("invalid");
            pageTokens.add(pageToken);
          }
        } while (pageToken);
        return { ok: true, value: undefined };
      }
      const format = EXPORT_FORMATS.get(metadata.mimeType);
      if (!format && metadata.mimeType.startsWith("application/vnd.google-apps."))
        return failure("unsupported");
      const remainingBytes = GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES - totalBytes;
      if (!format && metadata.size !== undefined && metadata.size > remainingBytes)
        return failure("limit");
      const mediaUrl = new URL(`${DRIVE_FILES_URL}/${metadata.id}${format ? "/export" : ""}`);
      if (format) mediaUrl.searchParams.set("mimeType", format.mimeType);
      else {
        mediaUrl.searchParams.set("alt", "media");
        mediaUrl.searchParams.set("supportsAllDrives", "true");
      }
      const bytes = await this.#requestBytes(mediaUrl, accessToken, remainingBytes);
      if (!bytes.ok) return bytes;
      if (!format && metadata.size !== undefined && metadata.size !== bytes.value.length)
        return failure("invalid");
      totalBytes += bytes.value.length;
      entries.push({
        kind: "file",
        path,
        mimeType: format?.mimeType ?? metadata.mimeType,
        size: bytes.value.length,
        sha256: createHash("sha256").update(bytes.value).digest("hex"),
        dataBase64: bytes.value.toString("base64"),
      });
      return { ok: true, value: undefined };
    };

    const rootName = reserveDriveName(root.value, new Set());
    const acquired = await visit(root.value, [rootName]);
    if (!acquired.ok) return acquired;
    const manifest = GoogleDriveDownloadSchema.safeParse({
      version: GOOGLE_DRIVE_DOWNLOAD_VERSION,
      rootName,
      entries,
      skipped,
    });
    return manifest.success ? { ok: true, value: manifest.data } : failure("invalid");
  }

  async #requestBytes(
    url: URL,
    accessToken: GwsAccessToken,
    maxBytes: number,
  ): Promise<DriveResult<Buffer>> {
    const controller = new AbortController();
    // This is the token's final I/O boundary. Redirects must never carry it to another origin.
    let response: Response;
    try {
      response = await this.trustedFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        headers: { authorization: `Bearer ${accessToken.reveal()}` },
      });
    } catch {
      controller.abort();
      return failure("provider");
    }
    if (!response.ok || response.redirected) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      return failure("provider");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
    ) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      return failure("limit");
    }
    if (!response.body) return { ok: true, value: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return failure("limit");
        }
        if (chunk.value.byteLength > 0) chunks.push(Buffer.from(chunk.value));
      }
      return { ok: true, value: Buffer.concat(chunks, size) };
    } catch {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return failure("provider");
    } finally {
      reader.releaseLock();
    }
  }
}

function failure(code: DownloadErrorCode): {
  readonly ok: false;
  readonly error: GoogleDriveDownloadError;
} {
  return { ok: false, error: new GoogleDriveDownloadError(code) };
}

function parseDriveJson<T>(bytes: Buffer, schema: z.ZodType<T>): DriveResult<T> {
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? { ok: true, value: parsed.data } : failure("invalid");
  } catch {
    return failure("invalid");
  }
}

function truncateDriveName(name: string, maxBytes: number): string {
  let result = "";
  for (const character of name) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function reserveDriveName(metadata: DriveMetadata, usedNames: Set<string>): string {
  const extension = EXPORT_FORMATS.get(metadata.mimeType)?.extension ?? "";
  let stem = metadata.name
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cs}]/gu, "_")
    .replace(/[. ]+$/g, "");
  if (!stem) stem = "download";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  // Reserve the export extension before collision detection, including ordinary files with that suffix.
  if (extension && stem.toLowerCase().endsWith(extension))
    stem = stem.slice(0, -extension.length) || "download";
  for (let collision = 1; ; collision++) {
    const suffix = `${collision === 1 ? "" : ` (${collision})`}${extension}`;
    const candidate =
      truncateDriveName(
        stem,
        GOOGLE_DRIVE_DOWNLOAD_MAX_NAME_BYTES - Buffer.byteLength(suffix),
      ).replace(/[. ]+$/g, "") + suffix;
    const folded = foldGoogleDriveDownloadName(candidate);
    if (!usedNames.has(folded) && GoogleDriveDownloadNameSchema.safeParse(candidate).success) {
      usedNames.add(folded);
      return candidate;
    }
  }
}
