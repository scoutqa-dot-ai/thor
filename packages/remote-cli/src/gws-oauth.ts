import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ExecResultSchema,
  GoogleAuthContinuationSchema,
  GoogleAuthWaitBindingSchema,
  type GoogleAuthContinuation,
  type GoogleAuthWaitBinding,
  type ExecResult,
} from "@thor/common";
import { z } from "zod";
import { parseGwsArgs } from "./gws-args.js";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const OAUTH_HTTP_TIMEOUT_MS = 15_000;
const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ENCRYPTION_CONTEXT = Buffer.from("thor:gws-user-oauth:v1", "utf8");
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_WORKSPACE_ALLOWED_SCOPES = new Set([
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
]);

/** Same-browser nonce cookie required when Google returns to Neo. */
export const GWS_OAUTH_BROWSER_COOKIE = "thor_gws_oauth_browser";

class Redacted<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

const OwnerSchema = z.object({
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
  expectedGoogleEmail: z.string().email(),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  triggerId: z.string().min(1),
});

const RequestOwnerSchema = OwnerSchema.partial({ expectedGoogleEmail: true });

const PendingRequestBaseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(20).max(200),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
const PendingRequestSchema = z.discriminatedUnion("phase", [
  PendingRequestBaseSchema.extend({ phase: z.literal("link_issued"), owner: RequestOwnerSchema }),
  PendingRequestBaseSchema.extend({
    phase: z.enum(["authorization_started", "exchanging"]),
    owner: OwnerSchema,
    oauthState: z.string().min(20).max(300),
    codeVerifier: z.string().min(43).max(128),
    browserNonce: z.string().min(20).max(300),
  }),
  PendingRequestBaseSchema.extend({ phase: z.enum(["completed", "failed"]), owner: OwnerSchema }),
]);

type PendingRequest = z.infer<typeof PendingRequestSchema>;
/** Slack turn identity bound to one OAuth request or command approval. */
export type GwsOAuthOwner = z.infer<typeof OwnerSchema>;

const StateBindingSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(20).max(200),
  oauthState: z.string().min(20).max(300),
  expiresAtMs: z.number().int().positive(),
});

const PendingCommandSchema = z.object({
  version: z.literal(1),
  actionId: z.string().min(1),
  owner: OwnerSchema,
  args: z.array(z.string()),
  status: z.enum(["pending", "consumed", "completed", "delivered"]),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  reviewer: z.string().min(1).optional(),
  resultCapability: z.string().min(32).max(200),
  result: ExecResultSchema.optional(),
});

type PendingCommand = z.infer<typeof PendingCommandSchema>;

const ContinuationBaseSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  owner: RequestOwnerSchema,
  args: z.array(z.string().refine((arg) => !arg.includes("\0"))),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
const ContinuationSchema = z.discriminatedUnion("status", [
  ContinuationBaseSchema.extend({ status: z.enum(["awaiting_dm", "waiting"]) }),
  ContinuationBaseSchema.extend({
    status: z.enum(["authorized_unconfirmed", "ready", "acked"]),
    connectionId: z.uuid(),
    dispatchTriggerId: z.string().optional(),
  }),
]);
type ContinuationRecord = z.infer<typeof ContinuationSchema>;

const ConnectionSchema = z.object({
  version: z.literal(1),
  connectionId: z.uuid(),
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
  expectedGoogleEmail: z.string().email(),
  googleSubject: z.string().min(1),
  googleEmail: z.string().email(),
  refreshToken: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

type Connection = z.infer<typeof ConnectionSchema>;

const EncryptedEnvelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  tag: z.string().min(1),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
});

const UserInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean(),
});

const OAUTH_SETTING_NAMES = {
  clientId: "GOOGLE_WORKSPACE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET",
  publicBaseUrl: "GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL",
  scopes: "GOOGLE_WORKSPACE_OAUTH_SCOPES",
  encryptionKey: "GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY",
  storageDir: "GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR",
  slackTeamId: "SLACK_TEAM_ID",
} as const;
type OAuthSettingName = (typeof OAUTH_SETTING_NAMES)[keyof typeof OAUTH_SETTING_NAMES];
/** Operator-safe OAuth setup evidence; names only, never credential or configuration values. */
export interface GwsOAuthSetupStatus {
  readonly configured: boolean;
  readonly missing: readonly OAuthSettingName[];
  readonly invalid: readonly OAuthSettingName[];
}

const ConfigInputSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  publicBaseUrl: z.url(),
  scopes: z.array(z.string().trim().min(1)).min(1),
  encryptionKey: z.string().trim().min(1),
  storageDir: z.string().startsWith("/").min(2),
  slackTeamId: z.string().trim().min(1),
});

type GwsOAuthConfig = {
  readonly clientId: string;
  readonly clientSecret: Redacted<string>;
  readonly publicBaseUrl: URL;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly encryptionKey: Redacted<Buffer>;
  readonly storageDir: string;
  readonly slackTeamId: string;
};

export type GwsOAuthErrorStage =
  | "configuration"
  | "storage"
  | "request"
  | "identity"
  | "oauth"
  | "token";

/** Classified Google Workspace OAuth failure with no secret-bearing details. */
export class GwsOAuthError extends Error {
  readonly _tag = "GwsOAuthError" as const;

  constructor(
    readonly stage: GwsOAuthErrorStage,
    readonly code:
      | "unavailable"
      | "not_found"
      | "expired"
      | "already_used"
      | "browser_mismatch"
      | "identity_mismatch"
      | "provider_rejected"
      | "invalid_provider_response"
      | "connection_missing"
      | "connection_invalid"
      | "credentials_revoked",
    readonly httpStatus?: number,
    readonly configurationFields?: readonly OAuthSettingName[],
  ) {
    super(
      `Google Workspace OAuth failed: ${stage}/${code}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`,
    );
  }
}

export type GwsOAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GwsOAuthError };

/** Private invitation for the trusted Slack requester; optional email restricts choice, otherwise browser confirmation establishes it. */
export interface GwsConnectionRequestInput {
  readonly slackUserId: string;
  readonly expectedGoogleEmail?: string;
  readonly sessionId: string;
  readonly anchorId: string;
  readonly triggerId: string;
}

