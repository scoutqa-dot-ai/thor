import sharp from "sharp";
import { crc32 } from "node:zlib";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { PI_IMAGE_MAX_BYTES } from "@thor/pi-executor/protocol";
import { PiExecutionEnv } from "./pi-execution-env.js";

// Product safety contract for image decoding, independent of Durable text/output truncation.
const imageMaxPixels = 16_000_000;
const imageParameters = Type.Object({
  path: Type.String({
    description: "Remote filesystem image path (relative or absolute), not a URL",
  }),
});

function rasterMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}
function rasterEnvelopeFailure(bytes: Buffer, mimeType: string): string | undefined {
  if (mimeType === "image/png") {
    let offset = 8;
    let sawImageData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return "malformed or incomplete raster image";
      const chunk = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      if (offset === 8 && (chunk !== "IHDR" || length !== 13)) return "malformed raster image";
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
        return "malformed raster image checksum";
      if (chunk === "acTL") return "animated images are not supported; provide a still frame";
      if (chunk === "IDAT") sawImageData = true;
      if (chunk === "IEND")
        return length === 0 && end === bytes.length && sawImageData
          ? undefined
          : "malformed raster image";
      offset = end;
    }
    return "malformed or incomplete raster image";
  }
  if (mimeType === "image/jpeg" && (bytes.at(-2) !== 255 || bytes.at(-1) !== 217))
    return "malformed or incomplete raster image";
  if (mimeType === "image/gif" && bytes.at(-1) !== 59)
    return "malformed or incomplete raster image";
  if (
    mimeType === "image/webp" &&
    (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== bytes.length)
  )
    return "malformed or incomplete raster image";
  return undefined;
}

function imageFailure(reason: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `read_image failed: ${reason}` }],
  };
}

/** Read images only through the Pi remote executor; full raster decoding precedes inline model content. */
export function createPiReadImageTool(
  modelSupportsImages: boolean,
): ToolRegistration<typeof imageParameters> {
  return defineTool({
    name: "read_image",
    description:
      "Inspect a PNG, JPEG, WebP or static GIF from a remote filesystem path. Maximum 10 MiB and 16 million pixels. URLs, SVG and HTML are not accepted. Use the Slack skill to download attachments first.",
    parameters: imageParameters,
    replay: "safe",
    execute: async (args, api, context) => {
      if (context.abortSignal?.aborted) return imageFailure("cancelled");
      if (!modelSupportsImages) return imageFailure("the selected model does not support images");
      // Fail closed for every non-remote environment; never fall back to runner files or a URL client.
      if (!(api.env instanceof PiExecutionEnv))
        return imageFailure("remote image reader unavailable");
      if (
        !args.path.trim() ||
        /^[a-z][a-z0-9+.-]*:/i.test(args.path) ||
        args.path.startsWith("//") ||
        args.path.includes("\0")
      )
        return imageFailure("provide a filesystem path, not a URL");
      const read = await api.env.readBoundedBinaryFile(args.path, PI_IMAGE_MAX_BYTES, context);
      if (!read.ok)
        return imageFailure(
          read.error.code === "aborted"
            ? "cancelled"
            : `remote file unavailable (${read.error.code})`,
        );
      if ("tooLarge" in read.value) return imageFailure("image exceeds the 10 MiB byte limit");
      const bytes = Buffer.from(read.value.data, "base64");
      const mimeType = rasterMimeType(bytes);
      if (!mimeType)
        return imageFailure(
          "unsupported image contents; use PNG, JPEG, WebP or static GIF (not SVG or HTML)",
        );
      const envelopeFailure = rasterEnvelopeFailure(bytes, mimeType);
      if (envelopeFailure) return imageFailure(envelopeFailure);
      try {
        // Signature allowlist runs before the decoder, so SVG/XML is never handed to libvips.
        // metadata does not allocate a pixel buffer; full decode is separately pixel-bounded.
        const metadata = await sharp(bytes, {
          limitInputPixels: false,
          failOn: "warning",
        }).metadata();
        const { width, height } = metadata;
        if (!width || !height || !Number.isSafeInteger(width * height))
          return imageFailure("malformed image dimensions");
        if (width * height > imageMaxPixels)
          return imageFailure("image exceeds the 16 million pixel limit");
        if ((metadata.pages ?? 1) > 1)
          return imageFailure("animated images are not supported; provide a still frame");
        if (`image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` !== mimeType)
          return imageFailure("malformed image contents");
        if (context.abortSignal?.aborted) return imageFailure("cancelled");
        // Unlike header sniffing, full decode rejects truncated/corrupt raster data. Raw output is
        // bounded to 16M pixels by libvips; no decoded pixels are stored in messages or logs.
        await sharp(bytes, { limitInputPixels: imageMaxPixels, failOn: "warning" })
          .raw()
          .toBuffer();
        if (context.abortSignal?.aborted) return imageFailure("cancelled");
        return {
          content: [
            {
              type: "text",
              text: `Image: ${mimeType}, ${width} × ${height}, ${bytes.length} bytes.`,
            },
            { type: "image", mimeType, data: read.value.data },
          ],
        };
      } catch {
        // Native decoder errors may contain untrusted metadata; do not echo them.
        return imageFailure(
          context.abortSignal?.aborted ? "cancelled" : "malformed or incomplete raster image",
        );
      }
    },
  });
}
