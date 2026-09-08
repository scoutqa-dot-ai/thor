import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drataApiGet, resetDrataClientForTests } from "./drata.js";

describe("drata client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DRATA_OAUTH_TOKEN_URL: "https://auth.example.test/oauth/token",
      DRATA_CLIENT_ID: "client-id",
      DRATA_CLIENT_SECRET: "client-secret",
      DRATA_AUDIENCE: "https://api.example.test",
      DRATA_SCOPES: "read:controls",
      DRATA_API_BASE_URL: "https://api.example.test",
    };
    resetDrataClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    resetDrataClientForTests();
  });

  it("mints an OAuth token and uses it for Drata API GET requests", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "https://auth.example.test/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: "client-id",
          client_secret: "client-secret",
          audience: "https://api.example.test",
          grant_type: "client_credentials",
          scope: "read:controls",
        });
        return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(url)).toBe("https://api.example.test/public/v2/controls");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer token-1" });
      return new Response(JSON.stringify({ data: [{ id: "control-1" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(drataApiGet("/public/v2/controls")).resolves.toEqual({ data: [{ id: "control-1" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached access token", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await drataApiGet("/public/v2/controls");
    await drataApiGet("/public/v2/users");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/token"))).toHaveLength(1);
  });
});
