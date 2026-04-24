import { readFile } from "node:fs/promises";

interface ServiceHealth {
  status: "ok" | "error";
  [key: string]: unknown;
}

interface CodexUsage {
  status: "ok" | "error" | "no_auth";
  authenticated: boolean;
  reachable: boolean;
  planType?: string;
  rateLimit?: {
    allowed?: boolean;
    limitReached?: boolean;
    windows: Array<{
      name: string;
      usedPercent?: number;
      limitWindowSeconds?: number;
      resetAfterSeconds?: number;
      resetAt?: string;
      limitName?: string;
      meteredFeature?: string;
    }>;
  };
  httpStatus?: number;
  error?: string;
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNumberField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function getBooleanField(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function formatUnixTimestamp(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function extractRateLimitWindow(
  name: string,
  source: Record<string, unknown> | undefined,
  extra?: { limitName?: string; meteredFeature?: string },
): NonNullable<CodexUsage["rateLimit"]>["windows"][number] | undefined {
  if (!source) return undefined;
  const window = {
    name,
    usedPercent: getNumberField(source, ["used_percent"]),
    limitWindowSeconds: getNumberField(source, ["limit_window_seconds"]),
    resetAfterSeconds: getNumberField(source, ["reset_after_seconds"]),
    resetAt: formatUnixTimestamp(getNumberField(source, ["reset_at"])),
    ...(extra?.limitName ? { limitName: extra.limitName } : {}),
    ...(extra?.meteredFeature ? { meteredFeature: extra.meteredFeature } : {}),
  };
  return Object.entries(window).some(([key, value]) => key === "name" || value !== undefined)
    ? window
    : undefined;
}

function extractCodexUsageSummary(payload: unknown): Pick<CodexUsage, "planType" | "rateLimit"> {
  const root = getObject(payload);
  if (!root) return {};

  const rateLimitRoot = getObject(root.rate_limit);
  const windows: NonNullable<CodexUsage["rateLimit"]>["windows"] = [];
  const pushWindow = (
    name: string,
    source: Record<string, unknown> | undefined,
    extra?: { limitName?: string; meteredFeature?: string },
  ) => {
    const window = extractRateLimitWindow(name, source, extra);
    if (window) windows.push(window);
  };

  pushWindow("primary", getObject(rateLimitRoot?.primary_window));
  pushWindow("secondary", getObject(rateLimitRoot?.secondary_window));

  const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
  for (const item of additional) {
    const entry = getObject(item);
    if (!entry) continue;
    const limitName = getStringField(entry, ["limit_name"]);
    const meteredFeature = getStringField(entry, ["metered_feature"]);
    const nestedRateLimit = getObject(entry.rate_limit);
    pushWindow("primary", getObject(nestedRateLimit?.primary_window), {
      limitName,
      meteredFeature,
    });
    pushWindow("secondary", getObject(nestedRateLimit?.secondary_window), {
      limitName,
      meteredFeature,
    });
  }

  return {
    ...(getStringField(root, ["plan_type"])
      ? { planType: getStringField(root, ["plan_type"]) }
      : {}),
    ...(rateLimitRoot || windows.length > 0
      ? {
          rateLimit: {
            allowed: rateLimitRoot ? getBooleanField(rateLimitRoot, ["allowed"]) : undefined,
            limitReached: rateLimitRoot
              ? getBooleanField(rateLimitRoot, ["limit_reached"])
              : undefined,
            windows,
          },
        }
      : {}),
  };
}

export interface HealthCheckResult {
  status: "ok" | "degraded" | "error";
  service: "gateway";
  services: Record<string, ServiceHealth>;
  codex?: CodexUsage;
}

async function checkService(url: string, fetchImpl?: typeof fetch): Promise<ServiceHealth> {
  const fetchFn = fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { status: "error", error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return { status: "ok", ...json };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkCodexUsage(authPath: string, fetchImpl?: typeof fetch): Promise<CodexUsage> {
  const fetchFn = fetchImpl ?? fetch;
  try {
    const raw = await readFile(authPath, "utf8");
    const auth = JSON.parse(raw);
    const accessToken = auth?.openai?.access;
    if (!accessToken) {
      return {
        status: "no_auth",
        authenticated: false,
        reachable: false,
        error: "missing access token",
      };
    }

    const res = await fetchFn("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return {
        status: "error",
        authenticated: true,
        reachable: false,
        httpStatus: res.status,
        error: `usage endpoint returned HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as Record<string, unknown>;
    return {
      status: "ok",
      authenticated: true,
      reachable: true,
      ...extractCodexUsageSummary(json),
    };
  } catch (err) {
    return {
      status: "error",
      authenticated: false,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface HealthCheckDeps {
  runnerUrl: string;
  slackMcpUrl: string;
  remoteCliHost: string;
  remoteCliPort: number;
  openaiAuthPath?: string;
  fetchImpl?: typeof fetch;
}

export async function deepHealthCheck(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const remoteCliUrl = `http://${deps.remoteCliHost}:${deps.remoteCliPort}`;

  const [runner, slackMcp, remoteCli, codex] = await Promise.all([
    checkService(deps.runnerUrl, deps.fetchImpl),
    checkService(deps.slackMcpUrl, deps.fetchImpl),
    checkService(remoteCliUrl, deps.fetchImpl),
    deps.openaiAuthPath
      ? checkCodexUsage(deps.openaiAuthPath, deps.fetchImpl)
      : Promise.resolve(undefined),
  ]);

  const services = { runner, "slack-mcp": slackMcp, "remote-cli": remoteCli };
  const allServicesOk = Object.values(services).every((s) => s.status === "ok");
  const codexOk = !codex || codex.status === "ok" || codex.status === "no_auth";

  return {
    status: allServicesOk && codexOk ? "ok" : allServicesOk ? "degraded" : "error",
    service: "gateway",
    services,
    ...(codex ? { codex } : {}),
  };
}
