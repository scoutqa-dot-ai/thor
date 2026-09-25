import { describe, expect, it } from "vitest";
import { parseBrowserDestinationUrl } from "./config.ts";
import {
  deriveBrowserLoginRoute,
  isApprovedBrowserLoginCallback,
  isSanitizedApplicationPage,
} from "./browser-login-route.ts";

function applicationDestination() {
  const parsed = parseBrowserDestinationUrl("https://app.example.com/dashboard");
  if (parsed._tag === "err") throw parsed.error;
  return parsed.value;
}

describe("browser login route", () => {
  it("derives same-origin and delegated application login routes", () => {
    const application = applicationDestination();
    expect(deriveBrowserLoginRoute(application, "https://app.example.com/login")).toEqual({
      _tag: "same_origin",
      application,
      credentialOrigin: "https://app.example.com",
    });
    expect(
      deriveBrowserLoginRoute(
        application,
        "https://identity.example.net/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&client_id=fixture",
      ),
    ).toEqual({
      _tag: "delegated",
      application,
      credentialOrigin: "https://identity.example.net",
      callbackPath: "/auth/callback",
    });
  });

  it.each([
    ["missing redirect", "https://identity.example.net/authorize"],
    [
      "foreign callback",
      "https://identity.example.net/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
    ],
    [
      "callback query",
      "https://identity.example.net/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback%3Ftoken%3Dfixture",
    ],
    [
      "duplicate redirect",
      "https://identity.example.net/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&redirect_uri=https%3A%2F%2Fapp.example.com%2Fother",
    ],
  ])("rejects delegated discovery with %s", async (_label, url) => {
    expect(deriveBrowserLoginRoute(applicationDestination(), url)).toBeUndefined();
  });

  it("accepts only the exact authorization-code callback and sanitized application page", () => {
    const route = deriveBrowserLoginRoute(
      applicationDestination(),
      "https://identity.example.net/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback",
    );
    if (!route || route._tag !== "delegated") throw new Error("missing delegated route fixture");

    expect(
      isApprovedBrowserLoginCallback(
        "https://app.example.com/auth/callback?code=fixture-code&state=fixture-state&session_state=fixture-session",
        route,
      ),
    ).toBe(true);
    expect(
      isApprovedBrowserLoginCallback(
        "https://app.example.com/auth/callback?code=fixture-code&state=fixture-state&token=unexpected",
        route,
      ),
    ).toBe(false);
    expect(
      isApprovedBrowserLoginCallback(
        "https://app.example.com/auth/callback#access_token=fixture",
        route,
      ),
    ).toBe(false);
    expect(
      isSanitizedApplicationPage("https://app.example.com/dashboard", route.application.origin),
    ).toBe(true);
    expect(
      isSanitizedApplicationPage(
        "https://app.example.com/auth/callback?code=fixture-code",
        route.application.origin,
      ),
    ).toBe(false);
  });
});
