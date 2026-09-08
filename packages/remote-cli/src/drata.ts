/**
 * Drata API client using OAuth 2.0 client credentials.
 *
 * Credentials and tokens stay inside remote-cli. The OpenCode agent only sees
 * the `drata` wrapper, which forwards allowed read-only requests here.
 */

import { loadDrataEnv } from "@thor/common";

const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface DrataTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let configCache: ReturnType<typeof loadDrataEnv> | null = null;
let tokenCache: CachedToken | null = null;

function config() {
  if (!configCache) configCache = loadDrataEnv();
  return configCache;
}

export function resetDrataClientForTests(): void {
  configCache = null;
  tokenCache = null;
}

async function requestAccessToken(): Promise<CachedToken> {
  const { tokenUrl, clientId, clientSecret, audience, scopes } = config();
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      grant_type: "client_credentials",
      scope: scopes,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drata OAuth token request failed → ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as DrataTokenResponse;
  if (!json.access_token) {
    throw new Error("Drata OAuth token response did not include access_token");
  }

  const expiresInSeconds = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return tokenCache.accessToken;
  }

  tokenCache = await requestAccessToken();
  return tokenCache.accessToken;
}

export async function drataApiGet(path: string): Promise<unknown> {
  const { apiBaseUrl } = config();
  const token = await getAccessToken();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Drata GET ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
