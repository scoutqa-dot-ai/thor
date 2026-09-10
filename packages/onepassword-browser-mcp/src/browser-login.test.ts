import { describe, expect, it } from "vitest";
import {
  browserProcessEnvironment,
  isApprovedBrowserUrl,
  isSuccessfulLoginUrl,
} from "./browser-login.ts";

const ORIGIN = "https://accounts.lambdatest.com";

describe("browser process boundary", () => {
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
    expect(environment).not.toHaveProperty("ONEPASSWORD_BROWSER_CONFIG");
  });
});

describe("browser URL policy", () => {
  it("allows only HTTPS requests on the exact configured origin", () => {
    expect(isApprovedBrowserUrl(`${ORIGIN}/login`, ORIGIN)).toBe(true);
    expect(isApprovedBrowserUrl("https://evil.example/login", ORIGIN)).toBe(false);
    expect(isApprovedBrowserUrl("https://accounts.lambdatest.com.evil.example", ORIGIN)).toBe(
      false,
    );
    expect(isApprovedBrowserUrl("http://accounts.lambdatest.com/login", ORIGIN)).toBe(false);
    expect(isApprovedBrowserUrl("https://user:pass@accounts.lambdatest.com/login", ORIGIN)).toBe(
      false,
    );
    expect(isApprovedBrowserUrl("not a url", ORIGIN)).toBe(false);
  });

  it("requires the same origin and a path-segment-aware success prefix", () => {
    expect(isSuccessfulLoginUrl(`${ORIGIN}/dashboard`, ORIGIN, "/dashboard")).toBe(true);
    expect(isSuccessfulLoginUrl(`${ORIGIN}/dashboard/audit`, ORIGIN, "/dashboard")).toBe(true);
    expect(isSuccessfulLoginUrl(`${ORIGIN}/dashboard-evil`, ORIGIN, "/dashboard")).toBe(false);
    expect(isSuccessfulLoginUrl("https://evil.example/dashboard", ORIGIN, "/dashboard")).toBe(
      false,
    );
  });
});
