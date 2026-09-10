import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import type { BrowserLoginPolicy } from "./config.ts";
import type { LoginCredentials } from "./credential-reader.ts";
import { BrowserLoginError } from "./errors.ts";
import { withRedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

export interface BrowserLoginSuccess {
  readonly status: "authenticated";
  readonly origin: string;
}

export interface IBrowserLogin {
  login(
    policy: BrowserLoginPolicy,
    credentials: LoginCredentials,
  ): Promise<Result<BrowserLoginSuccess, BrowserLoginError>>;
}

/** Deliberately excludes every parent variable, especially broker credentials. */
export function browserProcessEnvironment(): Record<string, string> {
  return {
    HOME: "/tmp",
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp/cache",
    XDG_CONFIG_HOME: "/tmp/config",
  };
}

class BrowserBoundaryError extends Error {
  readonly code: "origin_changed" | "field_missing_or_ambiguous" | "authentication_not_confirmed";

  constructor(code: BrowserBoundaryError["code"]) {
    super(code);
    this.code = code;
  }
}

export function isApprovedBrowserUrl(value: string, approvedOrigin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && url.origin === approvedOrigin
    );
  } catch {
    return false;
  }
}

function requireApprovedOrigin(page: Page, approvedOrigin: string): void {
  if (!isApprovedBrowserUrl(page.url(), approvedOrigin)) {
    throw new BrowserBoundaryError("origin_changed");
  }
}

async function requireSingleVisibleLocator(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<Locator> {
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1) {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
  return locator;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function isSuccessfulLoginUrl(
  value: string,
  approvedOrigin: string,
  successPathPrefix: string,
): boolean {
  try {
    const url = new URL(value);
    return (
      isApprovedBrowserUrl(value, approvedOrigin) &&
      pathMatchesPrefix(url.pathname, successPathPrefix)
    );
  } catch {
    return false;
  }
}

export class PlaywrightBrowserLogin implements IBrowserLogin {
  readonly executablePath: string;

  constructor(executablePath = "/usr/bin/chromium") {
    this.executablePath = executablePath;
  }

  async login(
    policy: BrowserLoginPolicy,
    credentials: LoginCredentials,
  ): Promise<Result<BrowserLoginSuccess, BrowserLoginError>> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      browser = await chromium.launch({
        executablePath: this.executablePath,
        headless: true,
        chromiumSandbox: false,
        env: browserProcessEnvironment(),
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          "--no-sandbox",
          "--password-store=basic",
        ],
      });
      context = await browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
      });
      // Block browser channels that are not covered by ordinary HTTP routing.
      // Login flows do not need browser-originated peer connections, and no
      // WebSocket is allowed to carry filled credentials off-origin.
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "RTCPeerConnection", { value: undefined });
        Object.defineProperty(globalThis, "webkitRTCPeerConnection", { value: undefined });
      });
      await context.routeWebSocket("**/*", (webSocket) => webSocket.close());
      await context.route("**/*", async (route) => {
        try {
          const requestUrl = new URL(route.request().url());
          if (isApprovedBrowserUrl(requestUrl.href, policy.origin)) {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
        } catch {
          await route.abort("blockedbyclient");
        }
      });

      const page = await context.newPage();
      await page.goto(policy.loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: policy.timeoutMs,
      });
      requireApprovedOrigin(page, policy.origin);

      const username = await requireSingleVisibleLocator(
        page,
        policy.selectors.username,
        policy.timeoutMs,
      );
      requireApprovedOrigin(page, policy.origin);
      await withRedactedString(credentials.username, (value) => username.fill(value));

      if (policy.selectors.usernameSubmit) {
        requireApprovedOrigin(page, policy.origin);
        const usernameSubmit = await requireSingleVisibleLocator(
          page,
          policy.selectors.usernameSubmit,
          policy.timeoutMs,
        );
        await usernameSubmit.click({ timeout: policy.timeoutMs });
        requireApprovedOrigin(page, policy.origin);
      }

      const password = await requireSingleVisibleLocator(
        page,
        policy.selectors.password,
        policy.timeoutMs,
      );
      requireApprovedOrigin(page, policy.origin);
      await withRedactedString(credentials.password, (value) => password.fill(value));

      requireApprovedOrigin(page, policy.origin);
      const submit = await requireSingleVisibleLocator(
        page,
        policy.selectors.submit,
        policy.timeoutMs,
      );
      await submit.click({ timeout: policy.timeoutMs });

      try {
        await page.waitForURL(
          (url) => isSuccessfulLoginUrl(url.href, policy.origin, policy.successPathPrefix),
          { timeout: policy.timeoutMs, waitUntil: "domcontentloaded" },
        );
      } catch {
        throw new BrowserBoundaryError("authentication_not_confirmed");
      }
      requireApprovedOrigin(page, policy.origin);
      return ok({ status: "authenticated", origin: policy.origin });
    } catch (error) {
      if (error instanceof BrowserBoundaryError) {
        return err(new BrowserLoginError(error.code));
      }
      return err(
        new BrowserLoginError(
          browser === undefined ? "browser_unavailable" : "browser_flow_failed",
        ),
      );
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
