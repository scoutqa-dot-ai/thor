import { describe, expect, it } from "vitest";
import {
  parseBrowserElementRef,
  parseBrowserSessionId,
  parseBrowserSnapshotId,
  type BrowserRefActionInput,
  type BrowserTypeInput,
  type IAuthenticatedBrowserSessions,
  type OpenAuthenticatedBrowserInput,
  type OwnedBrowserSessionInput,
} from "./authenticated-browser.ts";
import type { BrowserLoginRoute } from "./browser-login-route.ts";
import { CredentialBroker, type BrokerAuditEvent, type BrokerAuditSink } from "./broker.ts";
import {
  parseBrokerEnvironment,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";
import type {
  ILoginCredentialReader,
  LoginCredentialSelection,
  LoginCredentials,
  LoginItemMetadata,
} from "./credential-reader.ts";
import { BrowserSessionError, OnePasswordAccessError } from "./errors.ts";
import { RedactedString } from "./redacted.ts";
import { err, ok } from "./result.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = "https://accounts.example.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";
const SESSION_ID = "parent-session";
const BROWSER_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const LOGIN_PLAN_ID = "00000000-0000-4000-8000-000000000003";

function fixtures() {
  const environment = parseBrokerEnvironment(
    {
      OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
      ONEPASSWORD_BROWSER_VAULT_ID: VAULT_ID,
    },
    () => "ops_fixture_service_account_token",
  );
  const destination = parseBrowserDestinationUrl(`${ORIGIN}/dashboard`);
  const itemId = parseOnePasswordItemId(ITEM_ID);
  const browserSessionId = parseBrowserSessionId(BROWSER_SESSION_ID);
  const snapshotId = parseBrowserSnapshotId(SNAPSHOT_ID);
  const ref = parseBrowserElementRef("e7");
  if (
    environment._tag === "err" ||
    destination._tag === "err" ||
    !itemId ||
    !browserSessionId ||
    !snapshotId ||
    !ref
  ) {
    throw new Error("invalid broker fixture");
  }
  const metadata: LoginItemMetadata = {
    vaultId: environment.value.vaultId,
    itemId,
    title: "Example audit",
    origin: destination.value.origin,
    loginUrl:
      parseBrowserDestinationUrl(`${ORIGIN}/login`)._tag === "ok"
        ? parseBrowserDestinationUrl(`${ORIGIN}/login`).value.url
        : destination.value.url,
  };
  return {
    environment: environment.value,
    destination: destination.value,
    metadata,
    browserSessionId,
    snapshotId,
    ref,
  };
}

class RecordingAuditSink implements BrokerAuditSink {
  readonly events: BrokerAuditEvent[] = [];

  record(event: BrokerAuditEvent): void {
    this.events.push(event);
  }
}

class RecordingCredentialReader implements ILoginCredentialReader {
  readonly metadata = fixtures().metadata;
  findCalls = 0;
  credentialSelections: LoginCredentialSelection[] = [];
  result: "ok" | "error" = "ok";

  async findLoginItems() {
    this.findCalls += 1;
    return this.result === "ok"
      ? ok([this.metadata])
      : err(new OnePasswordAccessError("unavailable"));
  }

  async getLoginCredentials(selection: LoginCredentialSelection) {
    this.credentialSelections.push(selection);
    if (this.result === "error") return err(new OnePasswordAccessError("unavailable"));
    const credentials: LoginCredentials = {
      metadata: this.metadata,
      username: RedactedString.make(USERNAME),
      password: RedactedString.make(PASSWORD),
    };
    return ok(credentials);
  }
}

class RecordingBrowserSessions implements IAuthenticatedBrowserSessions {
  discoverInputs: Array<{
    ownerSessionId: string;
    destination: ReturnType<typeof fixtures>["destination"];
  }> = [];
  openInputs: OpenAuthenticatedBrowserInput[] = [];
  snapshotInputs: OwnedBrowserSessionInput[] = [];
  clickInputs: BrowserRefActionInput[] = [];
  typeInputs: BrowserTypeInput[] = [];
  navigateInputs: Array<
    OwnedBrowserSessionInput & { destination: ReturnType<typeof fixtures>["destination"] }
  > = [];
  closeInputs: OwnedBrowserSessionInput[] = [];
  closeAllCalls = 0;
  result: "ok" | "error" = "ok";

  async discoverLoginRoute(input: {
    ownerSessionId: string;
    destination: ReturnType<typeof fixtures>["destination"];
  }) {
    this.discoverInputs.push(input);
    if (this.result === "error") {
      return err(new BrowserSessionError("browser_flow_failed"));
    }
    const route: BrowserLoginRoute = {
      _tag: "same_origin",
      application: input.destination,
      credentialOrigin: input.destination.origin,
    };
    return ok(route);
  }

  async openAuthenticatedBrowser(input: OpenAuthenticatedBrowserInput) {
    this.openInputs.push(input);
    if (this.result === "error")
      return err(new BrowserSessionError("authentication_not_confirmed"));
    return ok({
      browserSessionId: fixtures().browserSessionId,
      origin: fixtures().destination.origin,
    });
  }

  async snapshotBrowser(input: OwnedBrowserSessionInput) {
    this.snapshotInputs.push(input);
    return ok({
      browserSessionId: fixtures().browserSessionId,
      snapshotId: fixtures().snapshotId,
      origin: fixtures().destination.origin,
      title: "Dashboard",
      accessibility: [{ role: "heading", name: "Dashboard", ref: "e7" }],
    });
  }

  async clickBrowserRef(input: BrowserRefActionInput) {
    this.clickInputs.push(input);
    return ok({
      browserSessionId: fixtures().browserSessionId,
      origin: fixtures().destination.origin,
    });
  }

  async typeIntoBrowserRef(input: BrowserTypeInput) {
    this.typeInputs.push(input);
    return ok({
      browserSessionId: fixtures().browserSessionId,
      origin: fixtures().destination.origin,
    });
  }

  async navigateBrowser(
    input: OwnedBrowserSessionInput & { destination: ReturnType<typeof fixtures>["destination"] },
  ) {
    this.navigateInputs.push(input);
    return ok({
      browserSessionId: fixtures().browserSessionId,
      origin: fixtures().destination.origin,
    });
  }

  async closeBrowser(input: OwnedBrowserSessionInput) {
    this.closeInputs.push(input);
    return ok({ status: "closed" as const });
  }

  async closeAllBrowsers(): Promise<void> {
    this.closeAllCalls += 1;
  }
}

function harness(options: { now?: () => Date } = {}) {
  const credentialReader = new RecordingCredentialReader();
  const browserSessions = new RecordingBrowserSessions();
  const auditSink = new RecordingAuditSink();
  const broker = new CredentialBroker({
    vaultId: fixtures().environment.vaultId,
    credentialReader,
    browserSessions,
    auditSink,
    now: options.now ?? (() => new Date("2026-09-12T00:00:00.000Z")),
    createLoginPlanId: () => LOGIN_PLAN_ID,
  });
  return { broker, credentialReader, browserSessions, auditSink };
}

async function prepareLogin(h: ReturnType<typeof harness>) {
  const found = await h.broker.findLoginItems({
    url: `${ORIGIN}/dashboard`,
    sessionId: SESSION_ID,
  });
  if (found._tag === "err") throw found.error;
  const resolved = await h.broker.resolveLoginPlan({
    loginPlanId: found.value.login_plan_id,
    itemId: ITEM_ID,
    sessionId: SESSION_ID,
  });
  if (resolved._tag === "err") throw resolved.error;
  return resolved.value;
}

describe("CredentialBroker Login discovery and opening", () => {
  it("returns only a safe owner-bound login plan and credential-origin metadata", async () => {
    const h = harness();
    const result = await h.broker.findLoginItems({
      url: `${ORIGIN}/dashboard`,
      sessionId: SESSION_ID,
    });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        login_plan_id: LOGIN_PLAN_ID,
        application_origin: ORIGIN,
        credential_origin: ORIGIN,
        callback_origin: ORIGIN,
        matches: [{ item_id: ITEM_ID, title: "Example audit", origin: ORIGIN }],
      },
    });
    expect(h.browserSessions.discoverInputs).toHaveLength(1);
    expect(h.credentialReader.findCalls).toBe(1);
    expect(JSON.stringify({ result, events: h.auditSink.events })).not.toContain(USERNAME);
    expect(JSON.stringify({ result, events: h.auditSink.events })).not.toContain(PASSWORD);
  });

  it("binds the selected item, consumes the plan, and returns only safe handles", async () => {
    const h = harness();
    const approval = await prepareLogin(h);
    const result = await h.broker.openAuthenticatedBrowser({
      loginPlanId: approval.login_plan_id,
      itemId: ITEM_ID,
      approvedTitle: approval.title,
      automateTotp: true,
      sessionId: SESSION_ID,
    });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        status: "authenticated",
        browser_session_id: BROWSER_SESSION_ID,
        item_id: ITEM_ID,
        vault_id: VAULT_ID,
        origin: ORIGIN,
      },
    });
    expect(h.credentialReader.credentialSelections).toEqual([
      {
        itemId: ITEM_ID,
        origin: ORIGIN,
        approvedTitle: "Example audit",
        automateTotp: true,
      },
    ]);
    expect(h.browserSessions.openInputs[0]?.route).toMatchObject({
      _tag: "same_origin",
      credentialOrigin: ORIGIN,
    });
    const replay = await h.broker.openAuthenticatedBrowser({
      loginPlanId: approval.login_plan_id,
      itemId: ITEM_ID,
      approvedTitle: approval.title,
      automateTotp: true,
      sessionId: SESSION_ID,
    });
    expect(replay).toMatchObject({ _tag: "err", error: { code: "login_plan_not_found" } });
    expect(h.credentialReader.credentialSelections).toHaveLength(1);
    const serialized = JSON.stringify({ result, events: h.auditSink.events });
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
  });

  it("rejects malformed, foreign-owner, and unbound plans before credential access", async () => {
    const h = harness();
    const found = await h.broker.findLoginItems({
      url: `${ORIGIN}/dashboard`,
      sessionId: SESSION_ID,
    });
    if (found._tag === "err") throw found.error;

    const malformedItem = await h.broker.resolveLoginPlan({
      loginPlanId: found.value.login_plan_id,
      itemId: "not-an-item",
      sessionId: SESSION_ID,
    });
    expect(malformedItem).toMatchObject({ _tag: "err", error: { code: "item_not_allowed" } });
    const foreignOwner = await h.broker.resolveLoginPlan({
      loginPlanId: found.value.login_plan_id,
      itemId: ITEM_ID,
      sessionId: "different-owner",
    });
    expect(foreignOwner).toMatchObject({
      _tag: "err",
      error: { code: "login_plan_owner_mismatch" },
    });
    const unbound = await h.broker.openAuthenticatedBrowser({
      loginPlanId: found.value.login_plan_id,
      itemId: ITEM_ID,
      approvedTitle: "Example audit",
      automateTotp: false,
      sessionId: SESSION_ID,
    });
    expect(unbound).toMatchObject({ _tag: "err", error: { code: "item_not_allowed" } });
    expect(h.credentialReader.credentialSelections).toEqual([]);
    expect(h.browserSessions.openInputs).toEqual([]);
  });

  it("expires login plans before item binding or credential access", async () => {
    let now = new Date("2026-09-12T00:00:00.000Z");
    const h = harness({ now: () => now });
    const found = await h.broker.findLoginItems({
      url: `${ORIGIN}/dashboard`,
      sessionId: SESSION_ID,
    });
    if (found._tag === "err") throw found.error;
    now = new Date("2026-09-12T00:03:00.000Z");

    const expired = await h.broker.resolveLoginPlan({
      loginPlanId: found.value.login_plan_id,
      itemId: ITEM_ID,
      sessionId: SESSION_ID,
    });
    expect(expired).toMatchObject({
      _tag: "err",
      error: { code: "login_plan_not_found" },
    });
    expect(h.credentialReader.credentialSelections).toEqual([]);
  });

  it("returns safe classified credential and browser failures after plan approval", async () => {
    const credentialFailure = harness();
    const credentialApproval = await prepareLogin(credentialFailure);
    credentialFailure.credentialReader.result = "error";
    const unavailable = await credentialFailure.broker.openAuthenticatedBrowser({
      loginPlanId: credentialApproval.login_plan_id,
      itemId: ITEM_ID,
      approvedTitle: credentialApproval.title,
      automateTotp: false,
      sessionId: SESSION_ID,
    });
    expect(unavailable).toMatchObject({ _tag: "err", error: { code: "unavailable" } });

    const browserFailure = harness();
    const browserApproval = await prepareLogin(browserFailure);
    browserFailure.browserSessions.result = "error";
    const unconfirmed = await browserFailure.broker.openAuthenticatedBrowser({
      loginPlanId: browserApproval.login_plan_id,
      itemId: ITEM_ID,
      approvedTitle: browserApproval.title,
      automateTotp: false,
      sessionId: SESSION_ID,
    });
    expect(unconfirmed).toMatchObject({
      _tag: "err",
      error: { code: "authentication_not_confirmed" },
    });
  });
});

