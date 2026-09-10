import type { BrowserLoginPolicy } from "./config.ts";
import { parseExpectedOrigin } from "./config.ts";
import type { ILoginCredentialReader, LoginMetadata } from "./credential-reader.ts";
import { BrokerRequestDeniedError, type BrokerError } from "./errors.ts";
import type { IBrowserLogin } from "./browser-login.ts";
import { err, ok, type Result } from "./result.ts";

export interface LoginMetadataOutput {
  readonly item_id: string;
  readonly vault_id: string;
  readonly title: string;
  readonly approved_origin: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}

export interface BrowserLoginOutput {
  readonly status: "authenticated";
  readonly item_id: string;
  readonly vault_id: string;
  readonly origin: string;
}

export interface BrokerAuditEvent {
  readonly timestamp: string;
  readonly action: "get_login_metadata" | "browser_login";
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly vault_id: string;
  readonly item_id: string;
  readonly origin: string;
  readonly session_id?: string;
  readonly error_code?: string;
}

export interface BrokerAuditSink {
  record(event: BrokerAuditEvent): void;
}

export interface ICredentialBroker {
  getLoginMetadata(input: {
    readonly itemId: string;
    readonly sessionId?: string;
  }): Promise<Result<LoginMetadataOutput, BrokerError>>;
  browserLogin(input: {
    readonly itemId: string;
    readonly expectedOrigin: string;
    readonly sessionId?: string;
  }): Promise<Result<BrowserLoginOutput, BrokerError>>;
}

function projectMetadata(metadata: LoginMetadata): LoginMetadataOutput {
  return {
    item_id: metadata.itemId,
    vault_id: metadata.vaultId,
    title: metadata.title,
    approved_origin: metadata.origin,
    fields: metadata.fields.map((field) => ({ name: field.name, type: field.type })),
  };
}

export class CredentialBroker implements ICredentialBroker {
  readonly #policy: BrowserLoginPolicy;
  readonly #credentialReader: ILoginCredentialReader;
  readonly #browserLogin: IBrowserLogin;
  readonly #auditSink: BrokerAuditSink;
  readonly #now: () => Date;

  constructor(input: {
    readonly policy: BrowserLoginPolicy;
    readonly credentialReader: ILoginCredentialReader;
    readonly browserLogin: IBrowserLogin;
    readonly auditSink: BrokerAuditSink;
    readonly now?: () => Date;
  }) {
    this.#policy = input.policy;
    this.#credentialReader = input.credentialReader;
    this.#browserLogin = input.browserLogin;
    this.#auditSink = input.auditSink;
    this.#now = input.now ?? (() => new Date());
  }

  #record(
    action: BrokerAuditEvent["action"],
    outcome: BrokerAuditEvent["outcome"],
    sessionId: string | undefined,
    errorCode?: string,
  ): void {
    this.#auditSink.record({
      timestamp: this.#now().toISOString(),
      action,
      outcome,
      vault_id: this.#policy.vaultId,
      item_id: this.#policy.itemId,
      origin: this.#policy.origin,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  async getLoginMetadata(input: {
    readonly itemId: string;
    readonly sessionId?: string;
  }): Promise<Result<LoginMetadataOutput, BrokerError>> {
    if (input.itemId !== this.#policy.itemId) {
      const denied = new BrokerRequestDeniedError("item_not_allowed");
      this.#record("get_login_metadata", "denied", input.sessionId, denied.code);
      return err(denied);
    }

    const metadata = await this.#credentialReader.getMetadata(this.#policy);
    if (metadata._tag === "err") {
      this.#record("get_login_metadata", "failed", input.sessionId, metadata.error.code);
      return metadata;
    }
    this.#record("get_login_metadata", "succeeded", input.sessionId);
    return ok(projectMetadata(metadata.value));
  }

  async browserLogin(input: {
    readonly itemId: string;
    readonly expectedOrigin: string;
    readonly sessionId?: string;
  }): Promise<Result<BrowserLoginOutput, BrokerError>> {
    if (input.itemId !== this.#policy.itemId) {
      const denied = new BrokerRequestDeniedError("item_not_allowed");
      this.#record("browser_login", "denied", input.sessionId, denied.code);
      return err(denied);
    }
    const expectedOrigin = parseExpectedOrigin(input.expectedOrigin);
    if (!expectedOrigin) {
      const denied = new BrokerRequestDeniedError("invalid_origin");
      this.#record("browser_login", "denied", input.sessionId, denied.code);
      return err(denied);
    }
    if (expectedOrigin !== this.#policy.origin) {
      const denied = new BrokerRequestDeniedError("origin_not_allowed");
      this.#record("browser_login", "denied", input.sessionId, denied.code);
      return err(denied);
    }

    const credentials = await this.#credentialReader.getCredentials(this.#policy);
    if (credentials._tag === "err") {
      this.#record("browser_login", "failed", input.sessionId, credentials.error.code);
      return credentials;
    }
    const login = await this.#browserLogin.login(this.#policy, credentials.value);
    if (login._tag === "err") {
      this.#record("browser_login", "failed", input.sessionId, login.error.code);
      return login;
    }

    this.#record("browser_login", "succeeded", input.sessionId);
    return ok({
      status: "authenticated",
      item_id: this.#policy.itemId,
      vault_id: this.#policy.vaultId,
      origin: this.#policy.origin,
    });
  }
}

export class StderrBrokerAuditSink implements BrokerAuditSink {
  record(event: BrokerAuditEvent): void {
    process.stderr.write(`${JSON.stringify({ type: "onepassword_browser_audit", ...event })}\n`);
  }
}
