import { readFileSync, unlinkSync } from "node:fs";

import { z } from "zod/v4";
import { BrokerConfigurationError } from "./errors.ts";
import { RedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

const ONEPASSWORD_ID_PATTERN = /^[a-z0-9]{26}$/;
const SECRET_REFERENCE_PATTERN = /^op:\/\/([a-z0-9]{26})\/([a-z0-9]{26})\/([A-Za-z0-9_.-]+)$/;
const MAX_SELECTOR_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
export const SERVICE_ACCOUNT_TOKEN_FILE = "/run/secrets/thor-onepassword-service-account-token";

const OnePasswordVaultIdSchema = z
  .string()
  .regex(ONEPASSWORD_ID_PATTERN)
  .brand<"OnePasswordVaultId">();
const OnePasswordItemIdSchema = z
  .string()
  .regex(ONEPASSWORD_ID_PATTERN)
  .brand<"OnePasswordItemId">();
const SelectorSchema = z.string().trim().min(1).max(MAX_SELECTOR_LENGTH);

const RawPolicySchema = z
  .object({
    vault_id: OnePasswordVaultIdSchema,
    item_id: OnePasswordItemIdSchema,
    origin: z.string().trim().min(1),
    login_url: z.string().trim().min(1),
    username_ref: z.string().trim().min(1),
    password_ref: z.string().trim().min(1),
    selectors: z
      .object({
        username: SelectorSchema,
        username_submit: SelectorSchema.optional(),
        password: SelectorSchema,
        submit: SelectorSchema,
      })
      .strict(),
    success_path_prefix: z.string().trim().startsWith("/").max(500),
    timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
  })
  .strict();

export type OnePasswordVaultId = z.infer<typeof OnePasswordVaultIdSchema>;
export type OnePasswordItemId = z.infer<typeof OnePasswordItemIdSchema>;

export interface SecretReference {
  readonly value: string;
  readonly vaultId: OnePasswordVaultId;
  readonly itemId: OnePasswordItemId;
  readonly fieldId: string;
}

export interface BrowserLoginPolicy {
  readonly vaultId: OnePasswordVaultId;
  readonly itemId: OnePasswordItemId;
  readonly origin: string;
  readonly loginUrl: string;
  readonly usernameRef: SecretReference;
  readonly passwordRef: SecretReference;
  readonly selectors: {
    readonly username: string;
    readonly usernameSubmit?: string;
    readonly password: string;
    readonly submit: string;
  };
  readonly successPathPrefix: string;
  readonly timeoutMs: number;
}

export interface BrokerEnvironment {
  readonly serviceAccountToken: RedactedString;
  readonly policy: BrowserLoginPolicy;
}

export type ServiceAccountTokenConsumer = (path: string) => string | undefined;

/**
 * Read a service-account token from a one-shot file and remove it before any
 * browser process can start. Failure to remove the file fails the broker closed.
 */
export function consumeServiceAccountTokenFile(path: string): string | undefined {
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  try {
    unlinkSync(path);
  } catch {
    return undefined;
  }
  return token || undefined;
}

function parseExactHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      value !== url.origin
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function parseExpectedOrigin(value: string): string | undefined {
  return parseExactHttpsOrigin(value.trim());
}

function parseSameOriginUrl(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.origin !== origin
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function parseSecretReference(
  value: string,
  vaultId: OnePasswordVaultId,
  itemId: OnePasswordItemId,
): SecretReference | undefined {
  const match = SECRET_REFERENCE_PATTERN.exec(value);
  if (!match || match[1] !== vaultId || match[2] !== itemId || !match[3]) return undefined;
  return { value, vaultId, itemId, fieldId: match[3] };
}

function parsePolicy(value: string): Result<BrowserLoginPolicy, BrokerConfigurationError> {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return err(new BrokerConfigurationError("invalid_policy"));
  }

  const parsed = RawPolicySchema.safeParse(raw);
  if (!parsed.success) return err(new BrokerConfigurationError("invalid_policy"));

  const origin = parseExactHttpsOrigin(parsed.data.origin);
  if (!origin) return err(new BrokerConfigurationError("invalid_policy"));
  const loginUrl = parseSameOriginUrl(parsed.data.login_url, origin);
  if (!loginUrl) return err(new BrokerConfigurationError("invalid_policy"));
  if (
    parsed.data.success_path_prefix.includes("?") ||
    parsed.data.success_path_prefix.includes("#")
  ) {
    return err(new BrokerConfigurationError("invalid_policy"));
  }

  const usernameRef = parseSecretReference(
    parsed.data.username_ref,
    parsed.data.vault_id,
    parsed.data.item_id,
  );
  const passwordRef = parseSecretReference(
    parsed.data.password_ref,
    parsed.data.vault_id,
    parsed.data.item_id,
  );
  if (!usernameRef || !passwordRef || usernameRef.fieldId === passwordRef.fieldId) {
    return err(new BrokerConfigurationError("invalid_policy"));
  }

  return ok({
    vaultId: parsed.data.vault_id,
    itemId: parsed.data.item_id,
    origin,
    loginUrl,
    usernameRef,
    passwordRef,
    selectors: {
      username: parsed.data.selectors.username,
      ...(parsed.data.selectors.username_submit
        ? { usernameSubmit: parsed.data.selectors.username_submit }
        : {}),
      password: parsed.data.selectors.password,
      submit: parsed.data.selectors.submit,
    },
    successPathPrefix: parsed.data.success_path_prefix,
    timeoutMs: parsed.data.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  });
}

export function parseBrokerEnvironment(
  env: NodeJS.ProcessEnv,
  consumeToken: ServiceAccountTokenConsumer = consumeServiceAccountTokenFile,
): Result<BrokerEnvironment, BrokerConfigurationError> {
  const tokenFile = env.OP_SERVICE_ACCOUNT_TOKEN_FILE?.trim();
  const token = tokenFile === SERVICE_ACCOUNT_TOKEN_FILE ? consumeToken(tokenFile) : undefined;
  if (!token) return err(new BrokerConfigurationError("missing_token"));
  const policyJson = env.ONEPASSWORD_BROWSER_CONFIG?.trim();
  if (!policyJson) return err(new BrokerConfigurationError("missing_policy"));

  const policy = parsePolicy(policyJson);
  if (policy._tag === "err") return policy;
  return ok({ serviceAccountToken: RedactedString.make(token), policy: policy.value });
}

export const onePasswordIdPattern = ONEPASSWORD_ID_PATTERN;
