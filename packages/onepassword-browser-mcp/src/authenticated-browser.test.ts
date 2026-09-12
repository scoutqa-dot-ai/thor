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
import {
  parseBrokerEnvironment,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";
import { RedactedString } from "./redacted.ts";

const ORIGIN = "https://accounts.example.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";
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
    });

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    const serialized = JSON.stringify(result.value.accessibility);
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
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
    expect([...result.value.refs].sort()).toEqual(["e1", "e2", "e3", "e4", "e6"]);
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

    const observed = { username: "", password: "", cookie: "" };
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
        if (request.method === "POST" && requestUrl.pathname === "/mfa") {
          response.end(
            '<!doctype html><title>Verification</title><main><label>Verification code<input autocomplete="one-time-code" name="otp"></label></main>',
          );
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
      const generatedIds = [
        SESSION_ID,
        SNAPSHOT_ID,
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
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
          destination: dashboardDestination.value,
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
        destination: dashboardDestination.value,
        credentials,
      });
      expect(opened).toEqual({
        _tag: "ok",
        value: { browserSessionId: SESSION_ID, origin },
      });
      expect(observed).toEqual({
        username: USERNAME,
        password: PASSWORD,
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
        destination: dashboardDestination.value,
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
        destination: dashboardDestination.value,
        credentials: {
          ...credentials,
          metadata: { ...credentials.metadata, loginUrl: mfaLoginDestination.value.url },
        },
      });
      expect(mfa).toMatchObject({ _tag: "err", error: { code: "mfa_required" } });

      const getLoginDestination = parseBrowserDestinationUrl(`${origin}/get-login`);
      if (getLoginDestination._tag === "err") throw getLoginDestination.error;
      const unsafeGetForm = await sessions.openAuthenticatedBrowser({
        ownerSessionId: "get-form-owner-session",
        destination: dashboardDestination.value,
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
        destination: dashboardDestination.value,
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
  20_000,
);
