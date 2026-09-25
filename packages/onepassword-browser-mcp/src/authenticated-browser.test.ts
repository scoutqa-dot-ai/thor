import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import {
  browserProcessEnvironment,
  isApprovedBrowserUrl,
  parseBrowserElementRef,
  parseBrowserSessionId,
  parseBrowserSnapshotId,
  PlaywrightAuthenticatedBrowserSessions,
  sanitizeBrowserAccessibilitySnapshot,
  type BrowserSessionScheduler,
} from "./authenticated-browser.ts";
import type { BrowserLoginRoute } from "./browser-login-route.ts";
import {
  parseBrokerEnvironment,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";
import { OnePasswordAccessError } from "./errors.ts";
import { RedactedString } from "./redacted.ts";

const ORIGIN = "https://accounts.example.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";
const TOTP_CODE = "123456";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";

function parsedOrigin() {
  const parsed = parseBrowserDestinationUrl(`${ORIGIN}/login`);
  if (parsed._tag === "err") throw parsed.error;
  return parsed.value.origin;
}

describe("authenticated browser process boundary", () => {
  it("uses a fixed minimal environment with no broker credentials", () => {
    const environment = browserProcessEnvironment();

    expect(environment).toEqual({
      HOME: "/tmp",
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: "/tmp/cache",
      XDG_CONFIG_HOME: "/tmp/config",
    });
    expect(environment).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
    expect(environment).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN_FILE");
    expect(environment).not.toHaveProperty("ONEPASSWORD_BROWSER_VAULT_ID");
  });

  it("allows browser requests only on the exact configured HTTPS origin", () => {
    const origin = parsedOrigin();
    expect(isApprovedBrowserUrl(`${ORIGIN}/dashboard?view=1`, origin)).toBe(true);
    expect(isApprovedBrowserUrl("https://evil.example/login", origin)).toBe(false);
    expect(isApprovedBrowserUrl("https://accounts.example.com.evil.example", origin)).toBe(false);
    expect(isApprovedBrowserUrl("http://accounts.example.com/login", origin)).toBe(false);
    expect(isApprovedBrowserUrl("https://user:pass@accounts.example.com/login", origin)).toBe(
      false,
    );
    expect(isApprovedBrowserUrl("not a url", origin)).toBe(false);
  });
});

describe("opaque authenticated browser IDs", () => {
  it("accepts only broker UUIDs and strict Playwright accessibility refs", () => {
    expect(parseBrowserSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(parseBrowserSnapshotId(SNAPSHOT_ID)).toBe(SNAPSHOT_ID);
    expect(parseBrowserSessionId("not-a-session")).toBeUndefined();
    expect(parseBrowserSnapshotId("00000000-0000-7000-8000-000000000002")).toBeUndefined();
    expect(parseBrowserElementRef("e12")).toBe("e12");
    expect(parseBrowserElementRef("f1e12")).toBe("f1e12");
    expect(parseBrowserElementRef("e1 >> input")).toBeUndefined();
  });
});

describe("accessibility snapshot sanitization", () => {
  it("removes editable values, unknown fields, full URLs, off-origin refs, and credentials", async () => {
    const rawSnapshot = [
      {
        role: "main",
        ref: "e1",
        unknownProviderField: `must-not-pass ${PASSWORD}`,
        children: [
          { role: "heading", name: `Dashboard for ${USERNAME}`, level: 1, ref: "e2" },
          {
            role: "textbox",
            name: "Email",
            text: USERNAME,
            children: [USERNAME],
            placeholder: `Signed in as ${USERNAME}`,
            ref: "e3",
          },
          {
            role: "link",
            name: "Report",
            url: `${ORIGIN}/report?download_token=${PASSWORD}#fragment`,
            ref: "e4",
          },
          {
            role: "link",
            name: "External",
            url: `https://evil.example/collect?password=${PASSWORD}`,
            ref: "e5",
          },
          { role: "paragraph", text: `Known password: ${PASSWORD}`, ref: "e6" },
          { role: "paragraph", text: "Formatted verification code: 123-456", ref: "e7" },
          {
            role: "group",
            children: [
              { role: "paragraph", text: "123", ref: "e8" },
              { role: "paragraph", text: "456", ref: "e9" },
            ],
          },
          { role: "heading", name: "Numeric value", level: 123456, ref: "e10" },
          {
            role: "paragraph",
            text: "Upper URL HTTPS://accounts.example.com/report?token=private-upper-token",
          },
          {
            role: "paragraph",
            text: "Insecure URL http://accounts.example.com/report?token=private-http-token",
          },
        ],
      },
    ];

    const result = await sanitizeBrowserAccessibilitySnapshot(rawSnapshot, parsedOrigin(), {
      username: RedactedString.make(USERNAME),
      password: RedactedString.make(PASSWORD),
      additionalSecrets: [RedactedString.make(TOTP_CODE)],
    });

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    const serialized = JSON.stringify(result.value.accessibility);
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(TOTP_CODE);
    expect(serialized).not.toContain("123-456");
    expect(serialized).not.toContain("unknownProviderField");
    expect(serialized).not.toContain("download_token");
    expect(serialized).not.toContain("fragment");
    expect(serialized).not.toContain("private-upper-token");
    expect(serialized).not.toContain("private-http-token");
    expect(serialized).toContain("[same-origin-url]");
    expect(serialized).toContain("[blocked-url]");
    expect(serialized).toContain("[REDACTED]");

    const parsedSnapshot = JSON.parse(serialized) as Array<{
      children: Array<Record<string, unknown>>;
    }>;
    const textBox = parsedSnapshot[0]?.children[1];
    expect(textBox).not.toHaveProperty("text");
    expect(textBox).not.toHaveProperty("children");
    expect([...result.value.refs].sort()).toEqual([
      "e1",
      "e10",
      "e2",
      "e3",
      "e4",
      "e6",
      "e7",
      "e8",
      "e9",
    ]);
  });

  it("fails closed when the sanitized accessibility tree exceeds its node budget", async () => {
    const rawSnapshot = Array.from({ length: 501 }, (_, index) => ({
      role: "paragraph",
      text: `row ${index}`,
    }));
    const result = await sanitizeBrowserAccessibilitySnapshot(rawSnapshot, parsedOrigin(), {
      username: RedactedString.make(USERNAME),
      password: RedactedString.make(PASSWORD),
    });

    expect(result).toMatchObject({
      _tag: "err",
      error: { code: "snapshot_too_large" },
    });
  });
});

const canRunLocalChromium = existsSync("/usr/bin/chromium") && existsSync("/usr/bin/openssl");
const chromiumIt = canRunLocalChromium ? it : it.skip;

function findSnapshotRef(value: unknown, accessibleName: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = findSnapshotRef(item, accessibleName);
      if (ref) return ref;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const name = Reflect.get(value, "name");
  const ref = Reflect.get(value, "ref");
  if (name === accessibleName && typeof ref === "string") return ref;
  return findSnapshotRef(Reflect.get(value, "children"), accessibleName);
}

chromiumIt(
  "logs in through a semantic two-step form and retains only restricted owner-bound controls",
  async () => {
    const certificateDirectory = mkdtempSync(join(tmpdir(), "thor-browser-cert-"));
    const keyPath = join(certificateDirectory, "key.pem");
    const certificatePath = join(certificateDirectory, "certificate.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );

    const observed = { username: "", password: "", totp: "", cookie: "" };
    let mfaChallengeServed = false;
    let unrelatedMfaSubmits = 0;
    const server = createServer(
      {
        key: readFileSync(keyPath),
        cert: readFileSync(certificatePath),
      },
      async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "https://127.0.0.1");
        let body = "";
        for await (const chunk of request) body += String(chunk);

        if (request.method === "GET" && requestUrl.pathname === "/login") {
          response.end(
            '<!doctype html><title>Login</title><form method="post" action="/password"><label>Email<input autocomplete="username" name="email"></label><button type="submit">Continue</button></form>',
          );
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/get-login") {
          response.end(
            '<!doctype html><title>Unsafe login</title><form action="/dashboard"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>',
          );
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/override-get-login") {
          response.end(
            '<!doctype html><title>Unsafe submit</title><form method="post" action="/session"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit" formmethod="get">Sign in</button></form>',
          );
          return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/mfa-login") {
          response.end(
            '<!doctype html><title>Login</title><form method="post" action="/mfa"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>',
          );
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/mismatched-mfa-login") {
          response.end(
            '<!doctype html><title>Login</title><form method="post" action="/mismatched-mfa"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>',
          );
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/combined-mfa-login") {
          response.end(
            '<!doctype html><title>Login</title><form method="post" action="/combined-mfa"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>',
          );
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/mfa") {
          observed.password = new URLSearchParams(body).get("password") ?? "";
          mfaChallengeServed = true;
          response.end(
            '<!doctype html><title>Verification</title><form method="post" action="/mfa-session"><label>Verification code<input autocomplete="one-time-code" name="otp"></label><button type="submit">Verify</button></form>',
          );
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/mfa-session") {
          observed.totp = new URLSearchParams(body).get("otp") ?? "";
          if (observed.totp !== TOTP_CODE) {
            response.writeHead(401);
            response.end("invalid code");
            return;
          }
          response.writeHead(303, {
            location: "/dashboard",
            "set-cookie": "session=private-cookie-fixture; Secure; HttpOnly; SameSite=Strict",
          });
          response.end();
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/mismatched-mfa") {
          response.end(
            '<!doctype html><title>Verification</title><form method="post" action="/mfa-session"><label>Verification code<input autocomplete="one-time-code" name="otp"></label></form><form method="post" action="/unrelated"><button type="submit">Continue</button></form>',
          );
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/combined-mfa") {
          response.end(
            '<!doctype html><title>Still signing in</title><form method="post" action="/mfa-session"><label>Password<input type="password" name="password"></label><label>Verification code<input autocomplete="one-time-code" name="otp"></label><button type="submit">Verify</button></form>',
          );
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/unrelated") {
          unrelatedMfaSubmits += 1;
          response.end("unexpected");
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/password") {
          observed.username = new URLSearchParams(body).get("email") ?? "";
          response.end(
            '<!doctype html><title>Password</title><form method="post" action="/session"><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>',
          );
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/session") {
          observed.password = new URLSearchParams(body).get("password") ?? "";
          response.writeHead(303, {
            location: "/dashboard",
            "set-cookie": "session=private-cookie-fixture; Secure; HttpOnly; SameSite=Strict",
          });
          response.end();
          return;
        }
        if (requestUrl.pathname === "/dashboard") {
          observed.cookie = request.headers.cookie ?? "";
          if (!observed.cookie.includes("session=private-cookie-fixture")) {
            response.writeHead(303, { location: "/login" });
            response.end();
            return;
          }
          response.end(
            `<!doctype html><title>Dashboard for ${USERNAME}</title><main><h1>Dashboard for ${USERNAME}</h1><label>Search<input name="search" value="private-input-value"></label><a href="/reports?token=private-link-token">Reports</a></main>`,
          );
          return;
        }
        if (requestUrl.pathname === "/reports") {
          observed.cookie = request.headers.cookie ?? "";
          response.end("<!doctype html><title>Reports</title><main><h1>Reports</h1></main>");
          return;
        }
        response.writeHead(404);
        response.end();
      },
    );

    let sessions: PlaywrightAuthenticatedBrowserSessions | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing HTTPS test address");
      const origin = `https://127.0.0.1:${address.port}`;
      const loginDestination = parseBrowserDestinationUrl(`${origin}/login`);
      const dashboardDestination = parseBrowserDestinationUrl(`${origin}/dashboard`);
      const environment = parseBrokerEnvironment(
        {
          OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
          ONEPASSWORD_BROWSER_VAULT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        () => "ops_fixture_service_account_token",
      );
      const itemId = parseOnePasswordItemId("bbbbbbbbbbbbbbbbbbbbbbbbbb");
      if (
        loginDestination._tag === "err" ||
        dashboardDestination._tag === "err" ||
        environment._tag === "err" ||
        !itemId
      ) {
        throw new Error("invalid browser integration fixture");
      }
      const dashboardRoute: BrowserLoginRoute = {
        _tag: "same_origin",
        application: dashboardDestination.value,
        credentialOrigin: dashboardDestination.value.origin,
      };
      const generatedIds = [
        SESSION_ID,
        SNAPSHOT_ID,
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000005",
      ];
      const scheduledExpirations: Array<{ active: boolean; expire: () => void }> = [];
      const scheduler: BrowserSessionScheduler = {
        schedule: (_delayMs, expire) => {
          const scheduled = { active: true, expire };
          scheduledExpirations.push(scheduled);
          return {
            cancel: () => {
              scheduled.active = false;
            },
          };
        },
      };
      sessions = new PlaywrightAuthenticatedBrowserSessions({
        actionTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        createId: () => {
          const id = generatedIds.shift();
          if (!id) throw new Error("browser integration ID fixture exhausted");
          return id;
        },
        scheduler,
        ignoreHTTPSErrorsForTesting: true,
        launchBrowser: () =>
          chromium.launch({
            executablePath: "/usr/bin/chromium",
            headless: true,
            env: browserProcessEnvironment(),
            args: ["--ignore-certificate-errors", "--no-sandbox"],
          }),
      });
      const credentials = {
        metadata: {
          vaultId: environment.value.vaultId,
          itemId,
          title: "Local browser integration",
          origin: loginDestination.value.origin,
          loginUrl: loginDestination.value.url,
        },
        username: RedactedString.make(USERNAME),
        password: RedactedString.make(PASSWORD),
      };
      const tlsEnforcedSessions = new PlaywrightAuthenticatedBrowserSessions({
        actionTimeoutMs: 5_000,
        executablePath: "/usr/bin/chromium",
      });
      try {
        const untrustedCertificate = await tlsEnforcedSessions.openAuthenticatedBrowser({
          ownerSessionId: "tls-owner-session",
          route: dashboardRoute,
          credentials,
        });
        expect(untrustedCertificate).toMatchObject({
          _tag: "err",
          error: { code: "browser_flow_failed" },
        });
      } finally {
        await tlsEnforcedSessions.closeAllBrowsers();
      }

      const opened = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "owner-session",
        route: dashboardRoute,
        credentials,
      });
      expect(opened).toEqual({
        _tag: "ok",
        value: { browserSessionId: SESSION_ID, origin },
      });
      expect(observed).toEqual({
        username: USERNAME,
        password: PASSWORD,
        totp: "",
        cookie: "session=private-cookie-fixture",
      });
      if (opened._tag === "err") return;

      const wrongOwner = await sessions.snapshotBrowser({
        ownerSessionId: "other-session",
        browserSessionId: opened.value.browserSessionId,
      });
      expect(wrongOwner).toMatchObject({
        _tag: "err",
        error: { code: "session_owner_mismatch" },
      });

      const snapshot = await sessions.snapshotBrowser({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
      });
      expect(snapshot._tag).toBe("ok");
      if (snapshot._tag === "err") return;
      const serializedSnapshot = JSON.stringify(snapshot.value);
      for (const sensitive of [
        USERNAME,
        PASSWORD,
        "private-cookie-fixture",
        "private-input-value",
        "private-link-token",
      ]) {
        expect(serializedSnapshot).not.toContain(sensitive);
      }

      const searchRefValue = findSnapshotRef(snapshot.value.accessibility, "Search");
      const searchRef = searchRefValue ? parseBrowserElementRef(searchRefValue) : undefined;
      if (!searchRef) {
        throw new Error(
          `missing Search ref in browser integration snapshot: ${JSON.stringify(snapshot.value.accessibility)}`,
        );
      }
      const typed = await sessions.typeIntoBrowserRef({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
        snapshotId: snapshot.value.snapshotId,
        ref: searchRef,
        text: "audit report",
      });
      expect(typed).toMatchObject({ _tag: "ok", value: { origin } });
      expect(JSON.stringify(typed)).not.toContain("audit report");

      const stale = await sessions.clickBrowserRef({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
        snapshotId: snapshot.value.snapshotId,
        ref: searchRef,
      });
      expect(stale).toMatchObject({ _tag: "err", error: { code: "stale_snapshot" } });

      const secondSnapshot = await sessions.snapshotBrowser({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
      });
      if (secondSnapshot._tag === "err") throw secondSnapshot.error;
      const reportsRefValue = findSnapshotRef(secondSnapshot.value.accessibility, "Reports");
      const reportsRef = reportsRefValue ? parseBrowserElementRef(reportsRefValue) : undefined;
      if (!reportsRef) throw new Error("missing Reports ref in browser integration snapshot");
      const clicked = await sessions.clickBrowserRef({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
        snapshotId: secondSnapshot.value.snapshotId,
        ref: reportsRef,
      });
      expect(clicked).toMatchObject({ _tag: "ok", value: { origin } });

      const closed = await sessions.closeBrowser({
        ownerSessionId: "owner-session",
        browserSessionId: opened.value.browserSessionId,
      });
      expect(closed).toEqual({ _tag: "ok", value: { status: "closed" } });

      const reopened = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "owner-session",
        route: dashboardRoute,
        credentials,
      });
      if (reopened._tag === "err") throw reopened.error;
      const activeExpiration = [...scheduledExpirations].reverse().find((entry) => entry.active);
      if (!activeExpiration) throw new Error("missing active browser expiration fixture");
      activeExpiration.expire();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const expired = await sessions.snapshotBrowser({
        ownerSessionId: "owner-session",
        browserSessionId: reopened.value.browserSessionId,
      });
      expect(expired).toMatchObject({ _tag: "err", error: { code: "session_not_found" } });

      const mfaLoginDestination = parseBrowserDestinationUrl(`${origin}/mfa-login`);
      if (mfaLoginDestination._tag === "err") throw mfaLoginDestination.error;
      const mfa = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "mfa-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: mfaLoginDestination.value.url },
        },
      });
      expect(mfa).toMatchObject({ _tag: "err", error: { code: "mfa_required" } });
      const combinedMfaDestination = parseBrowserDestinationUrl(`${origin}/combined-mfa-login`);
      if (combinedMfaDestination._tag === "err") throw combinedMfaDestination.error;
      let combinedTotpReads = 0;
      const combinedMfa = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "combined-mfa-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: combinedMfaDestination.value.url },
          totp: {
            getCurrentCode: async () => {
              combinedTotpReads += 1;
              return { _tag: "ok", value: RedactedString.make(TOTP_CODE) };
            },
          },
        },
      });
      expect(combinedMfa).toMatchObject({
        _tag: "err",
        error: { code: "authentication_not_confirmed" },
      });
      expect(combinedTotpReads).toBe(0);

      const mismatchedMfaDestination = parseBrowserDestinationUrl(`${origin}/mismatched-mfa-login`);
      if (mismatchedMfaDestination._tag === "err") throw mismatchedMfaDestination.error;
      let mismatchedTotpReads = 0;
      const mismatchedMfa = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "mismatched-mfa-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: mismatchedMfaDestination.value.url },
          totp: {
            getCurrentCode: async () => {
              mismatchedTotpReads += 1;
              return { _tag: "ok", value: RedactedString.make(TOTP_CODE) };
            },
          },
        },
      });
      expect(mismatchedMfa).toMatchObject({
        _tag: "err",
        error: { code: "field_missing_or_ambiguous" },
      });
      expect(mismatchedTotpReads).toBe(0);
      expect(unrelatedMfaSubmits).toBe(0);

      mfaChallengeServed = false;
      let totpReads = 0;
      const failedTotpRead = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "automated-mfa-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: mfaLoginDestination.value.url },
          totp: {
            getCurrentCode: async () => ({
              _tag: "err",
              error: new OnePasswordAccessError("unavailable"),
            }),
          },
        },
      });
      expect(failedTotpRead).toMatchObject({
        _tag: "err",
        error: { code: "unavailable" },
      });
      mfaChallengeServed = false;

      const automatedMfa = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "automated-mfa-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: mfaLoginDestination.value.url },
          totp: {
            getCurrentCode: async () => {
              totpReads += 1;
              expect(mfaChallengeServed).toBe(true);
              return { _tag: "ok", value: RedactedString.make(TOTP_CODE) };
            },
          },
        },
      });
      expect(automatedMfa).toMatchObject({ _tag: "ok", value: { origin } });
      expect(totpReads).toBe(1);
      expect(observed.totp).toBe(TOTP_CODE);
      expect(JSON.stringify(automatedMfa)).not.toContain(TOTP_CODE);
      if (automatedMfa._tag === "ok") {
        await sessions.closeBrowser({
          ownerSessionId: "automated-mfa-owner-session",
          browserSessionId: automatedMfa.value.browserSessionId,
        });
      }

      const getLoginDestination = parseBrowserDestinationUrl(`${origin}/get-login`);
      if (getLoginDestination._tag === "err") throw getLoginDestination.error;
      const unsafeGetForm = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "get-form-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: getLoginDestination.value.url },
        },
      });
      expect(unsafeGetForm).toMatchObject({
        _tag: "err",
        error: { code: "field_missing_or_ambiguous" },
      });

      const overrideGetDestination = parseBrowserDestinationUrl(`${origin}/override-get-login`);
      if (overrideGetDestination._tag === "err") throw overrideGetDestination.error;
      const unsafeSubmitOverride = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "get-submit-owner-session",
        route: dashboardRoute,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: overrideGetDestination.value.url },
        },
      });
      expect(unsafeSubmitOverride).toMatchObject({
        _tag: "err",
        error: { code: "field_missing_or_ambiguous" },
      });
    } finally {
      await sessions?.closeAllBrowsers();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(certificateDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

chromiumIt(
  "discovers and enforces an application to credential to exact callback route",
  async () => {
    const certificateDirectory = mkdtempSync(join(tmpdir(), "thor-delegated-browser-cert-"));
    const keyPath = join(certificateDirectory, "key.pem");
    const certificatePath = join(certificateDirectory, "certificate.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    const tls = { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
    let applicationOrigin = "";
    let credentialOrigin = "";
    let useWrongCallback = false;
    let useUnsafePostRedirect = false;
    let useExtraDiscoveryHop = false;
    let useApplicationBounce = false;
    let useInternalCredentialRedirect = false;
    let useChangedRedirectUri = false;
    let extraDiscoveryOrigin = "";
    const observed = {
      username: "",
      password: "",
      callbackQuery: "",
      appCookie: "",
      wrongCallbackRequests: 0,
      extraHopRequests: 0,
      unsafePostRedirectRequests: 0,
      applicationBounceRequests: 0,
      credentialSubmissions: 0,
    };

    const applicationServer = createServer(tls, (request, response) => {
      const requestUrl = new URL(request.url ?? "/", applicationOrigin);
      if (requestUrl.pathname === "/dashboard") {
        observed.appCookie = request.headers.cookie ?? "";
        if (!observed.appCookie.includes("app_session=approved")) {
          const callback = `${applicationOrigin}/auth/callback`;
          response.writeHead(303, {
            location: `${credentialOrigin}/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(callback)}&state=fixture-state`,
          });
          response.end();
          return;
        }
        response.end(
          "<!doctype html><title>Delegated dashboard</title><h1>Delegated dashboard</h1>",
        );
        return;
      }
      if (requestUrl.pathname === "/auth/callback") {
        observed.callbackQuery = requestUrl.search;
        response.writeHead(303, {
          location: "/dashboard",
          "set-cookie": "app_session=approved; Path=/; Secure; HttpOnly; SameSite=Strict",
        });
        response.end();
        return;
      }
      if (requestUrl.pathname === "/third-login") {
        observed.extraHopRequests += 1;
        response.end(
          '<!doctype html><form method="post" action="/session"><input autocomplete="username" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>',
        );
        return;
      }
      if (requestUrl.pathname === "/wrong/callback") {
        observed.wrongCallbackRequests += 1;
        response.end("wrong callback must not arrive");
        return;
      }
      if (requestUrl.pathname === "/capture") {
        observed.unsafePostRedirectRequests += 1;
        response.end("credential POST must not arrive");
        return;
      }
      if (requestUrl.pathname === "/bounce") {
        observed.applicationBounceRequests += 1;
        response.writeHead(303, { location: `${credentialOrigin}/authorize` });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const credentialServer = createServer(tls, async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", credentialOrigin);
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (request.method === "GET" && requestUrl.pathname === "/authorize") {
        if (useExtraDiscoveryHop) {
          response.writeHead(303, { location: `${extraDiscoveryOrigin}/third-login` });
          response.end();
          return;
        }
        if (useApplicationBounce) {
          response.writeHead(303, { location: `${applicationOrigin}/bounce` });
          response.end();
          return;
        }
        if (useInternalCredentialRedirect) {
          const loginLocation = useChangedRedirectUri
            ? `/login?redirect_uri=${encodeURIComponent("https://evil.example/callback")}`
            : "/login?session=fixture";
          response.writeHead(303, { location: loginLocation });
          response.end();
          return;
        }
        const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
        const state = requestUrl.searchParams.get("state") ?? "";
        response.end(
          `<!doctype html><title>Identity login</title><form method="post" action="/session?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}"><label>Email<input autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>`,
        );
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/login") {
        const callback = `${applicationOrigin}/auth/callback`;
        response.end(
          `<!doctype html><form method="post" action="/session?redirect_uri=${encodeURIComponent(callback)}&state=fixture-state"><input autocomplete="username" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>`,
        );
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/session") {
        observed.credentialSubmissions += 1;
        const fields = new URLSearchParams(body);
        observed.username = fields.get("email") ?? "";
        observed.password = fields.get("password") ?? "";
        if (useUnsafePostRedirect) {
          response.writeHead(307, { location: `${extraDiscoveryOrigin}/capture` });
          response.end();
          return;
        }
        const callback = new URL(requestUrl.searchParams.get("redirect_uri") ?? applicationOrigin);
        callback.pathname = useWrongCallback ? "/wrong/callback" : callback.pathname;
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", requestUrl.searchParams.get("state") ?? "");
        callback.searchParams.set("session_state", "fixture-session");
        response.writeHead(303, { location: callback.href });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    let sessions: PlaywrightAuthenticatedBrowserSessions | undefined;
    try {
      applicationServer.listen(0, "127.0.0.1");
      credentialServer.listen(0, "127.0.0.1");
      await Promise.all([
        once(applicationServer, "listening"),
        once(credentialServer, "listening"),
      ]);
      const applicationAddress = applicationServer.address();
      const credentialAddress = credentialServer.address();
      if (
        !applicationAddress ||
        typeof applicationAddress === "string" ||
        !credentialAddress ||
        typeof credentialAddress === "string"
      ) {
        throw new Error("missing delegated HTTPS test address");
      }
      applicationOrigin = `https://127.0.0.1:${applicationAddress.port}`;
      credentialOrigin = `https://127.0.0.1:${credentialAddress.port}`;
      extraDiscoveryOrigin = `https://localhost:${applicationAddress.port}`;
      const application = parseBrowserDestinationUrl(`${applicationOrigin}/dashboard`);
      const credentialLogin = parseBrowserDestinationUrl(`${credentialOrigin}/authorize`);
      const environment = parseBrokerEnvironment(
        {
          OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
          ONEPASSWORD_BROWSER_VAULT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        () => "ops_fixture_service_account_token",
      );
      const itemId = parseOnePasswordItemId("bbbbbbbbbbbbbbbbbbbbbbbbbb");
      if (
        application._tag === "err" ||
        credentialLogin._tag === "err" ||
        environment._tag === "err" ||
        !itemId
      ) {
        throw new Error("invalid delegated browser fixture");
      }
      const generatedIds = [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ];
      sessions = new PlaywrightAuthenticatedBrowserSessions({
        actionTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        createId: () => {
          const id = generatedIds.shift();
          if (!id) throw new Error("delegated browser ID fixture exhausted");
          return id;
        },
        ignoreHTTPSErrorsForTesting: true,
        launchBrowser: () =>
          chromium.launch({
            executablePath: "/usr/bin/chromium",
            headless: true,
            env: browserProcessEnvironment(),
            args: ["--ignore-certificate-errors", "--no-sandbox"],
          }),
      });
      const discovered = await sessions.discoverLoginRoute({
        ownerSessionId: "delegated-owner",
        destination: application.value,
      });
      if (discovered._tag === "err") throw discovered.error;
      expect(discovered).toMatchObject({
        _tag: "ok",
        value: {
          _tag: "delegated",
          application: { origin: applicationOrigin },
          credentialOrigin,
          callbackPath: "/auth/callback",
        },
      });
      useInternalCredentialRedirect = true;
      const internallyRedirectedDiscovery = await sessions.discoverLoginRoute({
        ownerSessionId: "internal-redirect-owner",
        destination: application.value,
      });
      expect(internallyRedirectedDiscovery).toMatchObject({
        _tag: "ok",
        value: {
          _tag: "delegated",
          credentialOrigin,
          callbackPath: "/auth/callback",
        },
      });
      useInternalCredentialRedirect = false;
      const credentials = {
        metadata: {
          vaultId: environment.value.vaultId,
          itemId,
          title: "Delegated browser integration",
          origin: credentialLogin.value.origin,
          loginUrl: credentialLogin.value.url,
        },
        username: RedactedString.make(USERNAME),
        password: RedactedString.make(PASSWORD),
      };
      const submissionsBeforeChangedRedirect = observed.credentialSubmissions;
      useInternalCredentialRedirect = true;
      useChangedRedirectUri = true;
      const rejectedChangedRedirect = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "changed-redirect-owner",
        route: discovered.value,
        credentials,
      });
      expect(rejectedChangedRedirect).toMatchObject({
        _tag: "err",
        error: { code: "origin_changed" },
      });
      expect(observed.credentialSubmissions).toBe(submissionsBeforeChangedRedirect);
      useChangedRedirectUri = false;
      useInternalCredentialRedirect = false;

      const opened = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "delegated-owner",
        route: discovered.value,
        credentials,
      });
      if (opened._tag === "err") throw opened.error;
      expect(opened).toMatchObject({ _tag: "ok", value: { origin: applicationOrigin } });
      expect(observed.username).toBe(USERNAME);
      expect(observed.password).toBe(PASSWORD);
      expect(observed.callbackQuery).toContain("code=fixture-code");
      expect(JSON.stringify(opened)).not.toContain("fixture-code");
      const crossOriginNavigation = await sessions.navigateBrowser({
        ownerSessionId: "delegated-owner",
        browserSessionId: opened.value.browserSessionId,
        destination: credentialLogin.value,
      });
      expect(crossOriginNavigation).toMatchObject({
        _tag: "err",
        error: { code: "origin_not_allowed" },
      });
      await sessions.closeBrowser({
        ownerSessionId: "delegated-owner",
        browserSessionId: opened.value.browserSessionId,
      });
      useUnsafePostRedirect = true;
      const rejectedPostRedirect = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "delegated-owner",
        route: discovered.value,
        credentials,
      });
      expect(rejectedPostRedirect).toMatchObject({
        _tag: "err",
        error: { code: "origin_changed" },
      });
      expect(observed.unsafePostRedirectRequests).toBe(0);

      useUnsafePostRedirect = false;

      useWrongCallback = true;
      const rejectedCallback = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "delegated-owner",
        route: discovered.value,
        credentials,
      });
      expect(rejectedCallback).toMatchObject({
        _tag: "err",
        error: { code: "origin_changed" },
      });
      expect(observed.wrongCallbackRequests).toBe(0);
      useWrongCallback = false;
      useApplicationBounce = true;
      const rejectedApplicationBounce = await sessions.discoverLoginRoute({
        ownerSessionId: "application-bounce-owner",
        destination: application.value,
      });
      expect(rejectedApplicationBounce).toMatchObject({
        _tag: "err",
        error: { code: "origin_changed" },
      });
      expect(observed.applicationBounceRequests).toBe(0);
      useApplicationBounce = false;
      useExtraDiscoveryHop = true;
      const rejectedExtraHop = await sessions.discoverLoginRoute({
        ownerSessionId: "extra-hop-owner",
        destination: application.value,
      });
      expect(rejectedExtraHop).toMatchObject({
        _tag: "err",
        error: { code: "origin_changed" },
      });
      expect(observed.extraHopRequests).toBe(0);
    } finally {
      await sessions?.closeAllBrowsers();
      await Promise.all([
        new Promise<void>((resolve) => applicationServer.close(() => resolve())),
        new Promise<void>((resolve) => credentialServer.close(() => resolve())),
      ]);
      rmSync(certificateDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);