export interface GwsPendingCommandInput extends GwsConnectionRequestInput {
  readonly expectedGoogleEmail: string;
  readonly actionId: string;
  readonly args: readonly string[];
}

export interface GwsConsumedCommand {
  readonly actionId: string;
  readonly owner: GwsOAuthOwner;
  readonly args: readonly string[];
  readonly reviewer: string;
}

export interface GwsConnectionRequest {
  readonly reused?: boolean;
  readonly requestId: string;
  readonly connectUrl: string;
  readonly expiresAtMs: number;
}

export interface GwsAuthorizationStart {
  readonly authorizationUrl: string;
  readonly browserNonce: string;
  readonly maxAgeSeconds: number;
}

export interface GwsConnectedIdentity {
  readonly connectionId: string;
  readonly googleEmail: string;
  readonly slackUserId: string;
}

export interface GwsAuthorizationCompletion extends GwsConnectedIdentity {
  readonly googleSubject: string;
  readonly sessionId: string;
  readonly anchorId: string;
  readonly triggerId: string;
}

export interface GwsAccessToken {
  readonly connectionId: string;
  readonly googleEmail: string;
  readonly googleSubject: string;
  /** Reveal the short-lived access token only at the gws process boundary. */
  reveal(): string;
}

export interface GwsOAuthServiceDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly userInfoEndpoint?: string;
}

/** Owns per-Slack-user Google OAuth state, encrypted grants, and access-token refresh. */
export class GwsOAuthService {
  readonly #config: GwsOAuthResult<GwsOAuthConfig>;
  readonly #missingSettings: readonly OAuthSettingName[];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #authorizationEndpoint: string;
  readonly #tokenEndpoint: string;
  readonly #userInfoEndpoint: string;

