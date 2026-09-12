import { readFileSync, unlinkSync } from "node:fs";

import { z } from "zod/v4";
import { BrokerConfigurationError, BrokerRequestDeniedError } from "./errors.ts";
import { RedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

const ONEPASSWORD_ID_PATTERN = /^[a-z0-9]{26}$/;
const OnePasswordVaultIdSchema = z
  .string()
  .regex(ONEPASSWORD_ID_PATTERN)
  .brand<"OnePasswordVaultId">();
const OnePasswordItemIdSchema = z
  .string()
  .regex(ONEPASSWORD_ID_PATTERN)
  .brand<"OnePasswordItemId">();
const BrowserOriginSchema = z.string().brand<"BrowserOrigin">();
const BrowserUrlSchema = z.string().brand<"BrowserUrl">();

/** Fixed private path populated from anonymous fd 3 and consumed once at startup. */
export const SERVICE_ACCOUNT_TOKEN_FILE = "/run/secrets/thor-onepassword-service-account-token";

/** Identifier for the only 1Password vault reachable by the broker. */
export type OnePasswordVaultId = z.infer<typeof OnePasswordVaultIdSchema>;

/** Identifier for a Login item inside the dedicated browser vault. */
export type OnePasswordItemId = z.infer<typeof OnePasswordItemIdSchema>;

/** Canonical exact HTTPS origin used as the browser network boundary. */
export type BrowserOrigin = z.infer<typeof BrowserOriginSchema>;

/** Canonical HTTPS page URL without credentials, query parameters, or a fragment. */
export type BrowserUrl = z.infer<typeof BrowserUrlSchema>;

/** Parsed website destination whose canonical URL and exact origin cannot diverge. */
export interface BrowserDestination {
  readonly url: BrowserUrl;
  readonly origin: BrowserOrigin;
}

/** Startup configuration parsed before the 1Password client or browser is created. */
export interface BrokerEnvironment {
  readonly serviceAccountToken: RedactedString;
  readonly vaultId: OnePasswordVaultId;
}

/** Supplies the service-account token exactly once without accepting a caller path. */
export type ServiceAccountTokenConsumer = () => string | undefined;

/** Fixed-path file operations used to consume and remove the one-shot token. */
export interface ServiceAccountTokenFileAccess {
  readonly read: () => string;
  readonly remove: () => void;
}

const serviceAccountTokenFileAccess: ServiceAccountTokenFileAccess = {
  read: () => readFileSync(SERVICE_ACCOUNT_TOKEN_FILE, "utf8"),
  remove: () => unlinkSync(SERVICE_ACCOUNT_TOKEN_FILE),
};

/**
 * Read the service-account token from its fixed one-shot path and remove it before
 * any browser process can start. A read or removal failure returns no token.
 */
export function consumeServiceAccountTokenFile(
  access: ServiceAccountTokenFileAccess = serviceAccountTokenFileAccess,
): string | undefined {
  let token: string;
  try {
    token = access.read().trim();
  } catch {
    return undefined;
  }
  try {
    access.remove();
  } catch {
    return undefined;
  }
  return token || undefined;
}

/** Parse a runtime 1Password item ID supplied by the SDK or MCP boundary. */
export function parseOnePasswordItemId(value: string): OnePasswordItemId | undefined {
  const parsed = OnePasswordItemIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse an untrusted browser destination into a canonical exact-origin value.
 * Query strings and fragments are rejected because they can carry bearer data.
 */
export function parseBrowserDestinationUrl(
  value: string,
): Result<BrowserDestination, BrokerRequestDeniedError> {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      return err(new BrokerRequestDeniedError("invalid_destination"));
    }

    return ok({
      url: BrowserUrlSchema.parse(url.href),
      origin: BrowserOriginSchema.parse(url.origin),
    });
  } catch {
    return err(new BrokerRequestDeniedError("invalid_destination"));
  }
}

/** Parse the broker environment and consume the service-account token once. */
export function parseBrokerEnvironment(
  env: NodeJS.ProcessEnv,
  consumeToken: ServiceAccountTokenConsumer = consumeServiceAccountTokenFile,
): Result<BrokerEnvironment, BrokerConfigurationError> {
  const tokenFile = env.OP_SERVICE_ACCOUNT_TOKEN_FILE?.trim();
  const token = tokenFile === SERVICE_ACCOUNT_TOKEN_FILE ? consumeToken() : undefined;
  if (!token) return err(new BrokerConfigurationError("missing_token"));

  const vaultValue = env.ONEPASSWORD_BROWSER_VAULT_ID?.trim();
  if (!vaultValue) return err(new BrokerConfigurationError("missing_vault"));
  const vault = OnePasswordVaultIdSchema.safeParse(vaultValue);
  if (!vault.success) return err(new BrokerConfigurationError("invalid_vault"));

  return ok({
    serviceAccountToken: RedactedString.make(token),
    vaultId: vault.data,
  });
}

/** Runtime pattern used by strict MCP and approval schemas for 1Password IDs. */
export const onePasswordIdPattern = ONEPASSWORD_ID_PATTERN;
