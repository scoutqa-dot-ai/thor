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

/** Decode inline raster images with the same byte, pixel, still-image and model contract as read_image. */
export async function decodePiRasterImage(
  data: string,
  modelSupportsImages: boolean,
  signal?: AbortSignal,
  declaredMimeType?: string,
): Promise<
  | { ok: false; reason: string }
  | { ok: true; mimeType: string; width: number; height: number; bytes: number }
> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  if (!modelSupportsImages)
    return { ok: false, reason: "the selected model does not support images" };
  if (data.length > Math.ceil(PI_IMAGE_MAX_BYTES / 3) * 4)
    return { ok: false, reason: "image exceeds the 10 MiB byte limit" };
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return { ok: false, reason: "malformed image encoding" };
  if (bytes.length > PI_IMAGE_MAX_BYTES)
    return { ok: false, reason: "image exceeds the 10 MiB byte limit" };
  const mimeType = rasterMimeType(bytes);
  if (!mimeType)
    return {
      ok: false,
      reason: "unsupported image contents; use PNG, JPEG, WebP or static GIF (not SVG or HTML)",
    };
  if (declaredMimeType !== undefined && declaredMimeType !== mimeType)
    return { ok: false, reason: "image MIME type does not match raster contents" };
  const envelopeFailure = rasterEnvelopeFailure(bytes, mimeType);
  if (envelopeFailure) return { ok: false, reason: envelopeFailure };
  try {
    // The signature allowlist precedes libvips; metadata is read before pixel allocation.
    const metadata = await sharp(bytes, { limitInputPixels: false, failOn: "warning" }).metadata();
    const { width, height } = metadata;
    if (!width || !height || !Number.isSafeInteger(width * height))
      return { ok: false, reason: "malformed image dimensions" };
    if (width * height > imageMaxPixels)
      return { ok: false, reason: "image exceeds the 16 million pixel limit" };
    if ((metadata.pages ?? 1) > 1)
      return { ok: false, reason: "animated images are not supported; provide a still frame" };
    if (`image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` !== mimeType)
      return { ok: false, reason: "malformed image contents" };
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    await sharp(bytes, { limitInputPixels: imageMaxPixels, failOn: "warning" }).raw().toBuffer();
    return signal?.aborted
      ? { ok: false, reason: "cancelled" }
      : { ok: true, mimeType, width, height, bytes: bytes.length };
  } catch {
    return {
      ok: false,
      reason: signal?.aborted ? "cancelled" : "malformed or incomplete raster image",
    };
  }
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
      const image = await decodePiRasterImage(
        read.value.data,
        modelSupportsImages,
        context.abortSignal,
      );
      if (!image.ok) return imageFailure(image.reason);
      return {
        content: [
          {
            type: "text",
            text: `Image: ${image.mimeType}, ${image.width} × ${image.height}, ${image.bytes} bytes.`,
          },
          { type: "image", mimeType: image.mimeType, data: read.value.data },
        ],
      };
    },
  });
}