  constructor(env: NodeJS.ProcessEnv, deps: GwsOAuthServiceDeps = {}) {
    this.#config = parseGwsOAuthConfig(env);
    this.#missingSettings = Object.values(OAUTH_SETTING_NAMES).filter(
      (name) => name !== "GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR" && !env[name]?.trim(),
    );
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? Date.now;
    this.#randomBytes = deps.randomBytes ?? randomBytes;
    this.#authorizationEndpoint = deps.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT;
    this.#tokenEndpoint = deps.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.#userInfoEndpoint = deps.userInfoEndpoint ?? GOOGLE_USERINFO_ENDPOINT;
  }

  /** Report missing and invalid OAuth settings without exposing values, state or credentials. */
  setupStatus(): GwsOAuthSetupStatus {
    return {
      configured: this.#config.ok,
      missing: this.#config.ok ? [] : this.#missingSettings,
      invalid: this.#config.ok
        ? []
        : (this.#config.error.configurationFields ?? []).filter(
            (name) => !this.#missingSettings.includes(name),
          ),
    };
  }

  /** Return the configured Slack workspace without exposing OAuth configuration. */
  slackTeamId(): GwsOAuthResult<string> {
    if (!this.#config.ok) return this.#config;
    return { ok: true, value: this.#config.value.slackTeamId };
  }

  /** Create a private, expiring connection request for one active Slack turn. */
  createConnectionRequest(input: GwsConnectionRequestInput): GwsOAuthResult<GwsConnectionRequest> {
    if (!this.#config.ok) return this.#config;
    const pruned = this.#pruneExpiredTransientRecords();
    if (!pruned.ok) return pruned;
    const config = this.#config.value;
    const parsedOwner = RequestOwnerSchema.safeParse({
      slackTeamId: config.slackTeamId,
      slackUserId: input.slackUserId,
      expectedGoogleEmail: input.expectedGoogleEmail?.toLowerCase(),
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      triggerId: input.triggerId,
    });
    if (!parsedOwner.success) return failure("request", "unavailable");

    const now = this.#now();
    const request: PendingRequest = {
      version: 1,
      requestId: randomBase64Url(this.#randomBytes, 24),
      phase: "link_issued",
      owner: parsedOwner.data,
      createdAtMs: now,
      expiresAtMs: now + REQUEST_TTL_MS,
    };
    const written = this.#writeEncrypted(this.#requestPath(request.requestId), request);
    if (!written.ok) return written;

    const connectUrl = new URL("/google-workspace/connect", config.publicBaseUrl);
    connectUrl.searchParams.set("request", request.requestId);
    return {
      ok: true,
      value: {
        requestId: request.requestId,
        connectUrl: connectUrl.toString(),
        expiresAtMs: request.expiresAtMs,
      },
    };
  }

  /** Persist an unexecuted Google operation; reuse only a confirmed identical current invitation. */
  createAuthContinuation(
    input: GwsConnectionRequestInput & { readonly args: readonly string[] },
  ): GwsOAuthResult<GwsConnectionRequest> {
    if (!this.#config.ok) return this.#config;
    const pruned = this.#pruneExpiredTransientRecords();
    if (!pruned.ok) return pruned;
    const owner = RequestOwnerSchema.safeParse({
      ...input,
      slackTeamId: this.#config.value.slackTeamId,
      expectedGoogleEmail: input.expectedGoogleEmail?.toLowerCase(),
    });
    if (!owner.success || !parseGwsArgs([...input.args]).ok)
      return failure("request", "unavailable");
    const records = this.#readContinuations();
    if (!records.ok) return records;
    for (const record of records.value) {
      if (
        record.status !== "waiting" ||
        record.expiresAtMs <= this.#now() ||
        JSON.stringify(record.owner) !== JSON.stringify(owner.data) ||
        JSON.stringify(record.args) !== JSON.stringify(input.args)
      )
        continue;
      const request = this.#readRequest(record.id);
      if (!request.ok) return request;
      if (request.value.phase === "completed" || request.value.phase === "failed") continue;
      const connectUrl = new URL("/google-workspace/connect", this.#config.value.publicBaseUrl);
      connectUrl.searchParams.set("request", record.id);
      return {
        ok: true,
        value: {
          requestId: record.id,
          connectUrl: connectUrl.toString(),
          expiresAtMs: record.expiresAtMs,
          reused: true,
        },
      };
    }
    const request = this.createConnectionRequest(input);
    if (!request.ok) return request;
    const written = this.#writeEncrypted(this.#continuationPath(request.value.requestId), {
      version: 1,
      id: request.value.requestId,
      owner: owner.data,
      args: [...input.args],
      status: "awaiting_dm",
      createdAtMs: this.#now(),
      expiresAtMs: request.value.expiresAtMs,
    } satisfies ContinuationRecord);
    return written.ok ? request : written;
  }

  /** Confirm private DM delivery before a wait can ever become resumable. */
  confirmAuthContinuation(id: string): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(id)) return failure("request", "not_found");
    const record = this.#readEncrypted(this.#continuationPath(id), ContinuationSchema);
    if (!record.ok) return record;
    if (
      record.value.id !== id ||
      record.value.owner.slackTeamId !== this.#config.value.slackTeamId
    ) {
      return failure("identity", "identity_mismatch");
    }
    if (record.value.expiresAtMs <= this.#now()) return failure("request", "expired");
    if (record.value.status === "waiting" || record.value.status === "ready")
      return { ok: true, value: undefined };
    if (record.value.status === "awaiting_dm") {
      return this.#writeEncrypted(this.#continuationPath(id), {
        ...record.value,
        status: "waiting",
      });
    }
    if (record.value.status === "authorized_unconfirmed") {
      return this.#writeEncrypted(this.#continuationPath(id), { ...record.value, status: "ready" });
    }
    return failure("request", "already_used");
  }

  /** Remove unconfirmed work after failed delivery; later OAuth may connect but cannot resume it. */
  cancelAuthContinuation(id: string): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(id)) return failure("request", "not_found");
    try {
      rmSync(this.#continuationPath(id), { force: true });
      return { ok: true, value: undefined };
    } catch {
      return failure("storage", "unavailable");
    }
  }

  /** Informational, authenticated waits for UI; never an authority to dispatch work. */
  listAuthWaitBindings(): GwsOAuthResult<GoogleAuthWaitBinding[]> {
    const records = this.#readContinuations();
    if (!records.ok) return records;
    const waits: GoogleAuthWaitBinding[] = [];
    for (const record of records.value) {
      if (
        (record.status !== "waiting" && record.status !== "ready") ||
        record.expiresAtMs <= this.#now()
      )
        continue;
      if (record.status === "ready") {
        const connection = this.findConnectedIdentity(
          record.owner.slackUserId,
          record.owner.expectedGoogleEmail,
        );
        if (!connection.ok || connection.value.connectionId !== record.connectionId) continue;
      }
      const parsed = GoogleAuthWaitBindingSchema.safeParse({
        id: record.id,
        ...record.owner,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      });
      if (!parsed.success) return failure("storage", "connection_invalid");
      waits.push(parsed.data);
    }
    return { ok: true, value: waits };
  }

  /** List confirmed ready work for the secret-gated runner outbox, surviving service reconstruction. */
  listReadyContinuations(): GwsOAuthResult<GoogleAuthContinuation[]> {
    const pruned = this.#pruneExpiredTransientRecords();
    if (!pruned.ok) return pruned;
    const records = this.#readContinuations();
    if (!records.ok) return records;
    const ready: GoogleAuthContinuation[] = [];
    for (const record of records.value) {
      if (record.status !== "ready" || record.expiresAtMs <= this.#now()) continue;
      const connected = this.findConnectedIdentity(
        record.owner.slackUserId,
        record.owner.expectedGoogleEmail,
      );
      if (!connected.ok || connected.value.connectionId !== record.connectionId) continue;
      const parsed = GoogleAuthContinuationSchema.safeParse({
        id: record.id,
        ...record.owner,
        args: record.args,
        connectionId: record.connectionId,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      });
      if (!parsed.success) return failure("storage", "connection_invalid");
      ready.push(parsed.data);
    }
    return { ok: true, value: ready };
  }

  /** Retire matching ready work before a direct dispatch, including uncertain outcomes. */
  retireMatchingContinuation(
    input: GwsConnectionRequestInput & { readonly args: readonly string[] },
  ): GwsOAuthResult<void> {
    const records = this.#readContinuations();
    if (!records.ok) return records;
    for (const record of records.value) {
      if (
        record.status !== "ready" ||
        record.owner.slackUserId !== input.slackUserId ||
        record.owner.sessionId !== input.sessionId ||
        record.owner.anchorId !== input.anchorId ||
        record.owner.triggerId !== input.triggerId ||
        JSON.stringify(record.args) !== JSON.stringify(input.args)
      )
        continue;
      const retired = this.acknowledgeContinuation(record.id);
      if (!retired.ok) return retired;
    }
    return { ok: true, value: undefined };
  }
  /** Idempotent durable acknowledgement; terminal records are never listed again. */
  acknowledgeContinuation(id: string, dispatchTriggerId?: string): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(id)) return failure("request", "not_found");
    const record = this.#readEncrypted(this.#continuationPath(id), ContinuationSchema);
    if (!record.ok)
      return record.error.code === "not_found" && !dispatchTriggerId
        ? { ok: true, value: undefined }
        : record;
    if (
      record.value.id !== id ||
      record.value.owner.slackTeamId !== this.#config.value.slackTeamId
    ) {
      return failure("identity", "identity_mismatch");
    }
    if (record.value.status !== "ready" && record.value.status !== "acked")
      return failure("request", "already_used");
    if (dispatchTriggerId) {
      const connected = this.findConnectedIdentity(
        record.value.owner.slackUserId,
        record.value.owner.expectedGoogleEmail,
      );
      if (
        record.value.expiresAtMs <= this.#now() ||
        !connected.ok ||
        connected.value.connectionId !== record.value.connectionId ||
        ((record.value.status === "acked" || record.value.dispatchTriggerId) &&
          record.value.dispatchTriggerId !== dispatchTriggerId)
      )
        return failure("identity", "identity_mismatch");
    }
    if (record.value.status === "acked") return { ok: true, value: undefined };
    return this.#writeEncrypted(this.#continuationPath(id), {
      ...record.value,
      status: "acked",
      ...(dispatchTriggerId ? { dispatchTriggerId, args: [] } : {}),
    });
  }

  /** A resumed trigger may use only the grant that authorized its original blocked operation. */
  validateContinuationDispatch(
    input: { sessionId: string; anchorId: string; triggerId: string; slackUserId: string },
    connectionId: string,
  ): GwsOAuthResult<void> {
    const records = this.#readContinuations();
    if (!records.ok) return records;
    for (const record of records.value) {
      if (record.status !== "acked" || record.dispatchTriggerId !== input.triggerId) continue;
      if (
        record.expiresAtMs <= this.#now() ||
        record.owner.sessionId !== input.sessionId ||
        record.owner.anchorId !== input.anchorId ||
        record.owner.slackUserId !== input.slackUserId ||
        record.connectionId !== connectionId
      )
        return failure("identity", "identity_mismatch");
    }
    return { ok: true, value: undefined };
  }
  #readContinuations(): GwsOAuthResult<ContinuationRecord[]> {
    if (!this.#config.ok) return this.#config;
    const directory = join(this.#config.value.storageDir, "continuations");
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT"
        ? { ok: true, value: [] }
        : failure("storage", "unavailable");
    }
    const records: ContinuationRecord[] = [];
    for (const name of names) {
      const record = this.#readEncrypted(join(directory, name), ContinuationSchema);
      if (!record.ok) return record;
      if (
        name !== `${record.value.id}.json` ||
        (!(record.value.status === "acked" && record.value.dispatchTriggerId) &&
          !parseGwsArgs(record.value.args).ok) ||
        record.value.owner.slackTeamId !== this.#config.value.slackTeamId
      ) {
        return failure("storage", "connection_invalid");
      }
      records.push(record.value);
    }
    return { ok: true, value: records };
  }

  /** Trusted provider origin for the browser's form-redirect CSP; never derived from request input. */
  authorizationOrigin(): string {
    return new URL(this.#authorizationEndpoint).origin;
  }

  /** Show the signed-in Google identity and exact Slack recipient before an unpinned account can be linked. */
  previewAuthorization(
    requestId: string,
    authenticatedEmail: string,
  ): GwsOAuthResult<{
    slackUserId: string;
    slackTeamId: string;
    googleEmail: string;
    confirmationRequired: boolean;
    confirmationToken: string;
  }> {
    if (!this.#config.ok) return this.#config;
    const result = this.#readRequest(requestId);
    if (!result.ok) return result;
    const request = result.value;
    if (request.phase !== "link_issued") return failure("request", "already_used");
    if (request.expiresAtMs <= this.#now()) return failure("request", "expired");
    const email = z.email().safeParse(authenticatedEmail.trim().toLowerCase());
    if (
      !email.success ||
      (request.owner.expectedGoogleEmail && request.owner.expectedGoogleEmail !== email.data)
    )
      return failure("identity", "identity_mismatch");
    const confirmationToken = createHmac("sha256", this.#config.value.encryptionKey.reveal())
      .update(
        JSON.stringify([
          "thor:gws-connect-confirm:v1",
          requestId,
          email.data,
          request.owner.slackUserId,
          request.expiresAtMs,
        ]),
      )
      .digest("base64url");
    return {
      ok: true,
      value: {
        slackUserId: request.owner.slackUserId,
        slackTeamId: request.owner.slackTeamId,
        googleEmail: email.data,
        confirmationRequired: !request.owner.expectedGoogleEmail,
        confirmationToken,
      },
    };
  }

  /** Bind a Vouch-authenticated browser to one request and create the Google redirect. */
  beginAuthorization(
    requestId: string,
    authenticatedEmail: string,
    confirmationToken?: string,
  ): GwsOAuthResult<GwsAuthorizationStart> {
    if (!this.#config.ok) return this.#config;
    const requestResult = this.#readRequest(requestId);
    if (!requestResult.ok) return requestResult;
    const request = requestResult.value;
    if (request.phase !== "link_issued") return failure("request", "already_used");
    if (request.expiresAtMs <= this.#now()) return failure("request", "expired");
    const preview = this.previewAuthorization(requestId, authenticatedEmail);
    if (!preview.ok) return preview;
    if (
      preview.value.confirmationRequired &&
      (!confirmationToken ||
        !timingSafeTextEqual(confirmationToken, preview.value.confirmationToken))
    )
      return failure("request", "browser_mismatch");

    const oauthState = randomBase64Url(this.#randomBytes, 32);
    const codeVerifier = randomBase64Url(this.#randomBytes, 48);
    const browserNonce = randomBase64Url(this.#randomBytes, 32);
    const started: PendingRequest = {
      ...request,
      owner: { ...request.owner, expectedGoogleEmail: preview.value.googleEmail },
      phase: "authorization_started",
      oauthState,
      codeVerifier,
      browserNonce,
    };
    const requestWrite = this.#writeEncrypted(this.#requestPath(requestId), started);
    if (!requestWrite.ok) return requestWrite;
    const stateWrite = this.#writeEncrypted(this.#statePath(oauthState), {
      version: 1,
      requestId,
      oauthState,
      expiresAtMs: request.expiresAtMs,
    });
    if (!stateWrite.ok) return stateWrite;

    const config = this.#config.value;
    const authorizationUrl = new URL(this.#authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("login_hint", preview.value.googleEmail);
    authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "select_account consent");
    authorizationUrl.searchParams.set("include_granted_scopes", "false");
    authorizationUrl.searchParams.set("state", oauthState);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));

    return {
      ok: true,
      value: {
        authorizationUrl: authorizationUrl.toString(),
        browserNonce,
        maxAgeSeconds: Math.max(1, Math.floor((request.expiresAtMs - this.#now()) / 1000)),
      },
    };
  }

  /** Consume one callback, verify the Google identity, and persist an encrypted grant. */
  async completeAuthorization(input: {
    readonly state: string;
    readonly code: string;
    readonly browserNonce: string;
  }): Promise<GwsOAuthResult<GwsAuthorizationCompletion>> {
    if (!this.#config.ok) return this.#config;
    const stateResult = this.#readEncrypted(this.#statePath(input.state), StateBindingSchema);
    if (!stateResult.ok) return stateResult;
    const binding = stateResult.value;
    if (binding.oauthState !== input.state) return failure("request", "not_found");
    if (binding.expiresAtMs <= this.#now()) return failure("request", "expired");

    const requestResult = this.#readRequest(binding.requestId);
    if (!requestResult.ok) return requestResult;
    const request = requestResult.value;
    if (request.phase !== "authorization_started" || request.oauthState !== input.state) {
      return failure("request", "already_used");
    }
    if (!timingSafeTextEqual(request.browserNonce, input.browserNonce)) {
      return failure("request", "browser_mismatch");
    }

    const exchanging: PendingRequest = { ...request, phase: "exchanging" };
    const consumed = this.#writeEncrypted(this.#requestPath(request.requestId), exchanging);
    if (!consumed.ok) return consumed;
    rmSync(this.#statePath(input.state), { force: true });

    const tokenResult = await this.#exchangeAuthorizationCode(input.code, request.codeVerifier);
    if (!tokenResult.ok) {
      this.#markRequestFailed(exchanging);
      return tokenResult;
    }
    if (!tokenResult.value.refreshToken) {
      this.#markRequestFailed(exchanging);
      return failure("oauth", "invalid_provider_response");
    }
    const userInfoResult = await this.#loadUserInfo(tokenResult.value.accessToken);
    if (!userInfoResult.ok) {
      this.#markRequestFailed(exchanging);
      return userInfoResult;
    }
    const userInfo = userInfoResult.value;
    const googleEmail = userInfo.email.toLowerCase();
    if (!userInfo.email_verified || googleEmail !== request.owner.expectedGoogleEmail) {
      this.#markRequestFailed(exchanging);
      return failure("identity", "identity_mismatch");
    }

    const now = this.#now();
    const existing = this.#readConnection(request.owner.slackUserId);
    const connection: Connection = {
      version: 1,
      connectionId: randomUUID(),
      slackTeamId: request.owner.slackTeamId,
      slackUserId: request.owner.slackUserId,
      expectedGoogleEmail: request.owner.expectedGoogleEmail,
      googleSubject: userInfo.sub,
      googleEmail,
      refreshToken: tokenResult.value.refreshToken.reveal(),
      createdAtMs: existing.ok ? existing.value.createdAtMs : now,
      updatedAtMs: now,
    };
    const connectionWrite = this.#writeEncrypted(
      this.#connectionPath(connection.slackUserId),
      connection,
    );
    if (!connectionWrite.ok) {
      this.#markRequestFailed(exchanging);
      return connectionWrite;
    }
    // A callback can race private delivery confirmation. Preserve verified
    // readiness privately, but expose it only after confirmed DM delivery.
    const continuation = this.#readEncrypted(
      this.#continuationPath(request.requestId),
      ContinuationSchema,
    );
    if (!continuation.ok && continuation.error.code !== "not_found") return continuation;
    if (continuation.ok) {
      const record = continuation.value;
      if (
        record.id !== request.requestId ||
        record.owner.slackTeamId !== request.owner.slackTeamId ||
        record.owner.slackUserId !== request.owner.slackUserId ||
        record.owner.sessionId !== request.owner.sessionId ||
        record.owner.anchorId !== request.owner.anchorId ||
        record.owner.triggerId !== request.owner.triggerId ||
        (record.owner.expectedGoogleEmail !== undefined &&
          record.owner.expectedGoogleEmail !== request.owner.expectedGoogleEmail)
      ) {
        return failure("identity", "identity_mismatch");
      }
      if (record.status !== "waiting" && record.status !== "awaiting_dm") {
        return failure("request", "already_used");
      }
      const readyWrite = this.#writeEncrypted(this.#continuationPath(record.id), {
        ...record,
        status: record.status === "waiting" ? "ready" : "authorized_unconfirmed",
        connectionId: connection.connectionId,
        expiresAtMs: now + READY_TTL_MS,
      } satisfies ContinuationRecord);
      if (!readyWrite.ok) return readyWrite;
    }
    const completed: PendingRequest = {
      version: 1,
      requestId: request.requestId,
      phase: "completed",
      owner: request.owner,
      createdAtMs: request.createdAtMs,
      expiresAtMs: request.expiresAtMs,
    };
    const completionWrite = this.#writeEncrypted(this.#requestPath(request.requestId), completed);
    if (!completionWrite.ok) return completionWrite;

    return {
      ok: true,
      value: {
        connectionId: connection.connectionId,
        googleEmail: connection.googleEmail,
        googleSubject: connection.googleSubject,
        slackUserId: connection.slackUserId,
        sessionId: request.owner.sessionId,
        anchorId: request.owner.anchorId,
        triggerId: request.owner.triggerId,
      },
    };
  }

  /** Load only this Slack owner's grant without refreshing; an optional email pin restricts its verified identity. */
  findConnectedIdentity(
    slackUserId: string,
    expectedGoogleEmail?: string,
  ): GwsOAuthResult<GwsConnectedIdentity> {
    if (!this.#config.ok) return this.#config;
    const result = this.#readConnection(slackUserId);
    if (!result.ok) return result;
    const connection = result.value;
    if (
      connection.slackTeamId !== this.#config.value.slackTeamId ||
      connection.slackUserId !== slackUserId ||
      connection.expectedGoogleEmail !== connection.googleEmail ||
      (expectedGoogleEmail !== undefined &&
        connection.googleEmail !== expectedGoogleEmail.toLowerCase())
    ) {
      return failure("identity", "identity_mismatch");
    }
    return {
      ok: true,
      value: {
        connectionId: connection.connectionId,
        googleEmail: connection.googleEmail,
        slackUserId: connection.slackUserId,
      },
    };
  }

  /** Select a unique encrypted grant for a verified browser email; directory pins are not required for revocation. */
  findConnectedIdentityByEmail(authenticatedEmail: string): GwsOAuthResult<GwsConnectedIdentity> {
    if (!this.#config.ok) return this.#config;
    const directory = join(this.#config.value.storageDir, "connections");
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      return failure(
        "storage",
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "connection_missing"
          : "unavailable",
      );
    }
    let match: GwsConnectedIdentity | undefined;
    for (const name of names) {
      const record = this.#readEncrypted(join(directory, name), ConnectionSchema);
      if (!record.ok) return record;
      const connection = record.value;
      if (
        connection.slackTeamId !== this.#config.value.slackTeamId ||
        connection.googleEmail !== connection.expectedGoogleEmail ||
        join(directory, name) !== this.#connectionPath(connection.slackUserId)
      )
        return failure("storage", "connection_invalid");
      if (connection.googleEmail.toLowerCase() !== authenticatedEmail.trim().toLowerCase())
        continue;
      if (match) return failure("identity", "identity_mismatch");
      match = {
        connectionId: connection.connectionId,
        googleEmail: connection.googleEmail,
        slackUserId: connection.slackUserId,
      };
    }
    return match ? { ok: true, value: match } : failure("identity", "connection_missing");
  }
  /** Create a keyed, non-reversible audit binding for exact argv. */
  fingerprintCommand(args: readonly string[]): GwsOAuthResult<string> {
    if (!this.#config.ok) return this.#config;
    const digest = createHmac("sha256", this.#config.value.encryptionKey.reveal())
      .update("thor:gws-command:v1\0", "utf8")
      .update(JSON.stringify(args), "utf8")
      .digest("hex");
    return { ok: true, value: digest };
  }

  /** Persist a private command payload separately from its safe approval summary. */
  storePendingCommand(input: GwsPendingCommandInput): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    const pruned = this.#pruneExpiredTransientRecords();
    if (!pruned.ok) return pruned;
    const owner = OwnerSchema.safeParse({
      slackTeamId: this.#config.value.slackTeamId,
      slackUserId: input.slackUserId,
      expectedGoogleEmail: input.expectedGoogleEmail.toLowerCase(),
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      triggerId: input.triggerId,
    });
    if (!owner.success || input.args.some((arg) => arg.includes("\0"))) {
      return failure("request", "unavailable");
    }
    const now = this.#now();
    return this.#writeEncrypted(this.#commandPath(input.actionId), {
      version: 1,
      actionId: input.actionId,
      owner: owner.data,
      args: [...input.args],
      status: "pending",
      resultCapability: randomBase64Url(this.#randomBytes, 32),
      createdAtMs: now,
      expiresAtMs: now + 30 * 60 * 1000,
    } satisfies PendingCommand);
  }

  /** Consume an approval before dispatch and require the bound Slack user as reviewer. */
  consumePendingCommand(actionId: string, reviewer: string): GwsOAuthResult<GwsConsumedCommand> {
    if (!this.#config.ok) return this.#config;
    const result = this.#readEncrypted(this.#commandPath(actionId), PendingCommandSchema);
    if (!result.ok) return result;
    const command = result.value;
    if (command.status !== "pending") return failure("request", "already_used");
    if (command.expiresAtMs <= this.#now()) return failure("request", "expired");
    if (
      command.owner.slackTeamId !== this.#config.value.slackTeamId ||
      command.owner.slackUserId !== reviewer
    ) {
      return failure("identity", "identity_mismatch");
    }
    const consumed: PendingCommand = { ...command, status: "consumed", reviewer };
    const written = this.#writeEncrypted(this.#commandPath(actionId), consumed);
    if (!written.ok) return written;
    return {
      ok: true,
      value: {
        actionId,
        owner: consumed.owner,
        args: consumed.args,
        reviewer,
      },
    };
  }

  /** Store bounded command output encrypted for the originating session to retrieve. */
  storeCommandResult(actionId: string, result: ExecResult): GwsOAuthResult<string> {
    if (!this.#config.ok) return this.#config;
    const commandResult = this.#readEncrypted(this.#commandPath(actionId), PendingCommandSchema);
    if (!commandResult.ok) return commandResult;
    if (commandResult.value.status !== "consumed" || !commandResult.value.reviewer) {
      return failure("request", "already_used");
    }
    const parsedResult = ExecResultSchema.safeParse(result);
    if (!parsedResult.success) return failure("request", "unavailable");
    const completed: PendingCommand = {
      ...commandResult.value,
      status: "completed",
      result: parsedResult.data,
    };
    const written = this.#writeEncrypted(this.#commandPath(actionId), completed);
    if (!written.ok) return written;
    return { ok: true, value: completed.resultCapability };
  }

  /** Return encrypted output only with the post-approval short-lived capability. */
  readCommandResult(actionId: string, capability: string | undefined): GwsOAuthResult<ExecResult> {
    if (!this.#config.ok) return this.#config;
    if (!capability) return failure("identity", "identity_mismatch");
    const commandResult = this.#readEncrypted(this.#commandPath(actionId), PendingCommandSchema);
    if (!commandResult.ok) return commandResult;
    if (!timingSafeTextEqual(commandResult.value.resultCapability, capability)) {
      return failure("identity", "identity_mismatch");
    }
    if (commandResult.value.expiresAtMs <= this.#now()) return failure("request", "expired");
    if (commandResult.value.status !== "completed" || !commandResult.value.result) {
      return failure("request", "already_used");
    }
    const result = commandResult.value.result;
    const delivered: PendingCommand = {
      ...commandResult.value,
      status: "delivered",
      resultCapability: randomBase64Url(this.#randomBytes, 32),
      result: undefined,
    };
    const written = this.#writeEncrypted(this.#commandPath(actionId), delivered);
    if (!written.ok) return written;
    return { ok: true, value: result };
  }

  /** Refresh and return one short-lived token for the bound Slack user. */
  async getAccessToken(
    slackUserId: string,
    expectedGoogleEmail: string,
  ): Promise<GwsOAuthResult<GwsAccessToken>> {
    if (!this.#config.ok) return this.#config;
    const connectionResult = this.#readConnection(slackUserId);
    if (!connectionResult.ok) return connectionResult;
    const connection = connectionResult.value;
    if (
      connection.slackTeamId !== this.#config.value.slackTeamId ||
      connection.slackUserId !== slackUserId ||
      connection.expectedGoogleEmail !== expectedGoogleEmail.toLowerCase() ||
      connection.googleEmail !== expectedGoogleEmail.toLowerCase()
    ) {
      return failure("identity", "identity_mismatch");
    }

    const refreshed = await this.#refreshAccessToken(new Redacted(connection.refreshToken));
    if (!refreshed.ok) {
      const current = this.findConnectedIdentity(slackUserId, expectedGoogleEmail);
      return current.ok && current.value.connectionId === connection.connectionId
        ? refreshed
        : failure("identity", "identity_mismatch");
    }
    const currentIdentity = await this.#loadUserInfo(refreshed.value);
    const postIdentityConnection = this.findConnectedIdentity(slackUserId, expectedGoogleEmail);
    if (
      !postIdentityConnection.ok ||
      postIdentityConnection.value.connectionId !== connection.connectionId
    )
      return failure("identity", "identity_mismatch");
    if (!currentIdentity.ok) {
      return currentIdentity.error.stage === "identity" && currentIdentity.error.httpStatus === 401
        ? failure("identity", "credentials_revoked", 401)
        : currentIdentity;
    }
    if (
      !currentIdentity.value.email_verified ||
      currentIdentity.value.email.toLowerCase() !== connection.googleEmail ||
      currentIdentity.value.sub !== connection.googleSubject
    ) {
      return failure("identity", "identity_mismatch");
    }
    return {
      ok: true,
      value: {
        connectionId: connection.connectionId,
        googleEmail: currentIdentity.value.email.toLowerCase(),
        googleSubject: currentIdentity.value.sub,
        reveal: () => refreshed.value.reveal(),
      },
    };
  }

  /** Remove the local grant for one Slack user; provider revocation remains an operator/user action. */
  disconnect(slackUserId: string): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    try {
      rmSync(this.#connectionPath(slackUserId), { force: true });
      return { ok: true, value: undefined };
    } catch {
      return failure("storage", "unavailable");
    }
  }

  #pruneExpiredTransientRecords(): GwsOAuthResult<void> {
    if (!this.#config.ok) return this.#config;
    const now = this.#now();
    const transientStores: ReadonlyArray<{
      directory: string;
      schema: z.ZodType<{ expiresAtMs: number }>;
    }> = [
      {
        directory: join(this.#config.value.storageDir, "requests"),
        schema: PendingRequestSchema,
      },
      {
        directory: join(this.#config.value.storageDir, "states"),
        schema: StateBindingSchema,
      },
      {
        directory: join(this.#config.value.storageDir, "commands"),
        schema: PendingCommandSchema,
      },
      {
        directory: join(this.#config.value.storageDir, "continuations"),
        schema: ContinuationSchema,
      },
    ];
    for (const store of transientStores) {
      let names: string[];
      try {
        names = readdirSync(store.directory).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(store.directory, name);
        const record = this.#readEncrypted(path, store.schema);
        // Minimal encrypted dispatch tombstones retain negative authority after expiry.
        // Otherwise pruning could authorize a resumed trigger under a different future account.
        if (store.directory === join(this.#config.value.storageDir, "continuations") && record.ok) {
          const continuation = ContinuationSchema.safeParse(record.value);
          if (
            continuation.success &&
            continuation.data.status === "acked" &&
            continuation.data.dispatchTriggerId
          )
            continue;
        }
        if (record.ok && record.value.expiresAtMs <= now) {
          try {
            rmSync(path, { force: true });
          } catch {
            return failure("storage", "unavailable");
          }
        }
      }
    }
    return { ok: true, value: undefined };
  }

  #markRequestFailed(
    request: Extract<PendingRequest, { phase: "authorization_started" | "exchanging" }>,
  ): void {
    this.#writeEncrypted(this.#requestPath(request.requestId), {
      version: 1,
      requestId: request.requestId,
      phase: "failed",
      owner: request.owner,
      createdAtMs: request.createdAtMs,
      expiresAtMs: request.expiresAtMs,
    } satisfies PendingRequest);
  }

  async #exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<GwsOAuthResult<{ accessToken: Redacted<string>; refreshToken?: Redacted<string> }>> {
    const config = this.#config.ok ? this.#config.value : undefined;
    if (!config) return failure("configuration", "unavailable");
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret.reveal(),
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    });
    const response = await safeFetch(this.#fetch, this.#tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return failure("oauth", "provider_rejected", response.value.status);
    }
    const parsed = await parseJsonResponse(response.value, TokenResponseSchema);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: {
        accessToken: new Redacted(parsed.value.access_token),
        ...(parsed.value.refresh_token
          ? { refreshToken: new Redacted(parsed.value.refresh_token) }
          : {}),
      },
    };
  }

  async #refreshAccessToken(
    refreshToken: Redacted<string>,
  ): Promise<GwsOAuthResult<Redacted<string>>> {
    const config = this.#config.ok ? this.#config.value : undefined;
    if (!config) return failure("configuration", "unavailable");
    const response = await safeFetch(this.#fetch, this.#tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret.reveal(),
        refresh_token: refreshToken.reveal(),
        grant_type: "refresh_token",
      }),
      redirect: "manual",
    });
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      // Only the trusted refresh endpoint's structured invalid_grant response
      // establishes revoked credentials. CLI stderr and other failures do not.
      if (response.value.status === 400 || response.value.status === 401) {
        const rejection = await parseJsonResponse(response.value, z.object({ error: z.string() }));
        if (rejection.ok && rejection.value.error === "invalid_grant") {
          return failure("token", "credentials_revoked", response.value.status);
        }
      }
      return failure("token", "provider_rejected", response.value.status);
    }
    const parsed = await parseJsonResponse(response.value, TokenResponseSchema);
    if (!parsed.ok) return parsed;
    return { ok: true, value: new Redacted(parsed.value.access_token) };
  }

  async #loadUserInfo(
    accessToken: Redacted<string>,
  ): Promise<GwsOAuthResult<z.infer<typeof UserInfoSchema>>> {
    const response = await safeFetch(this.#fetch, this.#userInfoEndpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken.reveal()}` },
      redirect: "manual",
    });
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return failure("identity", "provider_rejected", response.value.status);
    }
    return parseJsonResponse(response.value, UserInfoSchema);
  }

  #readRequest(requestId: string): GwsOAuthResult<PendingRequest> {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(requestId)) return failure("request", "not_found");
    const request = this.#readEncrypted(this.#requestPath(requestId), PendingRequestSchema);
    if (
      request.ok &&
      (!this.#config.ok || request.value.owner.slackTeamId !== this.#config.value.slackTeamId)
    )
      return failure("identity", "identity_mismatch");
    return request;
  }

  #readConnection(slackUserId: string): GwsOAuthResult<Connection> {
    const result = this.#readEncrypted(this.#connectionPath(slackUserId), ConnectionSchema);
    if (!result.ok && result.error.code === "not_found") {
      return failure("identity", "connection_missing");
    }
    if (!result.ok) return failure("storage", "connection_invalid");
    return result;
  }

  #requestPath(requestId: string): string {
    const config = this.#config.ok ? this.#config.value : undefined;
    return join(config?.storageDir ?? "/invalid", "requests", `${requestId}.json`);
  }

  #statePath(state: string): string {
    const config = this.#config.ok ? this.#config.value : undefined;
    return join(config?.storageDir ?? "/invalid", "states", `${sha256Hex(state)}.json`);
  }

  #connectionPath(slackUserId: string): string {
    const config = this.#config.ok ? this.#config.value : undefined;
    const ownerKey = sha256Hex(`${config?.slackTeamId ?? ""}\0${slackUserId}`);
    return join(config?.storageDir ?? "/invalid", "connections", `${ownerKey}.json`);
  }

  #continuationPath(id: string): string {
    const config = this.#config.ok ? this.#config.value : undefined;
    return join(config?.storageDir ?? "/invalid", "continuations", `${id}.json`);
  }

  #commandPath(actionId: string): string {
    const config = this.#config.ok ? this.#config.value : undefined;
    return join(config?.storageDir ?? "/invalid", "commands", `${sha256Hex(actionId)}.json`);
  }

  #writeEncrypted(path: string, value: unknown): GwsOAuthResult<void> {
    const config = this.#config.ok ? this.#config.value : undefined;
    if (!config) return failure("configuration", "unavailable");
    try {
      const iv = this.#randomBytes(AES_GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", config.encryptionKey.reveal(), iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      cipher.setAAD(encryptionContextForPath(path));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      const envelope = EncryptedEnvelopeSchema.parse({
        version: 1,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.${randomBase64Url(this.#randomBytes, 8)}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, path);
      return { ok: true, value: undefined };
    } catch {
      return failure("storage", "unavailable");
    }
  }

  #readEncrypted<T>(path: string, schema: z.ZodType<T>): GwsOAuthResult<T> {
    const config = this.#config.ok ? this.#config.value : undefined;
    if (!config) return failure("configuration", "unavailable");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return failure("storage", code === "ENOENT" ? "not_found" : "unavailable");
    }
    try {
      const envelope = EncryptedEnvelopeSchema.parse(JSON.parse(raw));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        config.encryptionKey.reveal(),
        Buffer.from(envelope.iv, "base64"),
        { authTagLength: AES_GCM_TAG_BYTES },
      );
      decipher.setAAD(encryptionContextForPath(path));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { ok: true, value: schema.parse(JSON.parse(plaintext)) };
    } catch {
      return failure("storage", "connection_invalid");
    }
  }
}

