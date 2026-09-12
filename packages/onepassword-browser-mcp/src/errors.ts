/** A known startup failure that can be rendered without revealing configuration values. */
export class BrokerConfigurationError extends Error {
  readonly _tag = "BrokerConfigurationError" as const;
  readonly code: "missing_token" | "missing_vault" | "invalid_vault";

  constructor(code: BrokerConfigurationError["code"]) {
    super(`1Password browser broker configuration is invalid (${code})`);
    this.code = code;
  }
}

/** A policy denial for an untrusted credential-browser request. */
export class BrokerRequestDeniedError extends Error {
  readonly _tag = "BrokerRequestDeniedError" as const;
  readonly code:
    | "invalid_destination"
    | "item_not_allowed"
    | "session_not_found"
    | "session_owner_mismatch"
    | "session_busy"
    | "session_limit_reached"
    | "stale_snapshot"
    | "ref_not_allowed"
    | "field_not_allowed"
    | "origin_not_allowed";

  constructor(code: BrokerRequestDeniedError["code"]) {
    super(`1Password browser broker denied the request (${code})`);
    this.code = code;
  }
}

/** A safely classified failure from the dedicated 1Password vault. */
export class OnePasswordAccessError extends Error {
  readonly _tag = "OnePasswordAccessError" as const;
  readonly code: "unavailable" | "item_invalid" | "credential_invalid";

  constructor(code: OnePasswordAccessError["code"]) {
    super(`1Password browser broker could not load an approved login (${code})`);
    this.code = code;
  }
}

/** A safely classified failure from the broker-owned browser. */
export class BrowserSessionError extends Error {
  readonly _tag = "BrowserSessionError" as const;
  readonly code:
    | "browser_unavailable"
    | "origin_changed"
    | "field_missing_or_ambiguous"
    | "authentication_not_confirmed"
    | "mfa_required"
    | "browser_flow_failed"
    | "snapshot_failed"
    | "snapshot_too_large"
    | "action_failed";

  constructor(code: BrowserSessionError["code"]) {
    super(`1Password browser broker could not operate the authenticated browser (${code})`);
    this.code = code;
  }
}

/** Every expected error returned through the credential broker MCP boundary. */
export type BrokerError = BrokerRequestDeniedError | OnePasswordAccessError | BrowserSessionError;
