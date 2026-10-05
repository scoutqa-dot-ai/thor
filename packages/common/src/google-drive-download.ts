import { z } from "zod/v4";
import { ExecResultSchema } from "./exec-result.js";

/** Wire version for Google Drive downloads; incompatible changes require a new version. */
export const GOOGLE_DRIVE_DOWNLOAD_VERSION = 1;
/** Google Drive download ceiling in decoded bytes, across every file (50 MiB). */
export const GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Google Drive download ceiling includes the root, directories, files and skipped shortcuts. */
export const GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES = 1000;
/** Google Drive download depth counts path components, including the root. */
export const GOOGLE_DRIVE_DOWNLOAD_MAX_DEPTH = 32;
/** Portable filename component ceiling in UTF-8 bytes, not JavaScript characters. */
export const GOOGLE_DRIVE_DOWNLOAD_MAX_NAME_BYTES = 180;

/** Drive file IDs are opaque API identifiers, never paths or the whole-drive root alias. */
export const GoogleDriveFileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,256}$/)
  .refine((id) => id !== "root")
  .brand<"GoogleDriveFileId">();
/** Parsed Drive file ID accepted by the broker's exact download command. */
export type GoogleDriveFileId = z.infer<typeof GoogleDriveFileIdSchema>;

/** Portable filename components exclude traversal, Windows aliases and noncanonical Unicode. */
export const GoogleDriveDownloadNameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !/[<>:"/\\|?*\p{Cc}\p{Cs}]/u.test(name) &&
      !/[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) &&
      name === name.normalize("NFC") &&
      Buffer.byteLength(name, "utf8") <= GOOGLE_DRIVE_DOWNLOAD_MAX_NAME_BYTES,
  );

const DownloadPathSchema = z
  .array(GoogleDriveDownloadNameSchema)
  .min(1)
  .max(GOOGLE_DRIVE_DOWNLOAD_MAX_DEPTH);
const DownloadEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: DownloadPathSchema }).strict(),
  z
    .object({
      kind: z.literal("file"),
      path: DownloadPathSchema,
      mimeType: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
      /** Decoded byte count; base64 padding and aggregate size must agree with this value. */
      size: z.number().int().min(0).max(GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES),
      /** Lowercase SHA-256 of decoded bytes; the local writer must verify it before creating files. */
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      dataBase64: z
        .string()
        .max(4 * Math.ceil(GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES / 3))
        .refine(
          (data) =>
            data.length % 4 === 0 &&
            !/[^A-Za-z0-9+/=]/.test(data) &&
            !data.slice(0, -2).includes("=") &&
            !/=[^=]$/.test(data),
        ),
    })
    .strict()
    .superRefine((file, ctx) => {
      // Canonical base64 only needs its final quartet decoded; unused padding bits live there.
      // Avoid both a large allocation and repeated-group regex stacks on a 50 MiB payload.
      const padding = file.dataBase64.endsWith("==") ? 2 : file.dataBase64.endsWith("=") ? 1 : 0;
      if (
        (file.dataBase64.length / 4) * 3 - padding !== file.size ||
        Buffer.from(file.dataBase64.slice(-4), "base64").toString("base64") !==
          file.dataBase64.slice(-4)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Drive download file has inconsistent or noncanonical base64",
        });
      }
    }),
]);

/** Case folding for download paths also collapses Unicode normalization and sharp-s/sigma aliases. */
export function foldGoogleDriveDownloadName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** Strict binary manifest; validates the whole rooted tree but leaves digest verification to the writer. */
export const GoogleDriveDownloadSchema = z
  .object({
    version: z.literal(GOOGLE_DRIVE_DOWNLOAD_VERSION),
    rootName: GoogleDriveDownloadNameSchema,
    entries: z.array(DownloadEntrySchema).min(1).max(GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES),
    skipped: z
      .array(
        z
          .object({
            fileId: GoogleDriveFileIdSchema,
            name: GoogleDriveDownloadNameSchema,
            reason: z.literal("shortcut"),
          })
          .strict(),
      )
      .max(GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = new Map<string, z.infer<typeof DownloadEntrySchema>>();
    const folded = new Set<string>();
    let totalBytes = 0;
    for (const entry of manifest.entries) {
      const key = JSON.stringify(entry.path);
      const foldedKey = JSON.stringify(entry.path.map(foldGoogleDriveDownloadName));
      if (entry.path[0] !== manifest.rootName || paths.has(key) || folded.has(foldedKey)) {
        ctx.addIssue({
          code: "custom",
          message: "Drive download paths must be unique within one root",
        });
      }
      paths.set(key, entry);
      folded.add(foldedKey);
      if (entry.kind === "file") totalBytes += entry.size;
    }
    if (!paths.has(JSON.stringify([manifest.rootName]))) {
      ctx.addIssue({ code: "custom", message: "Drive download root entry is required" });
    }
    for (const entry of manifest.entries) {
      if (
        entry.path.length > 1 &&
        paths.get(JSON.stringify(entry.path.slice(0, -1)))?.kind !== "directory"
      ) {
        ctx.addIssue({ code: "custom", message: "Drive download parent directories must exist" });
      }
    }
    if (
      totalBytes > GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES ||
      manifest.entries.length + manifest.skipped.length > GOOGLE_DRIVE_DOWNLOAD_MAX_ENTRIES
    ) {
      ctx.addIssue({ code: "custom", message: "Drive download exceeds the transfer ceiling" });
    }
  });
/** Versioned Google Drive binary manifest; never place this content in model-visible stdout. */
export type GoogleDriveDownload = z.infer<typeof GoogleDriveDownloadSchema>;
/** One file or directory in a Google Drive manifest, with root-relative component paths. */
export type GoogleDriveDownloadEntry = GoogleDriveDownload["entries"][number];
/** Dedicated optional Google Drive download field preserves ordinary exec responses. */
export const GoogleDriveDownloadExecResultSchema = ExecResultSchema.extend({
  driveDownload: GoogleDriveDownloadSchema.optional(),
});
/** Exec response carrying a Google Drive manifest only after complete successful acquisition. */
export type GoogleDriveDownloadExecResult = z.infer<typeof GoogleDriveDownloadExecResultSchema>;
