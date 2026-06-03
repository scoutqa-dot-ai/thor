import { describe, expect, it } from "vitest";
import { getAvailableProxyNames, PROXY_NAMES, resolveProxyConfig } from "./proxies.ts";

const FULL_ENV: NodeJS.ProcessEnv = {
  ATLASSIAN_AUTH: "Basic global",
  POSTHOG_API_KEY: "phc_global",
  GRAFANA_URL: "https://grafana.global",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
  LANGFUSE_PUBLIC_KEY: "pk-global",
  LANGFUSE_SECRET_KEY: "sk-global",
  LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
};

describe("proxy registry", () => {
  it("exposes the expected hardcoded upstreams", () => {
    expect(resolveProxyConfig("atlassian", undefined, FULL_ENV)?.upstream.url).toBe(
      "https://mcp.atlassian.com/v1/mcp",
    );
    expect(resolveProxyConfig("grafana", undefined, FULL_ENV)?.allow).toEqual(
      expect.arrayContaining(["query_prometheus", "list_prometheus_metric_names"]),
    );
    expect(resolveProxyConfig("posthog", undefined, FULL_ENV)?.allow).toContain("query-run");
    expect(resolveProxyConfig("unknown", undefined, FULL_ENV)).toBeUndefined();
  });

  it("resolves profile-scoped auth with global fallback", () => {
    const env = {
      ATLASSIAN_AUTH: "Basic global",
      ATLASSIAN_AUTH_LABS: "Basic labs",
      POSTHOG_API_KEY: "phc_global",
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("atlassian", "LABS", env)?.upstream.headers).toEqual({
      Authorization: "Basic labs",
    });
    expect(resolveProxyConfig("atlassian", "QA", env)?.upstream.headers).toEqual({
      Authorization: "Basic global",
    });
    expect(resolveProxyConfig("posthog", "LABS", env)?.upstream.headers?.Authorization).toBe(
      "Bearer phc_global",
    );
  });

  it("resolves grafana as a bundle scoped to the profile suffix", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_URL_LABS: "https://grafana.labs",
      GRAFANA_SERVICE_ACCOUNT_TOKEN_LABS: "labs-token",
      GRAFANA_ORG_ID_LABS: "7",
      ATLASSIAN_AUTH_LABS: "Basic labs",
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("grafana", "LABS", env)?.upstream.headers).toEqual({
      "X-Grafana-URL": "https://grafana.labs",
      "X-Grafana-Service-Account-Token": "labs-token",
      "X-Grafana-Org-Id": "7",
    });
    expect(resolveProxyConfig("grafana", "QA", env)?.upstream.headers).toEqual({
      "X-Grafana-URL": "https://grafana.global",
      "X-Grafana-Service-Account-Token": "global-token",
    });
    expect(getAvailableProxyNames("LABS", env)).toEqual(["atlassian", "grafana"]);
  });

  it("fails hard on a partial grafana profile bundle instead of silently using globals", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_URL_QA: "https://grafana.qa",
      // GRAFANA_SERVICE_ACCOUNT_TOKEN_QA intentionally missing.
    } as NodeJS.ProcessEnv;

    expect(() => resolveProxyConfig("grafana", "QA", env)).toThrow(
      /partial grafana profile bundle/i,
    );
  });

  it("resolves langfuse as a per-profile base64 basic-auth bundle with its own host", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com/",
      LANGFUSE_PUBLIC_KEY_EU: "pk-eu",
      LANGFUSE_SECRET_KEY_EU: "sk-eu",
      LANGFUSE_BASE_URL_EU: "https://cloud.langfuse.com",
    } as NodeJS.ProcessEnv;

    // Global creds, host trailing slash trimmed, base64(pk:sk).
    const globalCfg = resolveProxyConfig("langfuse", undefined, env);
    expect(globalCfg?.upstream.url).toBe("https://us.cloud.langfuse.com/api/public/mcp");
    expect(globalCfg?.upstream.headers).toEqual({
      Authorization: `Basic ${Buffer.from("pk-global:sk-global").toString("base64")}`,
    });
    expect(globalCfg?.approve).toEqual([]);

    // A full profile bundle routes its own creds at its own host, distinct target key.
    const eu = resolveProxyConfig("langfuse", "EU", env);
    expect(eu?.upstream).toEqual({
      url: "https://cloud.langfuse.com/api/public/mcp",
      headers: { Authorization: `Basic ${Buffer.from("pk-eu:sk-eu").toString("base64")}` },
    });
    expect(eu?.target.key).toBe("langfuse:EU");

    // A profile with no scoped vars at all falls back to the whole global bundle.
    expect(resolveProxyConfig("langfuse", "QA", env)?.upstream.url).toBe(
      "https://us.cloud.langfuse.com/api/public/mcp",
    );
    expect(getAvailableProxyNames("QA", env)).toEqual(["langfuse"]);
  });

  it("disables langfuse when the required LANGFUSE_BASE_URL is unset", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("langfuse", undefined, env)).toBeUndefined();
    expect(getAvailableProxyNames(undefined, env)).not.toContain("langfuse");
  });

  it("fails hard on a partial langfuse profile bundle instead of silently using globals", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
      LANGFUSE_PUBLIC_KEY_QA: "pk-qa",
      // LANGFUSE_SECRET_KEY_QA and LANGFUSE_BASE_URL_QA intentionally missing.
    } as NodeJS.ProcessEnv;

    // The error names both missing legs so the whole 3-var bundle is required.
    expect(() => resolveProxyConfig("langfuse", "QA", env)).toThrow(
      /partial langfuse profile bundle/i,
    );
    expect(() => resolveProxyConfig("langfuse", "QA", env)).toThrow(/LANGFUSE_SECRET_KEY_QA/);
    expect(() => resolveProxyConfig("langfuse", "QA", env)).toThrow(/LANGFUSE_BASE_URL_QA/);
  });

  it("keeps allow and approve sets disjoint for each upstream", () => {
    for (const name of PROXY_NAMES) {
      const proxy = resolveProxyConfig(name, undefined, FULL_ENV);
      expect(proxy).toBeDefined();

      const overlap = proxy!.allow.filter((tool) => proxy!.approve.includes(tool));
      expect(overlap).toEqual([]);
    }
  });
});
