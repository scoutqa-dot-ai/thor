import { describe, expect, it } from "vitest";
import type { IBrowserLogin } from "./browser-login.ts";
import { CredentialBroker, type BrokerAuditEvent, type BrokerAuditSink } from "./broker.ts";
import { parseBrokerEnvironment, SERVICE_ACCOUNT_TOKEN_FILE } from "./config.ts";
import type {
  ILoginCredentialReader,
  LoginCredentials,
  LoginMetadata,
} from "./credential-reader.ts";
import { BrowserLoginError, OnePasswordAccessError } from "./errors.ts";
import { RedactedString } from "./redacted.ts";
import { err, ok } from "./result.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = "https://accounts.lambdatest.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";

function parsedPolicy() {
  const result = parseBrokerEnvironment(
    {
      OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
      ONEPASSWORD_BROWSER_CONFIG: JSON.stringify({
        vault_id: VAULT_ID,
        item_id: ITEM_ID,
        origin: ORIGIN,
        login_url: `${ORIGIN}/login`,
        username_ref: `op://${VAULT_ID}/${ITEM_ID}/username`,
        password_ref: `op://${VAULT_ID}/${ITEM_ID}/password`,
        selectors: {
          username: "#username",
          password: "#password",
          submit: "#submit",
        },
        success_path_prefix: "/dashboard",
      }),
    },
    () => "ops_fixture_service_account_token",
  );
  if (result._tag === "err") throw result.error;
  return result.value.policy;
}

function metadata(): LoginMetadata {
  return {
    vaultId: parsedPolicy().vaultId,
    itemId: parsedPolicy().itemId,
    title: "TestMu audit",
    origin: ORIGIN,
    fields: [
      { id: "username", name: "username", type: "Text" },
      { id: "password", name: "password", type: "Concealed" },
    ],
  };
}

class RecordingAuditSink implements BrokerAuditSink {
  readonly events: BrokerAuditEvent[] = [];

  record(event: BrokerAuditEvent): void {
    this.events.push(event);
  }
}

class RecordingCredentialReader implements ILoginCredentialReader {
  metadataCalls = 0;
  credentialCalls = 0;
  result: "ok" | "error" = "ok";

  async getMetadata() {
    this.metadataCalls += 1;
    return this.result === "ok" ? ok(metadata()) : err(new OnePasswordAccessError("unavailable"));
  }

  async getCredentials() {
    this.credentialCalls += 1;
    if (this.result === "error") return err(new OnePasswordAccessError("unavailable"));
    const value: LoginCredentials = {
      metadata: metadata(),
      username: RedactedString.make(USERNAME),
      password: RedactedString.make(PASSWORD),
    };
    return ok(value);
  }
}

class RecordingBrowserLogin implements IBrowserLogin {
  calls = 0;
  result: "ok" | "error" = "ok";

  async login() {
    this.calls += 1;
    return this.result === "ok"
      ? ok({ status: "authenticated" as const, origin: ORIGIN })
      : err(new BrowserLoginError("authentication_not_confirmed"));
  }
}

function harness() {
  const credentialReader = new RecordingCredentialReader();
  const browserLogin = new RecordingBrowserLogin();
  const auditSink = new RecordingAuditSink();
  const broker = new CredentialBroker({
    policy: parsedPolicy(),
    credentialReader,
    browserLogin,
    auditSink,
    now: () => new Date("2026-09-10T10:00:00.000Z"),
  });
  return { broker, credentialReader, browserLogin, auditSink };
}

describe("CredentialBroker", () => {
  it("returns metadata without secret field values or unrelated item properties", async () => {
    const h = harness();
    const result = await h.broker.getLoginMetadata({ itemId: ITEM_ID, sessionId: "ses_123" });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        item_id: ITEM_ID,
        vault_id: VAULT_ID,
        title: "TestMu audit",
        approved_origin: ORIGIN,
        fields: [
          { name: "username", type: "Text" },
          { name: "password", type: "Concealed" },
        ],
      },
    });
    const serialized = JSON.stringify({ result, audit: h.auditSink.events });
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
    expect(h.auditSink.events).toEqual([
      expect.objectContaining({
        action: "get_login_metadata",
        outcome: "succeeded",
        session_id: "ses_123",
      }),
    ]);
  });

  it.each([
    ["wrong item", "c".repeat(26), ORIGIN, "item_not_allowed"],
    ["wrong origin", ITEM_ID, "https://evil.example", "origin_not_allowed"],
    ["origin path", ITEM_ID, `${ORIGIN}/login`, "invalid_origin"],
  ])(
    "denies %s before reading credentials or launching a browser",
    async (_label, itemId, origin, code) => {
      const h = harness();
      const result = await h.broker.browserLogin({ itemId, expectedOrigin: origin });

      expect(result).toMatchObject({ _tag: "err", error: { code } });
      expect(h.credentialReader.credentialCalls).toBe(0);
      expect(h.browserLogin.calls).toBe(0);
      expect(h.auditSink.events[0]).toMatchObject({ outcome: "denied", error_code: code });
    },
  );

  it("injects credentials into the browser but returns and logs only redacted metadata", async () => {
    const h = harness();
    const result = await h.broker.browserLogin({
      itemId: ITEM_ID,
      expectedOrigin: ORIGIN,
      sessionId: "ses_456",
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: { status: "authenticated", item_id: ITEM_ID, vault_id: VAULT_ID, origin: ORIGIN },
    });
    expect(h.credentialReader.credentialCalls).toBe(1);
    expect(h.browserLogin.calls).toBe(1);
    const serialized = JSON.stringify({ result, audit: h.auditSink.events });
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
  });

  it("returns safe classified failures without credential material", async () => {
    const h = harness();
    h.credentialReader.result = "error";
    const result = await h.broker.browserLogin({ itemId: ITEM_ID, expectedOrigin: ORIGIN });

    expect(result).toMatchObject({
      _tag: "err",
      error: { code: "unavailable", message: expect.stringContaining("could not load") },
    });
    expect(h.browserLogin.calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
});
