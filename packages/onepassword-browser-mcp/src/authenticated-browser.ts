import { randomUUID } from "node:crypto";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Locator,
  type Page,
} from "playwright-core";
import { type BrowserDestination, type BrowserOrigin } from "./config.ts";
import type { LoginCredentials } from "./credential-reader.ts";
import { BrokerRequestDeniedError, BrowserSessionError } from "./errors.ts";
import { withRedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 8;
const MAX_SNAPSHOT_CHARS = 48_000;
const MAX_SNAPSHOT_NODES = 500;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_STRING_CHARS = 1_000;
const MAX_TYPE_TEXT_CHARS = 4_000;
const MAX_SEMANTIC_LOCATOR_CANDIDATES = 20;
const BROWSER_ELEMENT_REF_PATTERN = /^(?:f[1-9][0-9]*)?e[1-9][0-9]*$/;
const SENSITIVE_FIELD_NAME_PATTERN =
  /password|passcode|one.?time|otp|totp|mfa|secret|token|credit|card|cvc|cvv|pin/i;
const EDITABLE_ARIA_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const SNAPSHOT_KEYS = new Set([
  "role",
  "name",
  "text",
  "children",
  "checked",
  "disabled",
  "expanded",
  "active",
  "invalid",
  "level",
  "pressed",
  "selected",
  "placeholder",
  "ref",
  "cursor",
  "url",
]);

/** Opaque identifier for a browser session owned by exactly one Thor session. */
export type BrowserSessionId = string & { readonly __brand: "BrowserSessionId" };

/** Opaque identifier binding element refs to one accessibility snapshot. */
export type BrowserSnapshotId = string & { readonly __brand: "BrowserSnapshotId" };

/** Playwright accessibility ref accepted only after it appeared in the latest snapshot. */
export type BrowserElementRef = string & { readonly __brand: "BrowserElementRef" };

/** Safe recursive value returned from the accessibility snapshot allowlist. */
export type SanitizedAccessibilityValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<SanitizedAccessibilityValue>
  | { readonly [key: string]: SanitizedAccessibilityValue };

/** Safe location metadata that exposes only the approved origin and opaque session ID. */
export interface BrowserSessionLocation {
  readonly browserSessionId: BrowserSessionId;
  readonly origin: BrowserOrigin;
}

/** Bounded accessibility projection whose refs expire after the next browser action. */
export interface BrowserAccessibilitySnapshot extends BrowserSessionLocation {
  readonly snapshotId: BrowserSnapshotId;
  readonly title: string;
  readonly accessibility: SanitizedAccessibilityValue;
}

/** Input required to create an approval-bound authenticated browser. */
export interface OpenAuthenticatedBrowserInput {
  readonly ownerSessionId: string;
  readonly destination: BrowserDestination;
  readonly credentials: LoginCredentials;
}

/** Input shared by browser operations that address an existing session. */
export interface OwnedBrowserSessionInput {
  readonly ownerSessionId: string;
  readonly browserSessionId: BrowserSessionId;
}

/** Input for an action tied to the latest accessibility snapshot. */
export interface BrowserRefActionInput extends OwnedBrowserSessionInput {
  readonly snapshotId: BrowserSnapshotId;
  readonly ref: BrowserElementRef;
}

/** Input for filling a non-secret text control. */
export interface BrowserTypeInput extends BrowserRefActionInput {
  readonly text: string;
}

/** Restricted operations supported by a broker-owned authenticated browser. */
export interface IAuthenticatedBrowserSessions {
  /** Log in with wrapped credentials and retain a short-lived browser session. */
  openAuthenticatedBrowser(
    input: OpenAuthenticatedBrowserInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>>;

  /** Return a sanitized accessibility snapshot without editable values or raw URLs. */
  snapshotBrowser(
    input: OwnedBrowserSessionInput,
  ): Promise<Result<BrowserAccessibilitySnapshot, BrowserSessionError | BrokerRequestDeniedError>>;

  /** Click one ref from the latest snapshot and invalidate all snapshot refs. */
  clickBrowserRef(
    input: BrowserRefActionInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>>;

  /** Fill one ordinary non-secret text control and invalidate all snapshot refs. */
  typeIntoBrowserRef(
    input: BrowserTypeInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>>;

  /** Navigate within the session's exact approved HTTPS origin. */
  navigateBrowser(
    input: OwnedBrowserSessionInput & { readonly destination: BrowserDestination },
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>>;

  /** Destroy one browser session after verifying its owning Thor session. */
  closeBrowser(
    input: OwnedBrowserSessionInput,
  ): Promise<Result<{ readonly status: "closed" }, BrokerRequestDeniedError>>;

  /** Destroy every browser resource owned by this broker process. */
  closeAllBrowsers(): Promise<void>;
}

/** Timer handle abstraction used to make browser inactivity cleanup explicit. */
export interface BrowserSessionTimerHandle {
  cancel(): void;
}

/** Scheduler for the ten-minute browser inactivity lease. */
export interface BrowserSessionScheduler {
  /** Schedule one browser expiration after `delayMs` milliseconds. */
  schedule(delayMs: number, expire: () => void): BrowserSessionTimerHandle;
}

/** Trusted construction options; none are exposed through MCP. */
export interface AuthenticatedBrowserSessionOptions {
  /** Chromium executable selected only by trusted composition code. */
  readonly executablePath?: string;
  /** Per-operation timeout in milliseconds. */
  readonly actionTimeoutMs?: number;
  /** Inactivity lease in milliseconds before browser destruction. */
  readonly idleTimeoutMs?: number;
  /** Maximum number of concurrent browser processes for this broker. */
  readonly maxSessions?: number;
  /** Cryptographically strong v4 UUID source for session and snapshot IDs. */
  readonly createId?: () => string;
  /** Timer capability that owns inactivity cleanup scheduling. */
  readonly scheduler?: BrowserSessionScheduler;
  /** Trusted browser-launch capability; MCP callers cannot select it. */
  readonly launchBrowser?: () => Promise<Browser>;
}

type BrowserSnapshotLease =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "active";
      readonly snapshotId: BrowserSnapshotId;
      readonly refs: ReadonlySet<BrowserElementRef>;
    };

const NO_BROWSER_SNAPSHOT = { _tag: "none" } as const satisfies BrowserSnapshotLease;

interface ActiveBrowserSession {
  readonly id: BrowserSessionId;
  readonly ownerSessionId: string;
  readonly origin: BrowserOrigin;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly sensitiveValues: readonly [LoginCredentials["username"], LoginCredentials["password"]];
  busy: boolean;
  snapshotLease: BrowserSnapshotLease;
  timer: BrowserSessionTimerHandle | undefined;
}

interface SnapshotSanitizerState {
  readonly approvedOrigin: BrowserOrigin;
  readonly secrets: ReadonlyArray<string>;
  readonly refs: Set<BrowserElementRef>;
  nodes: number;
}

class BrowserBoundaryError extends Error {
  readonly code: BrowserSessionError["code"];

  constructor(code: BrowserBoundaryError["code"]) {
    super(`Authenticated browser boundary rejected browser state (${code})`);
    this.code = code;
  }
}

const systemBrowserSessionScheduler: BrowserSessionScheduler = {
  schedule(delayMs, expire) {
    const timer = setTimeout(expire, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

async function launchCredentialFreeChromium(executablePath: string): Promise<Browser> {
  return chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: false,
    env: browserProcessEnvironment(),
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-features=AutofillServerCommunication,PasswordManagerOnboarding",
      "--disable-sync",
      "--no-first-run",
      "--no-sandbox",
      "--password-store=basic",
    ],
  });
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

/** Return whether a browser request remains on one exact approved HTTPS origin. */
export function isApprovedBrowserUrl(value: string, approvedOrigin: BrowserOrigin): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && url.origin === approvedOrigin
    );
  } catch {
    return false;
  }
}

/** Parse an opaque browser element ref emitted by a sanitized snapshot. */
export function parseBrowserElementRef(value: string): BrowserElementRef | undefined {
  if (!BROWSER_ELEMENT_REF_PATTERN.test(value)) return undefined;
  // SAFETY: the private brand records the strict ref grammar checked above.
  return value as BrowserElementRef;
}

function parseUuidBrand<T extends BrowserSessionId | BrowserSnapshotId>(
  value: string,
): T | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  // SAFETY: T can only be one of the two private UUID brands and the grammar was checked above.
  return value as T;
}

/** Parse a broker-issued browser session UUID. */
export function parseBrowserSessionId(value: string): BrowserSessionId | undefined {
  return parseUuidBrand<BrowserSessionId>(value);
}

/** Parse a broker-issued accessibility snapshot UUID. */
export function parseBrowserSnapshotId(value: string): BrowserSnapshotId | undefined {
  return parseUuidBrand<BrowserSnapshotId>(value);
}

function requireGeneratedId<T extends BrowserSessionId | BrowserSnapshotId>(
  createId: () => string,
): T {
  const parsed = parseUuidBrand<T>(createId());
  if (!parsed) {
    throw new Error("Authenticated browser ID generator returned a non-v4 UUID");
  }
  return parsed;
}

function requireApprovedOrigin(page: Page, approvedOrigin: BrowserOrigin): void {
  if (!isApprovedBrowserUrl(page.url(), approvedOrigin)) {
    throw new BrowserBoundaryError("origin_changed");
  }
}

async function visibleLocatorCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  if (count > MAX_SEMANTIC_LOCATOR_CANDIDATES) {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}

async function uniqueVisibleElement(
  candidates: ReadonlyArray<Locator>,
  timeoutMs: number,
): Promise<ElementHandle> {
  for (const candidate of candidates) {
    const count = await visibleLocatorCount(candidate);
    if (count > 1) throw new BrowserBoundaryError("field_missing_or_ambiguous");
    if (count === 0) continue;
    const visible = candidate.filter({ visible: true });
    await visible.waitFor({ state: "visible", timeout: timeoutMs });
    const handle = await visible.elementHandle();
    if (!handle) throw new BrowserBoundaryError("field_missing_or_ambiguous");
    return handle;
  }
  throw new BrowserBoundaryError("field_missing_or_ambiguous");
}

async function usernameElement(page: Page, timeoutMs: number): Promise<ElementHandle> {
  return uniqueVisibleElement(
    [
      page.locator('input[autocomplete="username"]:not([type="password"]):not([type="hidden"])'),
      page.locator('input[type="email"]'),
      page.locator(
        'input:not([type="password"]):not([type="hidden"]):is([name*="user" i], [id*="user" i], [name*="email" i], [id*="email" i], [name*="login" i], [id*="login" i])',
      ),
      page.locator(
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
      ),
    ],
    timeoutMs,
  );
}

async function visiblePasswordCount(page: Page): Promise<number> {
  return visibleLocatorCount(page.locator('input[type="password"]'));
}

async function passwordElement(page: Page, timeoutMs: number): Promise<ElementHandle> {
  const locator = page.locator('input[type="password"]');
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
  return uniqueVisibleElement([locator], timeoutMs);
}

async function submitLocator(page: Page, timeoutMs: number): Promise<Locator> {
  const candidates = [
    page.getByRole("button", { name: /^(sign in|log in|login|continue|next)$/i }),
    page.locator('button[type="submit"], input[type="submit"]'),
    page.getByRole("button", { name: /(sign in|log in|login|continue|next)/i }),
  ];
  for (const candidate of candidates) {
    const count = await visibleLocatorCount(candidate);
    if (count > 1) throw new BrowserBoundaryError("field_missing_or_ambiguous");
    if (count === 0) continue;
    const visible = candidate.filter({ visible: true });
    await visible.waitFor({ state: "visible", timeout: timeoutMs });
    return visible;
  }
  throw new BrowserBoundaryError("field_missing_or_ambiguous");
}

async function requireSafeCredentialInput(
  element: ElementHandle,
  kind: "username" | "password",
  origin: BrowserOrigin,
): Promise<void> {
  const input = await element.evaluate((node) => {
    if (node.tagName.toLowerCase() !== "input") return undefined;
    const form = Reflect.get(node, "form") as
      | { getAttribute(name: string): string | null }
      | null
      | undefined;
    return {
      type: (node.getAttribute("type") ?? "text").toLowerCase(),
      form: form
        ? {
            method: (form.getAttribute("method") ?? "get").toLowerCase(),
            action: new URL(form.getAttribute("action") ?? "", node.ownerDocument.baseURI).href,
            target: form.getAttribute("target") ?? "",
          }
        : undefined,
    };
  });
  const usernameTypes = new Set(["text", "email", "tel"]);
  if (
    !input ||
    (kind === "username" && !usernameTypes.has(input.type)) ||
    (kind === "password" && input.type !== "password") ||
    input.form === undefined ||
    input.form.method !== "post" ||
    (input.form.target !== "" && input.form.target !== "_self") ||
    !isApprovedBrowserUrl(input.form.action, origin)
  ) {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
}

async function requireSafeCredentialSubmit(submit: Locator, origin: BrowserOrigin): Promise<void> {
  const target = await submit.evaluate((node) => {
    const form = Reflect.get(node, "form") as
      | { getAttribute(name: string): string | null }
      | null
      | undefined;
    if (!form) return undefined;
    const formAction = node.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
    return {
      method: (
        node.getAttribute("formmethod") ??
        form.getAttribute("method") ??
        "get"
      ).toLowerCase(),
      action: new URL(formAction, node.ownerDocument.baseURI).href,
      target: node.getAttribute("formtarget") ?? form.getAttribute("target") ?? "",
    };
  });
  if (
    !target ||
    target.method !== "post" ||
    (target.target !== "" && target.target !== "_self") ||
    !isApprovedBrowserUrl(target.action, origin)
  ) {
    throw new BrowserBoundaryError("field_missing_or_ambiguous");
  }
}

async function hasVisibleMfaChallenge(page: Page): Promise<boolean> {
  const locator = page.locator(
    'input:is([autocomplete="one-time-code"], [name="code" i], [id="code" i], [name*="otp" i], [id*="otp" i], [name*="totp" i], [id*="totp" i], [name*="mfa" i], [id*="mfa" i], [name*="2fa" i], [id*="2fa" i], [name*="authenticator" i], [id*="authenticator" i], [name*="verification-code" i], [id*="verification-code" i], [name*="security-code" i], [id*="security-code" i])',
  );
  return (await visibleLocatorCount(locator)) > 0;
}

async function requireAuthenticatedPage(page: Page, origin: BrowserOrigin): Promise<void> {
  requireApprovedOrigin(page, origin);
  if (await hasVisibleMfaChallenge(page)) {
    throw new BrowserBoundaryError("mfa_required");
  }
  if ((await visiblePasswordCount(page)) > 0) {
    throw new BrowserBoundaryError("authentication_not_confirmed");
  }
}

async function waitForAuthentication(page: Page, origin: BrowserOrigin, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let passwordAbsentSince: number | undefined;
  while (Date.now() < deadline) {
    requireApprovedOrigin(page, origin);
    if (await hasVisibleMfaChallenge(page)) {
      throw new BrowserBoundaryError("mfa_required");
    }
    if ((await visiblePasswordCount(page)) === 0) {
      passwordAbsentSince ??= Date.now();
      if (Date.now() - passwordAbsentSince >= 1_000) return;
    } else {
      passwordAbsentSince = undefined;
    }
    await page.waitForTimeout(100);
  }
  throw new BrowserBoundaryError("authentication_not_confirmed");
}

async function clearCredentialElement(element: ElementHandle | undefined): Promise<void> {
  if (!element) return;
  await element.fill("").catch(() => undefined);
  await element.dispose().catch(() => undefined);
}

async function performStandardLogin(
  page: Page,
  credentials: LoginCredentials,
  timeoutMs: number,
): Promise<void> {
  await page.goto(credentials.metadata.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  requireApprovedOrigin(page, credentials.metadata.origin);

  let username: ElementHandle | undefined;
  let password: ElementHandle | undefined;
  try {
    username = await usernameElement(page, timeoutMs);
    const usernameToFill = username;
    requireApprovedOrigin(page, credentials.metadata.origin);
    await requireSafeCredentialInput(usernameToFill, "username", credentials.metadata.origin);
    await withRedactedString(credentials.username, (value) => usernameToFill.fill(value));

    if ((await visiblePasswordCount(page)) === 0) {
      const continueButton = await submitLocator(page, timeoutMs);
      await requireSafeCredentialSubmit(continueButton, credentials.metadata.origin);
      await continueButton.click({ timeout: timeoutMs });
      requireApprovedOrigin(page, credentials.metadata.origin);
    }

    password = await passwordElement(page, timeoutMs);
    const passwordToFill = password;
    requireApprovedOrigin(page, credentials.metadata.origin);
    await requireSafeCredentialInput(passwordToFill, "password", credentials.metadata.origin);
    await withRedactedString(credentials.password, (value) => passwordToFill.fill(value));

    const submit = await submitLocator(page, timeoutMs);
    requireApprovedOrigin(page, credentials.metadata.origin);
    await requireSafeCredentialSubmit(submit, credentials.metadata.origin);
    await submit.click({ timeout: timeoutMs });
    await waitForAuthentication(page, credentials.metadata.origin, timeoutMs);
  } finally {
    await Promise.all([clearCredentialElement(username), clearCredentialElement(password)]);
  }
}

function sanitizeUrlForSnapshot(value: string, approvedOrigin: BrowserOrigin): string {
  try {
    const url = new URL(value, approvedOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== approvedOrigin
    ) {
      return "[blocked-url]";
    }
    return "[same-origin-url]";
  } catch {
    return "[blocked-url]";
  }
}

function knownCredentialValues(username: string, password: string): ReadonlyArray<string> {
  return [...new Set([username, username.toLowerCase(), username.toUpperCase(), password])];
}

function redactKnownSecrets(value: string, secrets: ReadonlyArray<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function sanitizeSnapshotText(value: string, state: SnapshotSanitizerState): string {
  const urlsSanitized = value.replace(/https?:\/\/[^\s<>"']+/gi, (url) =>
    sanitizeUrlForSnapshot(url, state.approvedOrigin),
  );
  return redactKnownSecrets(urlsSanitized, state.secrets).slice(0, MAX_SNAPSHOT_STRING_CHARS);
}

function sanitizeAccessibilityValue(
  value: unknown,
  state: SnapshotSanitizerState,
  depth: number,
): SanitizedAccessibilityValue | undefined {
  if (depth > MAX_SNAPSHOT_DEPTH) return undefined;
  state.nodes += 1;
  if (state.nodes > MAX_SNAPSHOT_NODES) {
    throw new BrowserBoundaryError("snapshot_too_large");
  }
  if (typeof value === "string") return sanitizeSnapshotText(value, state);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    const items: SanitizedAccessibilityValue[] = [];
    for (const item of value) {
      const sanitized = sanitizeAccessibilityValue(item, state, depth + 1);
      if (sanitized !== undefined) items.push(sanitized);
    }
    return items;
  }

  const roleValue = Reflect.get(value, "role");
  const role = typeof roleValue === "string" ? roleValue : undefined;
  const output: Record<string, SanitizedAccessibilityValue> = {};
  let refCandidate: BrowserElementRef | undefined;
  let urlAllowed = true;

  for (const [key, item] of Object.entries(value)) {
    if (!SNAPSHOT_KEYS.has(key)) continue;
    if (key === "text" && role && EDITABLE_ARIA_ROLES.has(role)) continue;
    if (key === "children" && role && EDITABLE_ARIA_ROLES.has(role)) continue;
    if (key === "url") {
      if (typeof item !== "string") continue;
      const sanitizedUrl = sanitizeUrlForSnapshot(item, state.approvedOrigin);
      output.url = sanitizedUrl;
      urlAllowed = sanitizedUrl !== "[blocked-url]";
      continue;
    }
    if (key === "ref") {
      if (typeof item === "string") refCandidate = parseBrowserElementRef(item);
      continue;
    }
    const sanitized = sanitizeAccessibilityValue(item, state, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }

  if (refCandidate && urlAllowed) {
    output.ref = refCandidate;
    state.refs.add(refCandidate);
  }
  return output;
}

/**
 * Convert Playwright's untrusted raw accessibility value into a bounded allowlist,
 * removing editable values and redacting the known Login credentials.
 */
export async function sanitizeBrowserAccessibilitySnapshot(
  rawSnapshot: unknown,
  approvedOrigin: BrowserOrigin,
  credentials: Pick<LoginCredentials, "username" | "password">,
): Promise<
  Result<
    {
      readonly accessibility: SanitizedAccessibilityValue;
      readonly refs: ReadonlySet<BrowserElementRef>;
    },
    BrowserSessionError
  >
> {
  return withRedactedString(credentials.username, (username) =>
    withRedactedString(credentials.password, (password) => {
      const refs = new Set<BrowserElementRef>();
      const state: SnapshotSanitizerState = {
        approvedOrigin,
        secrets: knownCredentialValues(username, password),
        refs,
        nodes: 0,
      };
      try {
        const accessibility = sanitizeAccessibilityValue(rawSnapshot, state, 0);
        if (accessibility === undefined) {
          return err(new BrowserSessionError("snapshot_failed"));
        }
        if (JSON.stringify(accessibility).length > MAX_SNAPSHOT_CHARS) {
          return err(new BrowserSessionError("snapshot_too_large"));
        }
        return ok({ accessibility, refs });
      } catch (error) {
        return err(
          new BrowserSessionError(
            error instanceof BrowserBoundaryError ? error.code : "snapshot_failed",
          ),
        );
      }
    }),
  );
}

async function installBrowserBoundaries(
  context: BrowserContext,
  origin: BrowserOrigin,
): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, "RTCPeerConnection", { value: undefined });
    Object.defineProperty(globalThis, "webkitRTCPeerConnection", { value: undefined });
    Object.defineProperty(globalThis, "WebSocket", { value: undefined });
    Object.defineProperty(globalThis, "WebTransport", { value: undefined });
  });
  await context.routeWebSocket("**/*", (webSocket) => webSocket.close());
  await context.route("**/*", async (route) => {
    try {
      if (isApprovedBrowserUrl(route.request().url(), origin)) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
}

async function browserLocation(session: ActiveBrowserSession): Promise<BrowserSessionLocation> {
  requireApprovedOrigin(session.page, session.origin);
  return {
    browserSessionId: session.id,
    origin: session.origin,
  };
}

async function refLocator(session: ActiveBrowserSession, ref: BrowserElementRef): Promise<Locator> {
  const locator = session.page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) {
    throw new BrokerRequestDeniedError("ref_not_allowed");
  }
  return locator;
}

async function assertOrdinaryTextControl(locator: Locator): Promise<void> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName !== "input" && tagName !== "textarea") {
    throw new BrokerRequestDeniedError("field_not_allowed");
  }

  const type = (await locator.getAttribute("type"))?.toLowerCase() ?? "text";
  const autocomplete = (await locator.getAttribute("autocomplete"))?.toLowerCase() ?? "";
  const identifyingText = [
    await locator.getAttribute("name"),
    await locator.getAttribute("id"),
    await locator.getAttribute("aria-label"),
    await locator.getAttribute("placeholder"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const allowedInputTypes = new Set(["text", "email", "search", "tel", "url"]);
  if (
    (tagName === "input" && !allowedInputTypes.has(type)) ||
    /password|one-time-code|cc-|transaction|new-password|current-password/i.test(autocomplete) ||
    SENSITIVE_FIELD_NAME_PATTERN.test(identifyingText)
  ) {
    throw new BrokerRequestDeniedError("field_not_allowed");
  }
}

/** Playwright implementation that owns all authenticated browser resources in memory. */
export class PlaywrightAuthenticatedBrowserSessions implements IAuthenticatedBrowserSessions {
  readonly #executablePath: string;
  readonly #actionTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #maxSessions: number;
  readonly #createId: () => string;
  readonly #scheduler: BrowserSessionScheduler;
  readonly #launchBrowser: () => Promise<Browser>;
  readonly #sessions = new Map<BrowserSessionId, ActiveBrowserSession>();
  readonly #ownerSessions = new Map<string, BrowserSessionId>();
  readonly #openingOwners = new Set<string>();

  /** Create the trusted browser resource owner with bounded session policy. */
  constructor(options: AuthenticatedBrowserSessionOptions = {}) {
    this.#executablePath = options.executablePath ?? "/usr/bin/chromium";
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#createId = options.createId ?? randomUUID;
    this.#scheduler = options.scheduler ?? systemBrowserSessionScheduler;
    this.#launchBrowser =
      options.launchBrowser ?? (() => launchCredentialFreeChromium(this.#executablePath));
    if (this.#actionTimeoutMs < 1_000 || this.#idleTimeoutMs < 1_000 || this.#maxSessions < 1) {
      throw new Error("Authenticated browser session options violate minimum bounds");
    }
  }

  #scheduleExpiration(session: ActiveBrowserSession): void {
    session.timer?.cancel();
    session.timer = this.#scheduler.schedule(this.#idleTimeoutMs, () => {
      void this.#expireBrowser(session.id);
    });
  }

  async #expireBrowser(browserSessionId: BrowserSessionId): Promise<void> {
    const session = this.#sessions.get(browserSessionId);
    if (!session) return;
    if (session.busy) {
      this.#scheduleExpiration(session);
      return;
    }
    await this.#destroySession(session);
  }

  async #destroySession(session: ActiveBrowserSession): Promise<void> {
    this.#sessions.delete(session.id);
    this.#ownerSessions.delete(session.ownerSessionId);
    session.timer?.cancel();
    session.snapshotLease = NO_BROWSER_SNAPSHOT;
    await Promise.allSettled([session.context.close(), session.browser.close()]);
  }

  #acquireOwnedSession(
    input: OwnedBrowserSessionInput,
  ): Result<ActiveBrowserSession, BrokerRequestDeniedError> {
    const session = this.#sessions.get(input.browserSessionId);
    if (!session) return err(new BrokerRequestDeniedError("session_not_found"));
    if (session.ownerSessionId !== input.ownerSessionId) {
      return err(new BrokerRequestDeniedError("session_owner_mismatch"));
    }
    if (session.busy) return err(new BrokerRequestDeniedError("session_busy"));
    session.busy = true;
    session.timer?.cancel();
    return ok(session);
  }

  #releaseSession(session: ActiveBrowserSession): void {
    if (!this.#sessions.has(session.id)) return;
    session.busy = false;
    this.#scheduleExpiration(session);
  }

  #consumeSnapshotRef(
    session: ActiveBrowserSession,
    input: BrowserRefActionInput,
  ): Result<void, BrokerRequestDeniedError> {
    if (
      session.snapshotLease._tag !== "active" ||
      session.snapshotLease.snapshotId !== input.snapshotId ||
      !session.snapshotLease.refs.has(input.ref)
    ) {
      return err(new BrokerRequestDeniedError("stale_snapshot"));
    }
    session.snapshotLease = NO_BROWSER_SNAPSHOT;
    return ok(undefined);
  }

  /** Log in and retain one browser only when the owner and global limits permit it. */
  async openAuthenticatedBrowser(
    input: OpenAuthenticatedBrowserInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>> {
    if (input.destination.origin !== input.credentials.metadata.origin) {
      return err(new BrokerRequestDeniedError("origin_not_allowed"));
    }
    if (
      this.#ownerSessions.has(input.ownerSessionId) ||
      this.#openingOwners.has(input.ownerSessionId)
    ) {
      return err(new BrokerRequestDeniedError("session_limit_reached"));
    }
    if (this.#sessions.size + this.#openingOwners.size >= this.#maxSessions) {
      return err(new BrokerRequestDeniedError("session_limit_reached"));
    }

    this.#openingOwners.add(input.ownerSessionId);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let retainedSession: ActiveBrowserSession | undefined;
    try {
      browser = await this.#launchBrowser();
      context = await browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
      });
      await installBrowserBoundaries(context, input.credentials.metadata.origin);
      const page = await context.newPage();
      page.setDefaultTimeout(this.#actionTimeoutMs);
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
      page.on("download", (download) => void download.cancel().catch(() => undefined));
      page.on("filechooser", (chooser) => void chooser.setFiles([]).catch(() => undefined));
      context.on("page", (openedPage) => {
        if (openedPage !== page) void openedPage.close().catch(() => undefined);
      });

      await performStandardLogin(page, input.credentials, this.#actionTimeoutMs);
      requireApprovedOrigin(page, input.credentials.metadata.origin);
      if (input.destination.url !== page.url()) {
        await page.goto(input.destination.url, {
          waitUntil: "domcontentloaded",
          timeout: this.#actionTimeoutMs,
        });
      }
      await requireAuthenticatedPage(page, input.credentials.metadata.origin);

      const id = requireGeneratedId<BrowserSessionId>(this.#createId);
      if (this.#sessions.has(id)) {
        throw new Error("Authenticated browser ID generator returned a duplicate session UUID");
      }
      const session: ActiveBrowserSession = {
        id,
        ownerSessionId: input.ownerSessionId,
        origin: input.credentials.metadata.origin,
        browser,
        context,
        page,
        sensitiveValues: [input.credentials.username, input.credentials.password],
        busy: false,
        snapshotLease: NO_BROWSER_SNAPSHOT,
        timer: undefined,
      };
      const location = await browserLocation(session);
      this.#sessions.set(id, session);
      this.#ownerSessions.set(input.ownerSessionId, id);
      retainedSession = session;
      this.#scheduleExpiration(session);
      return ok(location);
    } catch (error) {
      if (retainedSession) {
        await this.#destroySession(retainedSession);
      } else {
        await Promise.allSettled([context?.close(), browser?.close()]);
      }
      if (error instanceof BrokerRequestDeniedError) return err(error);
      if (error instanceof BrowserBoundaryError) {
        return err(new BrowserSessionError(error.code));
      }
      return err(
        new BrowserSessionError(
          browser === undefined ? "browser_unavailable" : "browser_flow_failed",
        ),
      );
    } finally {
      this.#openingOwners.delete(input.ownerSessionId);
    }
  }

  /** Return a sanitized snapshot and replace every previously issued ref. */
  async snapshotBrowser(
    input: OwnedBrowserSessionInput,
  ): Promise<Result<BrowserAccessibilitySnapshot, BrowserSessionError | BrokerRequestDeniedError>> {
    const acquired = this.#acquireOwnedSession(input);
    if (acquired._tag === "err") return acquired;
    const session = acquired.value;
    try {
      await requireAuthenticatedPage(session.page, session.origin);
      session.snapshotLease = NO_BROWSER_SNAPSHOT;
      const rawSnapshot = await session.page.ariaSnapshotJSON({
        mode: "ai",
        depth: MAX_SNAPSHOT_DEPTH,
        timeout: this.#actionTimeoutMs,
      });
      const sanitized = await sanitizeBrowserAccessibilitySnapshot(rawSnapshot, session.origin, {
        username: session.sensitiveValues[0],
        password: session.sensitiveValues[1],
      });
      if (sanitized._tag === "err") return sanitized;
      const snapshotId = requireGeneratedId<BrowserSnapshotId>(this.#createId);
      session.snapshotLease = {
        _tag: "active",
        snapshotId,
        refs: sanitized.value.refs,
      };
      const location = await browserLocation(session);
      const rawTitle = await session.page.title();
      const safeTitle = await withRedactedString(session.sensitiveValues[0], (username) =>
        withRedactedString(session.sensitiveValues[1], (password) =>
          sanitizeSnapshotText(rawTitle, {
            approvedOrigin: session.origin,
            secrets: knownCredentialValues(username, password),
            refs: new Set(),
            nodes: 0,
          }),
        ),
      );
      return ok({
        ...location,
        snapshotId,
        title: safeTitle,
        accessibility: sanitized.value.accessibility,
      });
    } catch (error) {
      await this.#destroySession(session);
      if (error instanceof BrowserBoundaryError) {
        return err(new BrowserSessionError(error.code));
      }
      return err(new BrowserSessionError("snapshot_failed"));
    } finally {
      this.#releaseSession(session);
    }
  }

  /** Click one latest-snapshot ref without exposing selectors or handles. */
  async clickBrowserRef(
    input: BrowserRefActionInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>> {
    const acquired = this.#acquireOwnedSession(input);
    if (acquired._tag === "err") return acquired;
    const session = acquired.value;
    try {
      const consumed = this.#consumeSnapshotRef(session, input);
      if (consumed._tag === "err") return consumed;
      await requireAuthenticatedPage(session.page, session.origin);
      const locator = await refLocator(session, input.ref);
      if ((await locator.getAttribute("type"))?.toLowerCase() === "file") {
        return err(new BrokerRequestDeniedError("field_not_allowed"));
      }
      await locator.click({ timeout: this.#actionTimeoutMs });
      await requireAuthenticatedPage(session.page, session.origin);
      return ok(await browserLocation(session));
    } catch (error) {
      if (error instanceof BrokerRequestDeniedError) return err(error);
      if (error instanceof BrowserBoundaryError) {
        await this.#destroySession(session);
        return err(new BrowserSessionError(error.code));
      }
      await this.#destroySession(session);
      return err(new BrowserSessionError("action_failed"));
    } finally {
      this.#releaseSession(session);
    }
  }

  /** Fill one allowed text control without echoing or retaining the supplied text. */
  async typeIntoBrowserRef(
    input: BrowserTypeInput,
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>> {
    if (!input.text || input.text.length > MAX_TYPE_TEXT_CHARS) {
      return err(new BrokerRequestDeniedError("field_not_allowed"));
    }
    const acquired = this.#acquireOwnedSession(input);
    if (acquired._tag === "err") return acquired;
    const session = acquired.value;
    try {
      const consumed = this.#consumeSnapshotRef(session, input);
      if (consumed._tag === "err") return consumed;
      await requireAuthenticatedPage(session.page, session.origin);
      const locator = await refLocator(session, input.ref);
      await assertOrdinaryTextControl(locator);
      await locator.fill(input.text, { timeout: this.#actionTimeoutMs });
      await requireAuthenticatedPage(session.page, session.origin);
      return ok(await browserLocation(session));
    } catch (error) {
      if (error instanceof BrokerRequestDeniedError) return err(error);
      if (error instanceof BrowserBoundaryError) {
        await this.#destroySession(session);
        return err(new BrowserSessionError(error.code));
      }
      await this.#destroySession(session);
      return err(new BrowserSessionError("action_failed"));
    } finally {
      this.#releaseSession(session);
    }
  }

  /** Navigate to a parsed destination only when it has the session's exact origin. */
  async navigateBrowser(
    input: OwnedBrowserSessionInput & { readonly destination: BrowserDestination },
  ): Promise<Result<BrowserSessionLocation, BrowserSessionError | BrokerRequestDeniedError>> {
    const acquired = this.#acquireOwnedSession(input);
    if (acquired._tag === "err") return acquired;
    const session = acquired.value;
    session.snapshotLease = NO_BROWSER_SNAPSHOT;
    try {
      if (input.destination.origin !== session.origin) {
        return err(new BrokerRequestDeniedError("origin_not_allowed"));
      }
      await session.page.goto(input.destination.url, {
        waitUntil: "domcontentloaded",
        timeout: this.#actionTimeoutMs,
      });
      await requireAuthenticatedPage(session.page, session.origin);
      return ok(await browserLocation(session));
    } catch (error) {
      if (error instanceof BrowserBoundaryError) {
        await this.#destroySession(session);
        return err(new BrowserSessionError(error.code));
      }
      await this.#destroySession(session);
      return err(new BrowserSessionError("action_failed"));
    } finally {
      this.#releaseSession(session);
    }
  }

  /** Close one browser only for the Thor session that opened it. */
  async closeBrowser(
    input: OwnedBrowserSessionInput,
  ): Promise<Result<{ readonly status: "closed" }, BrokerRequestDeniedError>> {
    const session = this.#sessions.get(input.browserSessionId);
    if (!session) return err(new BrokerRequestDeniedError("session_not_found"));
    if (session.ownerSessionId !== input.ownerSessionId) {
      return err(new BrokerRequestDeniedError("session_owner_mismatch"));
    }
    if (session.busy) return err(new BrokerRequestDeniedError("session_busy"));
    session.busy = true;
    await this.#destroySession(session);
    return ok({ status: "closed" });
  }

  /** Close every context/browser when the MCP process disconnects or shuts down. */
  async closeAllBrowsers(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.values()].map((session) => this.#destroySession(session)),
    );
  }
}

/** Maximum text length accepted by the non-secret browser typing tool. */
export const browserTypeTextMaxChars = MAX_TYPE_TEXT_CHARS;