function parseGwsOAuthConfig(env: NodeJS.ProcessEnv): GwsOAuthResult<GwsOAuthConfig> {
  const scopes = (env.GOOGLE_WORKSPACE_OAUTH_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const parsed = ConfigInputSchema.safeParse({
    clientId: env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
    publicBaseUrl: env.GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL,
    scopes,
    encryptionKey: env.GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY,
    storageDir:
      env.GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR ?? "/var/lib/remote-cli/google-workspace-oauth",
    slackTeamId: env.SLACK_TEAM_ID,
  });
  if (!parsed.success) {
    const fields = Object.entries(OAUTH_SETTING_NAMES)
      .filter(([field]) => parsed.error.issues.some((issue) => issue.path[0] === field))
      .map(([, name]) => name);
    return configurationFailure(fields);
  }
  if (parsed.data.scopes.some((scope) => !GOOGLE_WORKSPACE_ALLOWED_SCOPES.has(scope)))
    return configurationFailure(["GOOGLE_WORKSPACE_OAUTH_SCOPES"]);

  let publicBaseUrl: URL;
  let encryptionKey: Buffer;
  try {
    publicBaseUrl = new URL(parsed.data.publicBaseUrl);
    encryptionKey = Buffer.from(parsed.data.encryptionKey, "base64");
  } catch {
    return configurationFailure([
      "GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL",
      "GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY",
    ]);
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(parsed.data.encryptionKey) || encryptionKey.length !== 32)
    return configurationFailure(["GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY"]);
  if (
    parsed.data.publicBaseUrl.endsWith("/") ||
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    return configurationFailure(["GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL"]);
  }
  const normalizedBase = new URL(publicBaseUrl.toString());
  normalizedBase.pathname = normalizedBase.pathname.replace(/\/+$/, "") || "/";
  const redirectUri = new URL("/google-workspace/oauth/callback", normalizedBase).toString();
  const scopesWithIdentity = [...new Set([...parsed.data.scopes, "openid", "email", "profile"])];
  return {
    ok: true,
    value: {
      clientId: parsed.data.clientId,
      clientSecret: new Redacted(parsed.data.clientSecret),
      publicBaseUrl: normalizedBase,
      redirectUri,
      scopes: scopesWithIdentity,
      encryptionKey: new Redacted(encryptionKey),
      storageDir: parsed.data.storageDir,
      slackTeamId: parsed.data.slackTeamId,
    },
  };
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<GwsOAuthResult<Response>> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return failure("oauth", "provider_rejected", response.status);
    }
    return { ok: true, value: response };
  } catch {
    return failure("oauth", "unavailable");
  }
}

