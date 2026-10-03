import { randomUUID } from "node:crypto";

import {
  parseBrowserElementRef,
  parseBrowserSessionId,
  parseBrowserSnapshotId,
  type IAuthenticatedBrowserSessions,
  type SanitizedAccessibilityValue,
} from "./authenticated-browser.ts";
import type { BrowserLoginRoute } from "./browser-login-route.ts";
import {
  parseBrowserLoginPlanId,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  type BrowserLoginPlanId,
  type BrowserOrigin,
  type OnePasswordVaultId,
} from "./config.ts";
import type { ILoginCredentialReader, LoginItemMetadata } from "./credential-reader.ts";
import { BrokerRequestDeniedError, type BrokerError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

const DEFAULT_LOGIN_PLAN_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_LOGIN_PLANS = 64;

/** Safe exact-origin Login choice returned without fetching item fields. */
export interface LoginItemMetadataOutput {
  readonly item_id: string;
  readonly title: string;
  readonly origin: string;
}

/** Safe result of matching Login items in the dedicated vault. */
export interface FindLoginItemsOutput {
  readonly login_plan_id: string;
  readonly application_origin: string;
  readonly credential_origin: string;
  readonly callback_origin: string;
  readonly matches: ReadonlyArray<LoginItemMetadataOutput>;
}

/** Safe approval context resolved from trusted broker state rather than model-supplied origins. */
export interface LoginPlanApprovalOutput {
  readonly login_plan_id: string;
  readonly item_id: string;
  readonly title: string;
  readonly application_origin: string;
  readonly credential_origin: string;
  readonly callback_origin: string;
}

/** Safe handle returned after approved credential injection succeeds. */
export interface OpenAuthenticatedBrowserOutput {
  readonly status: "authenticated";
  readonly browser_session_id: string;
  readonly item_id: string;
  readonly vault_id: string;
  readonly origin: string;
}

/** Safe accessibility state returned by the broker-owned browser. */
export interface BrowserSnapshotOutput {
  readonly browser_session_id: string;
  readonly snapshot_id: string;
  readonly origin: string;
  readonly title: string;
  readonly accessibility: SanitizedAccessibilityValue;
}

/** Safe location returned after a restricted browser action. */
export interface BrowserActionOutput {
  readonly status: "ready";
  readonly browser_session_id: string;
  readonly origin: string;
}

/** Safe result confirming that browser resources were destroyed. */
export interface BrowserCloseOutput {
  readonly status: "closed";
  readonly browser_session_id: string;
}

interface PendingLoginPlan {
  readonly id: BrowserLoginPlanId;
  readonly ownerSessionId: string;
  readonly route: BrowserLoginRoute;
  readonly expiresAtMs: number;
  selectedItemId?: string;
  selectedTitle?: string;
}

/** Minimal structured event emitted without item values, browser content, or raw causes. */
export interface BrokerAuditEvent {
  readonly timestamp: string;
  readonly action:
    | "find_login_items"
    | "browser_open_authenticated"
    | "browser_snapshot"
    | "browser_click"
    | "browser_type"
    | "browser_navigate"
    | "browser_close";
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly vault_id: string;
  readonly origin?: string;
  readonly item_id?: string;
  readonly browser_session_id?: string;
  readonly session_id: string;
  readonly error_code?: string;
}

/** Sink for allowlisted credential-browser audit events. */
export interface BrokerAuditSink {
  /** Persist or emit one event that has already crossed the safe audit projection. */
  record(event: BrokerAuditEvent): void;
}

/** Application service exposed to the strict MCP adapter. */
export interface ICredentialBroker {
  /** Find safe Login metadata for one exact HTTPS website origin. */
  findLoginItems(input: {
    readonly url: string;
    readonly sessionId: string;
  }): Promise<Result<FindLoginItemsOutput, BrokerError>>;
  /** Resolve safe, broker-observed approval context and bind one item to the plan. */
  resolveLoginPlan(input: {
    readonly loginPlanId: string;
    readonly itemId: string;
    readonly sessionId: string;
  }): Promise<Result<LoginPlanApprovalOutput, BrokerError>>;

  /** Revalidate an approved item and open a broker-owned authenticated browser. */
  openAuthenticatedBrowser(input: {
    readonly loginPlanId: string;
    readonly itemId: string;
    readonly approvedTitle: string;
    readonly automateTotp: boolean;
    readonly sessionId: string;
  }): Promise<Result<OpenAuthenticatedBrowserOutput, BrokerError>>;

  /** Return a bounded, credential-redacted accessibility snapshot. */
  snapshotBrowser(input: {
    readonly browserSessionId: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserSnapshotOutput, BrokerError>>;

  /** Click one ref issued by the latest browser snapshot. */
  clickBrowser(input: {
    readonly browserSessionId: string;
    readonly snapshotId: string;
    readonly ref: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>>;

  /** Fill one ordinary non-secret control without echoing the supplied text. */
  typeInBrowser(input: {
    readonly browserSessionId: string;
    readonly snapshotId: string;
    readonly ref: string;
    readonly text: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>>;

  /** Navigate an authenticated browser within its exact approved origin. */
  navigateBrowser(input: {
    readonly browserSessionId: string;
    readonly url: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>>;

  /** Destroy one authenticated browser owned by the requesting Neo session. */
  closeBrowser(input: {
    readonly browserSessionId: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserCloseOutput, BrokerError>>;

  /** Destroy all browsers when the broker process disconnects or terminates. */
  closeAllBrowsers(): Promise<void>;
}

type BrokerRefActionInput =
  | {
      readonly action: "browser_click";
      readonly browserSessionId: string;
      readonly snapshotId: string;
      readonly ref: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "browser_type";
      readonly browserSessionId: string;
      readonly snapshotId: string;
      readonly ref: string;
      readonly text: string;
      readonly sessionId: string;
    };

function projectLoginMetadata(metadata: LoginItemMetadata): LoginItemMetadataOutput {
  return {
    item_id: metadata.itemId,
    title: metadata.title,
    origin: metadata.origin,
  };
}

function classifyOutcome(error: BrokerError): "denied" | "failed" {
  return error instanceof BrokerRequestDeniedError ? "denied" : "failed";
}

/** Coordinates exact-origin item policy, credential retrieval, browser sessions, and audit order. */
export class CredentialBroker implements ICredentialBroker {
  readonly #vaultId: OnePasswordVaultId;
  readonly #credentialReader: ILoginCredentialReader;
  readonly #browserSessions: IAuthenticatedBrowserSessions;
  readonly #auditSink: BrokerAuditSink;
  readonly #now: () => Date;
  readonly #createLoginPlanId: () => string;
  readonly #loginPlanTtlMs: number;
  readonly #maxLoginPlans: number;
  readonly #loginPlans = new Map<BrowserLoginPlanId, PendingLoginPlan>();
  readonly #ownerLoginPlans = new Map<string, BrowserLoginPlanId>();

  /** Create the application service from its scoped credential and browser capabilities. */
  constructor(input: {
    readonly vaultId: OnePasswordVaultId;
    readonly credentialReader: ILoginCredentialReader;
    readonly browserSessions: IAuthenticatedBrowserSessions;
    readonly auditSink: BrokerAuditSink;
    readonly now?: () => Date;
    readonly createLoginPlanId?: () => string;
    readonly loginPlanTtlMs?: number;
    readonly maxLoginPlans?: number;
  }) {
    this.#vaultId = input.vaultId;
    this.#credentialReader = input.credentialReader;
    this.#browserSessions = input.browserSessions;
    this.#auditSink = input.auditSink;
    this.#now = input.now ?? (() => new Date());
    this.#createLoginPlanId = input.createLoginPlanId ?? randomUUID;
    this.#loginPlanTtlMs = input.loginPlanTtlMs ?? DEFAULT_LOGIN_PLAN_TTL_MS;
    this.#maxLoginPlans = input.maxLoginPlans ?? DEFAULT_MAX_LOGIN_PLANS;
    if (this.#loginPlanTtlMs < 1_000 || this.#maxLoginPlans < 1) {
      throw new Error("Credential broker login plan options violate minimum bounds");
    }
  }

  #record(input: {
    readonly action: BrokerAuditEvent["action"];
    readonly outcome: BrokerAuditEvent["outcome"];
    readonly sessionId: string;
    readonly origin?: BrowserOrigin;
    readonly itemId?: string;
    readonly browserSessionId?: string;
    readonly errorCode?: string;
  }): void {
    this.#auditSink.record({
      timestamp: this.#now().toISOString(),
      action: input.action,
      outcome: input.outcome,
      vault_id: this.#vaultId,
      session_id: input.sessionId,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.itemId ? { item_id: input.itemId } : {}),
      ...(input.browserSessionId ? { browser_session_id: input.browserSessionId } : {}),
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
    });
  }

  #removeLoginPlan(plan: PendingLoginPlan): void {
    this.#loginPlans.delete(plan.id);
    if (this.#ownerLoginPlans.get(plan.ownerSessionId) === plan.id) {
      this.#ownerLoginPlans.delete(plan.ownerSessionId);
    }
  }

  #pruneExpiredLoginPlans(): void {
    const nowMs = this.#now().getTime();
    for (const plan of this.#loginPlans.values()) {
      if (plan.expiresAtMs <= nowMs) this.#removeLoginPlan(plan);
    }
  }

  #createLoginPlan(
    ownerSessionId: string,
    route: BrowserLoginRoute,
  ): Result<PendingLoginPlan, BrokerRequestDeniedError> {
    this.#pruneExpiredLoginPlans();
    const previousId = this.#ownerLoginPlans.get(ownerSessionId);
    const previous = previousId ? this.#loginPlans.get(previousId) : undefined;
    if (previous) this.#removeLoginPlan(previous);
    if (this.#loginPlans.size >= this.#maxLoginPlans) {
      return err(new BrokerRequestDeniedError("session_limit_reached"));
    }
    const id = parseBrowserLoginPlanId(this.#createLoginPlanId());
    if (!id || this.#loginPlans.has(id)) {
      throw new Error("Credential broker login plan ID generator returned an invalid UUID");
    }
    const plan: PendingLoginPlan = {
      id,
      ownerSessionId,
      route,
      expiresAtMs: this.#now().getTime() + this.#loginPlanTtlMs,
    };
    this.#loginPlans.set(id, plan);
    this.#ownerLoginPlans.set(ownerSessionId, id);
    return ok(plan);
  }

  #getLoginPlan(
    loginPlanId: string,
    ownerSessionId: string,
  ): Result<PendingLoginPlan, BrokerRequestDeniedError> {
    const id = parseBrowserLoginPlanId(loginPlanId);
    if (!id) return err(new BrokerRequestDeniedError("login_plan_not_found"));
    this.#pruneExpiredLoginPlans();
    const plan = this.#loginPlans.get(id);
    if (!plan) return err(new BrokerRequestDeniedError("login_plan_not_found"));
    if (plan.ownerSessionId !== ownerSessionId) {
      return err(new BrokerRequestDeniedError("login_plan_owner_mismatch"));
    }
    return ok(plan);
  }

  /** Find only safe overview metadata after credential-free login-route discovery. */
  async findLoginItems(input: {
    readonly url: string;
    readonly sessionId: string;
  }): Promise<Result<FindLoginItemsOutput, BrokerError>> {
    const destination = parseBrowserDestinationUrl(input.url);
    if (destination._tag === "err") {
      this.#record({
        action: "find_login_items",
        outcome: "denied",
        sessionId: input.sessionId,
        errorCode: destination.error.code,
      });
      return destination;
    }

    const discovered = await this.#browserSessions.discoverLoginRoute({
      ownerSessionId: input.sessionId,
      destination: destination.value,
    });
    if (discovered._tag === "err") {
      this.#record({
        action: "find_login_items",
        outcome: classifyOutcome(discovered.error),
        sessionId: input.sessionId,
        origin: destination.value.origin,
        errorCode: discovered.error.code,
      });
      return discovered;
    }

    const matches = await this.#credentialReader.findLoginItems(discovered.value.credentialOrigin);
    if (matches._tag === "err") {
      this.#record({
        action: "find_login_items",
        outcome: "failed",
        sessionId: input.sessionId,
        origin: destination.value.origin,
        errorCode: matches.error.code,
      });
      return matches;
    }
    const created = this.#createLoginPlan(input.sessionId, discovered.value);
    if (created._tag === "err") {
      this.#record({
        action: "find_login_items",
        outcome: "denied",
        sessionId: input.sessionId,
        origin: destination.value.origin,
        errorCode: created.error.code,
      });
      return created;
    }

    this.#record({
      action: "find_login_items",
      outcome: "succeeded",
      sessionId: input.sessionId,
      origin: destination.value.origin,
    });
    return ok({
      login_plan_id: created.value.id,
      application_origin: discovered.value.application.origin,
      credential_origin: discovered.value.credentialOrigin,
      callback_origin: discovered.value.application.origin,
      matches: matches.value.map(projectLoginMetadata),
    });
  }

  /** Resolve a trusted approval projection and bind one selected item to the login plan. */
  async resolveLoginPlan(input: {
    readonly loginPlanId: string;
    readonly itemId: string;
    readonly sessionId: string;
  }): Promise<Result<LoginPlanApprovalOutput, BrokerError>> {
    const planResult = this.#getLoginPlan(input.loginPlanId, input.sessionId);
    const itemId = parseOnePasswordItemId(input.itemId);
    if (planResult._tag === "err" || !itemId) {
      return planResult._tag === "err"
        ? planResult
        : err(new BrokerRequestDeniedError("item_not_allowed"));
    }
    const plan = planResult.value;
    if (plan.selectedItemId && plan.selectedItemId !== itemId) {
      return err(new BrokerRequestDeniedError("item_not_allowed"));
    }
    const matches = await this.#credentialReader.findLoginItems(plan.route.credentialOrigin);
    if (matches._tag === "err") return matches;
    const selected = matches.value.filter((metadata) => metadata.itemId === itemId);
    if (selected.length !== 1) return err(new BrokerRequestDeniedError("item_not_allowed"));
    const metadata = selected[0];
    if (!metadata) return err(new BrokerRequestDeniedError("item_not_allowed"));
    if (plan.selectedTitle && plan.selectedTitle !== metadata.title) {
      return err(new BrokerRequestDeniedError("item_not_allowed"));
    }
    plan.selectedItemId = itemId;
    plan.selectedTitle = metadata.title;
    return ok({
      login_plan_id: plan.id,
      item_id: itemId,
      title: metadata.title,
      application_origin: plan.route.application.origin,
      credential_origin: plan.route.credentialOrigin,
      callback_origin: plan.route.application.origin,
    });
  }

  /** Consume an approved plan before loading credential-bearing fields or dispatching a browser. */
  async openAuthenticatedBrowser(input: {
    readonly loginPlanId: string;
    readonly itemId: string;
    readonly approvedTitle: string;
    readonly automateTotp: boolean;
    readonly sessionId: string;
  }): Promise<Result<OpenAuthenticatedBrowserOutput, BrokerError>> {
    const planResult = this.#getLoginPlan(input.loginPlanId, input.sessionId);
    const itemId = parseOnePasswordItemId(input.itemId);
    const approvedTitle = input.approvedTitle.trim();
    if (planResult._tag === "err" || !itemId || !approvedTitle || approvedTitle.length > 200) {
      const denied =
        planResult._tag === "err"
          ? planResult.error
          : new BrokerRequestDeniedError("item_not_allowed");
      this.#record({
        action: "browser_open_authenticated",
        outcome: "denied",
        sessionId: input.sessionId,
        ...(itemId ? { itemId } : {}),
        errorCode: denied.code,
      });
      return err(denied);
    }
    const plan = planResult.value;
    if (plan.selectedItemId !== itemId || plan.selectedTitle !== approvedTitle) {
      const denied = new BrokerRequestDeniedError("item_not_allowed");
      this.#record({
        action: "browser_open_authenticated",
        outcome: "denied",
        sessionId: input.sessionId,
        origin: plan.route.application.origin,
        itemId,
        errorCode: denied.code,
      });
      return err(denied);
    }

    this.#removeLoginPlan(plan);
    const credentials = await this.#credentialReader.getLoginCredentials({
      itemId,
      origin: plan.route.credentialOrigin,
      approvedTitle,
      automateTotp: input.automateTotp,
    });
    if (credentials._tag === "err") {
      this.#record({
        action: "browser_open_authenticated",
        outcome: "failed",
        sessionId: input.sessionId,
        origin: plan.route.application.origin,
        itemId,
        errorCode: credentials.error.code,
      });
      return credentials;
    }

    const opened = await this.#browserSessions.openAuthenticatedBrowser({
      ownerSessionId: input.sessionId,
      route: plan.route,
      credentials: credentials.value,
    });
    if (opened._tag === "err") {
      this.#record({
        action: "browser_open_authenticated",
        outcome: classifyOutcome(opened.error),
        sessionId: input.sessionId,
        origin: plan.route.application.origin,
        itemId,
        errorCode: opened.error.code,
      });
      return opened;
    }

    this.#record({
      action: "browser_open_authenticated",
      outcome: "succeeded",
      sessionId: input.sessionId,
      origin: opened.value.origin,
      itemId,
      browserSessionId: opened.value.browserSessionId,
    });
    return ok({
      status: "authenticated",
      browser_session_id: opened.value.browserSessionId,
      item_id: itemId,
      vault_id: this.#vaultId,
      origin: opened.value.origin,
    });
  }

  /** Snapshot one browser after validating the opaque session ID and owner. */
  async snapshotBrowser(input: {
    readonly browserSessionId: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserSnapshotOutput, BrokerError>> {
    const browserSessionId = parseBrowserSessionId(input.browserSessionId);
    if (!browserSessionId) {
      const denied = new BrokerRequestDeniedError("session_not_found");
      this.#record({
        action: "browser_snapshot",
        outcome: "denied",
        sessionId: input.sessionId,
        errorCode: denied.code,
      });
      return err(denied);
    }
    const snapshot = await this.#browserSessions.snapshotBrowser({
      ownerSessionId: input.sessionId,
      browserSessionId,
    });
    if (snapshot._tag === "err") {
      this.#record({
        action: "browser_snapshot",
        outcome: classifyOutcome(snapshot.error),
        sessionId: input.sessionId,
        browserSessionId,
        errorCode: snapshot.error.code,
      });
      return snapshot;
    }
    this.#record({
      action: "browser_snapshot",
      outcome: "succeeded",
      sessionId: input.sessionId,
      origin: snapshot.value.origin,
      browserSessionId,
    });
    return ok({
      browser_session_id: browserSessionId,
      snapshot_id: snapshot.value.snapshotId,
      origin: snapshot.value.origin,
      title: snapshot.value.title,
      accessibility: snapshot.value.accessibility,
    });
  }

  async #withRefAction(
    input: BrokerRefActionInput,
  ): Promise<Result<BrowserActionOutput, BrokerError>> {
    const browserSessionId = parseBrowserSessionId(input.browserSessionId);
    const snapshotId = parseBrowserSnapshotId(input.snapshotId);
    const ref = parseBrowserElementRef(input.ref);
    if (!browserSessionId || !snapshotId || !ref) {
      const denied = new BrokerRequestDeniedError("ref_not_allowed");
      this.#record({
        action: input.action,
        outcome: "denied",
        sessionId: input.sessionId,
        ...(browserSessionId ? { browserSessionId } : {}),
        errorCode: denied.code,
      });
      return err(denied);
    }

    const actionResult =
      input.action === "browser_click"
        ? await this.#browserSessions.clickBrowserRef({
            ownerSessionId: input.sessionId,
            browserSessionId,
            snapshotId,
            ref,
          })
        : await this.#browserSessions.typeIntoBrowserRef({
            ownerSessionId: input.sessionId,
            browserSessionId,
            snapshotId,
            ref,
            text: input.text,
          });
    if (actionResult._tag === "err") {
      this.#record({
        action: input.action,
        outcome: classifyOutcome(actionResult.error),
        sessionId: input.sessionId,
        browserSessionId,
        errorCode: actionResult.error.code,
      });
      return actionResult;
    }
    this.#record({
      action: input.action,
      outcome: "succeeded",
      sessionId: input.sessionId,
      origin: actionResult.value.origin,
      browserSessionId,
    });
    return ok({
      status: "ready",
      browser_session_id: browserSessionId,
      origin: actionResult.value.origin,
    });
  }

  /** Click one current accessibility ref; the ref becomes stale before the click begins. */
  async clickBrowser(input: {
    readonly browserSessionId: string;
    readonly snapshotId: string;
    readonly ref: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>> {
    return this.#withRefAction({ action: "browser_click", ...input });
  }

  /** Fill one permitted control while excluding text from all outputs and audit events. */
  async typeInBrowser(input: {
    readonly browserSessionId: string;
    readonly snapshotId: string;
    readonly ref: string;
    readonly text: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>> {
    return this.#withRefAction({ action: "browser_type", ...input });
  }

  /** Navigate only after parsing a URL with the same strict destination grammar. */
  async navigateBrowser(input: {
    readonly browserSessionId: string;
    readonly url: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserActionOutput, BrokerError>> {
    const browserSessionId = parseBrowserSessionId(input.browserSessionId);
    const destination = parseBrowserDestinationUrl(input.url);
    if (!browserSessionId || destination._tag === "err") {
      const denied =
        destination._tag === "err"
          ? destination.error
          : new BrokerRequestDeniedError("session_not_found");
      this.#record({
        action: "browser_navigate",
        outcome: "denied",
        sessionId: input.sessionId,
        ...(browserSessionId ? { browserSessionId } : {}),
        errorCode: denied.code,
      });
      return err(denied);
    }

    const navigated = await this.#browserSessions.navigateBrowser({
      ownerSessionId: input.sessionId,
      browserSessionId,
      destination: destination.value,
    });
    if (navigated._tag === "err") {
      this.#record({
        action: "browser_navigate",
        outcome: classifyOutcome(navigated.error),
        sessionId: input.sessionId,
        browserSessionId,
        errorCode: navigated.error.code,
      });
      return navigated;
    }
    this.#record({
      action: "browser_navigate",
      outcome: "succeeded",
      sessionId: input.sessionId,
      origin: navigated.value.origin,
      browserSessionId,
    });
    return ok({
      status: "ready",
      browser_session_id: browserSessionId,
      origin: navigated.value.origin,
    });
  }

  /** Close a browser after owner validation and return no page/session contents. */
  async closeBrowser(input: {
    readonly browserSessionId: string;
    readonly sessionId: string;
  }): Promise<Result<BrowserCloseOutput, BrokerError>> {
    const browserSessionId = parseBrowserSessionId(input.browserSessionId);
    if (!browserSessionId) {
      const denied = new BrokerRequestDeniedError("session_not_found");
      this.#record({
        action: "browser_close",
        outcome: "denied",
        sessionId: input.sessionId,
        errorCode: denied.code,
      });
      return err(denied);
    }
    const closed = await this.#browserSessions.closeBrowser({
      ownerSessionId: input.sessionId,
      browserSessionId,
    });
    if (closed._tag === "err") {
      this.#record({
        action: "browser_close",
        outcome: "denied",
        sessionId: input.sessionId,
        browserSessionId,
        errorCode: closed.error.code,
      });
      return closed;
    }
    this.#record({
      action: "browser_close",
      outcome: "succeeded",
      sessionId: input.sessionId,
      browserSessionId,
    });
    return ok({ status: "closed", browser_session_id: browserSessionId });
  }

  /** Delegate process-level browser cleanup to the resource-owning adapter. */
  async closeAllBrowsers(): Promise<void> {
    this.#loginPlans.clear();
    this.#ownerLoginPlans.clear();
    await this.#browserSessions.closeAllBrowsers();
  }
}

/** Audit sink that writes only the broker's explicit safe projection. */
export class StderrBrokerAuditSink implements BrokerAuditSink {
  /** Emit one JSON line containing only allowlisted IDs, origin, action, and outcome. */
  record(event: BrokerAuditEvent): void {
    process.stderr.write(`${JSON.stringify({ type: "onepassword_browser_audit", ...event })}\n`);
  }
}
