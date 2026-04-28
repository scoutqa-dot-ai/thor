import { serializeError } from "serialize-error";
import { truncate } from "./logger.js";

export interface ErrorMetadataOptions {
  maxMessageLength?: number;
}

export function errorToMetadata(
  error: unknown,
  options: ErrorMetadataOptions = {},
): Record<string, unknown> {
  const serialized = serializeError(error) as Record<string, unknown>;
  const maxMessageLength = options.maxMessageLength ?? 300;
  const metadata: Record<string, unknown> = {};

  if (typeof serialized.name === "string" && serialized.name) {
    metadata.errorName = serialized.name;
  }
  if (typeof serialized.message === "string" && serialized.message) {
    metadata.errorMessage = truncate(serialized.message, maxMessageLength);
  }
  if (typeof serialized.code === "string" && serialized.code) {
    metadata.errorCode = serialized.code;
  }

  if (Object.keys(metadata).length > 0) return metadata;
  return { errorMessage: truncate(String(error), maxMessageLength) };
}
