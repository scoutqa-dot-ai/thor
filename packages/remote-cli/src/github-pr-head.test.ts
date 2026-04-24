import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { generateAppJWTMock, mintInstallationTokenMock } = vi.hoisted(() => ({
  generateAppJWTMock: vi.fn(),
  mintInstallationTokenMock: vi.fn(),
}));

vi.mock("./github-app-auth.js", () => ({
  generateAppJWT: generateAppJWTMock,
  mintInstallationToken: mintInstallationTokenMock,
}));

import { createRemoteCliApp } from "./index.js";

describe("remote-cli github pr-head endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  const originalFetch = global.fetch;
  const originalEnv = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    GITHUB_API_URL: process.env.GITHUB_API_URL,
  };

  function mockGithubApiFetch(
    handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) {
    global.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }
      return handler(input, init);
    });
  }

  beforeEach(async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/github-app.pem";
    process.env.GITHUB_API_URL = "https://api.github.test";

    generateAppJWTMock.mockReset().mockReturnValue("app-jwt");
    mintInstallationTokenMock.mockReset().mockResolvedValue({
      token: "installation-token",
      expires_at: "2026-04-30T00:00:00Z",
    });

    const remoteCli = createRemoteCliApp();
    closeRemoteCli = remoteCli.close;

    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeRemoteCli();

    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns PR head ref and repo full name", async () => {
    mockGithubApiFetch(async () =>
      new Response(
        JSON.stringify({
          head: {
            ref: "feature/refactor",
            repo: { full_name: "ScoutQA-Dot-AI/Thor" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await fetch(
      `${baseUrl}/github/pr-head?installation=126669985&repo=scoutqa-dot-ai/thor&number=42`,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ ref: "feature/refactor", headRepoFullName: "scoutqa-dot-ai/thor" });
    expect(generateAppJWTMock).toHaveBeenCalledWith("12345", "/tmp/github-app.pem");
    expect(mintInstallationTokenMock).toHaveBeenCalledWith(126669985, "app-jwt", "https://api.github.test");
  });

  it("returns 404 when pull request is not found", async () => {
    mockGithubApiFetch(async () => new Response("missing", { status: 404 }));

    const response = await fetch(
      `${baseUrl}/github/pr-head?installation=126669985&repo=scoutqa-dot-ai/thor&number=404`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("maps 403 token mint failures to installation_gone", async () => {
    mintInstallationTokenMock.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    const githubFetch = vi.fn<typeof fetch>();
    mockGithubApiFetch(githubFetch);

    const response = await fetch(
      `${baseUrl}/github/pr-head?installation=126669985&repo=scoutqa-dot-ai/thor&number=42`,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "installation_gone" });
    expect(githubFetch).not.toHaveBeenCalled();
  });
});
