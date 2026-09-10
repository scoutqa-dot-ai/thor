export class BrokerConfigurationError extends Error {
  readonly _tag = "BrokerConfigurationError" as const;
  readonly code: "missing_token" | "missing_policy" | "invalid_policy";

  constructor(code: BrokerConfigurationError["code"]) {
    super(`1Password browser broker configuration is invalid (${code})`);
    this.code = code;
  }
}

export class BrokerRequestDeniedError extends Error {
  readonly _tag = "BrokerRequestDeniedError" as const;
  readonly code: "item_not_allowed" | "origin_not_allowed" | "invalid_origin";

  constructor(code: BrokerRequestDeniedError["code"]) {
    super(`1Password browser broker denied the request (${code})`);
    this.code = code;
  }
}

export class OnePasswordAccessError extends Error {
  readonly _tag = "OnePasswordAccessError" as const;
  readonly code: "unavailable" | "item_invalid" | "credential_invalid";

  constructor(code: OnePasswordAccessError["code"]) {
    super(`1Password browser broker could not load the approved login (${code})`);
    this.code = code;
  }
}

export class BrowserLoginError extends Error {
  readonly _tag = "BrowserLoginError" as const;
  readonly code:
    | "browser_unavailable"
    | "origin_changed"
    | "field_missing_or_ambiguous"
    | "authentication_not_confirmed"
    | "browser_flow_failed";

  constructor(code: BrowserLoginError["code"]) {
    super(`1Password browser broker could not complete login (${code})`);
    this.code = code;
  }
}

export type BrokerError = BrokerRequestDeniedError | OnePasswordAccessError | BrowserLoginError;