describe("CredentialBroker restricted browser controls", () => {
  it("projects snapshots and invalidatable ref actions without logging typed text", async () => {
    const h = harness();
    const snapshot = await h.broker.snapshotBrowser({
      browserSessionId: BROWSER_SESSION_ID,
      sessionId: SESSION_ID,
    });
    const click = await h.broker.clickBrowser({
      browserSessionId: BROWSER_SESSION_ID,
      snapshotId: SNAPSHOT_ID,
      ref: "e7",
      sessionId: SESSION_ID,
    });
    const typedSecretLikeText = "caller-private-text";
    const typed = await h.broker.typeInBrowser({
      browserSessionId: BROWSER_SESSION_ID,
      snapshotId: SNAPSHOT_ID,
      ref: "e7",
      text: typedSecretLikeText,
      sessionId: SESSION_ID,
    });

    expect(snapshot).toMatchObject({
      _tag: "ok",
      value: { snapshot_id: SNAPSHOT_ID, title: "Dashboard" },
    });
    expect(click).toMatchObject({ _tag: "ok", value: { origin: ORIGIN } });
    expect(typed).toMatchObject({ _tag: "ok", value: { origin: ORIGIN } });
    expect(h.browserSessions.typeInputs[0]?.text).toBe(typedSecretLikeText);
    expect(JSON.stringify(h.auditSink.events)).not.toContain(typedSecretLikeText);
  });

  it("passes same-origin navigation and close to the owner-bound browser service", async () => {
    const h = harness();
    const navigated = await h.broker.navigateBrowser({
      browserSessionId: BROWSER_SESSION_ID,
      url: `${ORIGIN}/reports`,
      sessionId: SESSION_ID,
    });
    const closed = await h.broker.closeBrowser({
      browserSessionId: BROWSER_SESSION_ID,
      sessionId: SESSION_ID,
    });
    await h.broker.closeAllBrowsers();

    expect(navigated).toMatchObject({ _tag: "ok", value: { origin: ORIGIN } });
    expect(closed).toEqual({
      _tag: "ok",
      value: { status: "closed", browser_session_id: BROWSER_SESSION_ID },
    });
    expect(h.browserSessions.closeInputs[0]?.ownerSessionId).toBe(SESSION_ID);
    expect(h.browserSessions.closeAllCalls).toBe(1);
  });

  it("rejects malformed opaque IDs before browser access and excludes them from audit", async () => {
    const h = harness();
    const result = await h.broker.snapshotBrowser({
      browserSessionId: "secret-shaped-invalid-session-id",
      sessionId: SESSION_ID,
    });

    expect(result).toMatchObject({ _tag: "err", error: { code: "session_not_found" } });
    expect(h.browserSessions.snapshotInputs).toEqual([]);
    expect(JSON.stringify(h.auditSink.events)).not.toContain("secret-shaped-invalid-session-id");
  });
});
