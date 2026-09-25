import { parseBrowserOrigin, type BrowserDestination, type BrowserOrigin } from "./config.ts";

const CALLBACK_QUERY_KEYS = new Set(["code", "iss", "session_state", "state"]);
const MAX_LOGIN_ROUTE_URL_CHARS = 12_000;
const MAX_CALLBACK_PARAMETER_CHARS = 4_096;

/** Same-origin login route where credentials and the retained application share one origin. */
export interface SameOriginBrowserLoginRoute {
  readonly _tag: "same_origin";
  readonly application: BrowserDestination;
  readonly credentialOrigin: BrowserOrigin;
}

/** Delegated OAuth/OIDC route with one credential origin and one exact application callback path. */
export interface DelegatedBrowserLoginRoute {
  readonly _tag: "delegated";
  readonly application: BrowserDestination;
  readonly credentialOrigin: BrowserOrigin;
  readonly callbackPath: string;
}

/** Broker-observed login route frozen before credential approval. */
export type BrowserLoginRoute = SameOriginBrowserLoginRoute | DelegatedBrowserLoginRoute;

/**
 * Derive a bounded login route from the credential-free browser's final login page.
 * Delegated routes require one standard redirect_uri returning to the application origin.
 */
export function deriveBrowserLoginRoute(
  application: BrowserDestination,
  credentialPageUrl: string,
): BrowserLoginRoute | undefined {
  if (credentialPageUrl.length > MAX_LOGIN_ROUTE_URL_CHARS) return undefined;
  let credentialPage: URL;
  try {
    credentialPage = new URL(credentialPageUrl);
  } catch {
    return undefined;
  }
  const credentialOrigin = parseBrowserOrigin(credentialPage.href);
  if (!credentialOrigin || credentialPage.hash) return undefined;
  if (credentialOrigin === application.origin) {
    return { _tag: "same_origin", application, credentialOrigin };
  }

  const redirectUris = credentialPage.searchParams.getAll("redirect_uri");
  if (redirectUris.length !== 1) return undefined;
  const redirectUri = redirectUris[0];
  if (!redirectUri || redirectUri.length > 2_000) return undefined;
  let callback: URL;
  try {
    callback = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.origin !== application.origin ||
    callback.search ||
    callback.hash ||
    !callback.pathname.startsWith("/")
  ) {
    return undefined;
  }
  return {
    _tag: "delegated",
    application,
    credentialOrigin,
    callbackPath: callback.pathname,
  };
}

/** Return whether a top-level URL is the exact approved OAuth authorization-code callback. */
export function isApprovedBrowserLoginCallback(
  value: string,
  route: DelegatedBrowserLoginRoute,
): boolean {
  if (value.length > MAX_LOGIN_ROUTE_URL_CHARS) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== route.application.origin ||
      url.pathname !== route.callbackPath ||
      url.hash
    ) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (!CALLBACK_QUERY_KEYS.has(key)) return false;
    }
    const codes = url.searchParams.getAll("code");
    const states = url.searchParams.getAll("state");
    const issuers = url.searchParams.getAll("iss");
    const sessionStates = url.searchParams.getAll("session_state");
    const code = codes.length === 1 ? codes[0] : undefined;
    const state = states.length === 1 ? states[0] : undefined;
    return Boolean(
      code &&
      state &&
      code.length <= MAX_CALLBACK_PARAMETER_CHARS &&
      state.length <= MAX_CALLBACK_PARAMETER_CHARS &&
      issuers.length <= 1 &&
      sessionStates.length <= 1 &&
      (issuers[0]?.length ?? 0) <= MAX_CALLBACK_PARAMETER_CHARS &&
      (sessionStates[0]?.length ?? 0) <= MAX_CALLBACK_PARAMETER_CHARS,
    );
  } catch {
    return false;
  }
}

/** Return whether a completed callback has removed all bearer-like URL parameters. */
export function isSanitizedApplicationPage(value: string, origin: BrowserOrigin): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === origin &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
