import { z } from "zod";
import { loadDrataEnv } from "@thor/common";
import type { DrataApiRequest } from "./drata-args.js";

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const TokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().nonnegative().optional(),
});

// Keep OAuth secrets out of accidental JSON/log serialization; reveal at I/O only.
class Redacted<T> {
  #value: T;
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

/** Safe diagnostics for configuration, OAuth, and transport failures. */
export class DrataError extends Error {
  /** Stable error classification; messages never include OAuth response bodies. */
  readonly _tag = "DrataError" as const;

  constructor(
    /** Failure stage used by the HTTP boundary, not inferred from message text. */
    readonly stage: "configuration" | "destination" | "oauth" | "request",
    /** Upstream HTTP status when one exists. */
    readonly httpStatus?: number,
  ) {
    super(
      `Drata integration failed: ${stage}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`,
    );
  }
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DrataError };
type DrataResponse = { readonly status: number; readonly body: unknown };
type Config = Omit<ReturnType<typeof loadDrataEnv>, "clientSecret" | "apiBaseUrl"> & {
  readonly clientSecret: Redacted<string>;
  readonly apiBaseUrl: URL;
};

/** Authenticated API access with authorization delegated to Drata. */
export interface IDrataService {
  /** API errors are responses; configuration/transport failures are typed errors. */
  execute(request: DrataApiRequest): Promise<Result<DrataResponse>>;
}

/** Owns the configured API destination and per-instance OAuth token cache. */
export class DrataService implements IDrataService {
  private readonly config: Result<Config>;
  private token: { value: Redacted<string>; expiresAtMs: number } | undefined;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const loaded = loadDrataEnv(env);
      const apiBaseUrl = new URL(loaded.apiBaseUrl);
      const tokenUrl = new URL(loaded.tokenUrl);
      if (
        [apiBaseUrl, tokenUrl].some(
          (url) => !["https:", "http:"].includes(url.protocol) || url.username || url.password,
        )
      ) {
        this.config = { ok: false, error: new DrataError("configuration") };
      } else {
        this.config = {
          ok: true,
          value: { ...loaded, apiBaseUrl, clientSecret: new Redacted(loaded.clientSecret) },
        };
      }
    } catch {
      this.config = { ok: false, error: new DrataError("configuration") };
    }
  }

  /** Forward the method/body without an operation allowlist; never follow API redirects. */
  async execute(request: DrataApiRequest): Promise<Result<DrataResponse>> {
    if (!this.config.ok) return this.config;
    const config = this.config.value;
    let target: URL;
    try {
      target = new URL(request.path, config.apiBaseUrl);
    } catch {
      return { ok: false, error: new DrataError("destination") };
    }
    if (target.origin !== config.apiBaseUrl.origin || target.username || target.password) {
      return { ok: false, error: new DrataError("destination") };
    }
    const token = await this.accessToken(config);
    if (!token.ok) return token;
    try {
      const response = await fetch(target, {
        method: request.method,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token.value.reveal()}`,
          Accept: "application/json",
          ...(request.json !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(request.json !== undefined ? { body: JSON.stringify(request.json) } : {}),
      });
      const text = await response.text();
      let body: unknown = text || null;
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          /* Preserve non-JSON API responses. */
        }
      }
      return { ok: true, value: { status: response.status, body } };
    } catch {
      return { ok: false, error: new DrataError("request") };
    }
  }

  private async accessToken(config: Config): Promise<Result<Redacted<string>>> {
    if (this.token && this.token.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > this.now()) {
      return { ok: true, value: this.token.value };
    }
    try {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret.reveal(),
          audience: config.audience,
          grant_type: "client_credentials",
          scope: config.scopes,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, error: new DrataError("oauth", response.status) };
      }
      const body: unknown = await response.json();
      const parsed = TokenSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: new DrataError("oauth", response.status) };
      const value = new Redacted(parsed.data.access_token);
      this.token = { value, expiresAtMs: this.now() + (parsed.data.expires_in ?? 3600) * 1000 };
      return { ok: true, value };
    } catch {
      return { ok: false, error: new DrataError("oauth") };
    }
  }
}