async function parseJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<GwsOAuthResult<T>> {
  try {
    const body = await readBoundedResponseBody(response, OAUTH_RESPONSE_MAX_BYTES);
    if (!body.ok) return body;
    return { ok: true, value: schema.parse(JSON.parse(body.value)) };
  } catch {
    return failure("oauth", "invalid_provider_response", response.status);
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<GwsOAuthResult<string>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return failure("oauth", "invalid_provider_response", response.status);
  }
  if (!response.body) return { ok: true, value: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return failure("oauth", "invalid_provider_response", response.status);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return failure("oauth", "unavailable");
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return { ok: true, value: body };
}

function configurationFailure(fields: readonly OAuthSettingName[]): {
  readonly ok: false;
  readonly error: GwsOAuthError;
} {
  return { ok: false, error: new GwsOAuthError("configuration", "unavailable", undefined, fields) };
}

function failure(
  stage: GwsOAuthErrorStage,
  code: GwsOAuthError["code"],
  httpStatus?: number,
): { readonly ok: false; readonly error: GwsOAuthError } {
  return { ok: false, error: new GwsOAuthError(stage, code, httpStatus) };
}

function randomBase64Url(random: (size: number) => Buffer, size: number): string {
  return random(size).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encryptionContextForPath(path: string): Buffer {
  return Buffer.concat([ENCRYPTION_CONTEXT, Buffer.from("\0", "utf8"), Buffer.from(path, "utf8")]);
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
