import { describe, expect, it } from "vitest";
import { APPROVAL_TOOL_NAMES } from "./approval-events.ts";
import { getAvailableProxyNames, PROXY_NAMES, resolveProxyConfig } from "./proxies.ts";

const FULL_ENV: NodeJS.ProcessEnv = {
  ATLASSIAN_AUTH: "Basic global",
  POSTHOG_API_KEY: "phc_global",
  GRAFANA_URL: "https://grafana.global",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
  LANGFUSE_PUBLIC_KEY: "pk-global",
  LANGFUSE_SECRET_KEY: "sk-global",
  LANGFUSE_HOST: "https://us.cloud.langfuse.com",
};

describe("proxy registry", () => {
  it("exposes the expected hardcoded upstreams", () => {
    expect(PROXY_NAMES).toEqual(["atlassian", "grafana", "langfuse", "posthog"]);
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

  it("resolves langfuse as a base64 basic-auth bundle on the required global host", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_HOST: "https://eu.cloud.langfuse.com/",
      LANGFUSE_PUBLIC_KEY_LABS: "pk-labs",
      LANGFUSE_SECRET_KEY_LABS: "sk-labs",
    } as NodeJS.ProcessEnv;

    // Global creds, host trailing slash trimmed, base64(pk:sk).
    const globalCfg = resolveProxyConfig("langfuse", undefined, env);
    expect(globalCfg?.upstream.url).toBe("https://eu.cloud.langfuse.com/api/public/mcp");
    expect(globalCfg?.upstream.headers).toEqual({
      Authorization: `Basic ${Buffer.from("pk-global:sk-global").toString("base64")}`,
    });
    expect(globalCfg?.allow).toEqual([
      "listObservations",
      "getObservation",
      "getObservationFieldSchema",
      "getObservationFilterSchema",
      "getObservationFilterValues",
      "queryMetrics",
      "getMetricsSchema",
      "listScores",
      "getScore",
      "listScoreConfigs",
      "getScoreConfig",
    ]);
    expect(globalCfg?.approve).toEqual([]);

    // Profile-scoped credentials, same required global host, distinct target key.
    const labs = resolveProxyConfig("langfuse", "LABS", env);
    expect(labs?.upstream).toEqual({
      url: "https://eu.cloud.langfuse.com/api/public/mcp",
      headers: { Authorization: `Basic ${Buffer.from("pk-labs:sk-labs").toString("base64")}` },
    });
    expect(labs?.target.key).toBe("langfuse:LABS");

    // Unscoped profile falls back to global creds on the same host.
    expect(resolveProxyConfig("langfuse", "QA", env)?.upstream.url).toBe(
      "https://eu.cloud.langfuse.com/api/public/mcp",
    );
    expect(getAvailableProxyNames("QA", env)).toEqual(["langfuse"]);
  });

  it("disables langfuse when the required LANGFUSE_HOST is unset", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("langfuse", undefined, env)).toBeUndefined();
    expect(getAvailableProxyNames(undefined, env)).not.toContain("langfuse");
  });

  it("fails fast when LANGFUSE_HOST is not an https URL", () => {
    const httpEnv = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_HOST: "http://insecure.langfuse.internal",
    } as NodeJS.ProcessEnv;
    expect(() => resolveProxyConfig("langfuse", undefined, httpEnv)).toThrow(/must use https/i);

    const malformedEnv = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_HOST: "not-a-url",
    } as NodeJS.ProcessEnv;
    expect(() => resolveProxyConfig("langfuse", undefined, malformedEnv)).toThrow(
      /invalid LANGFUSE_HOST/i,
    );
  });

  it("fails hard on a partial langfuse profile credential bundle instead of silently using globals", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-global",
      LANGFUSE_SECRET_KEY: "sk-global",
      LANGFUSE_HOST: "https://us.cloud.langfuse.com",
      LANGFUSE_PUBLIC_KEY_QA: "pk-qa",
      // LANGFUSE_SECRET_KEY_QA intentionally missing.
    } as NodeJS.ProcessEnv;

    expect(() => resolveProxyConfig("langfuse", "QA", env)).toThrow(
      /partial langfuse profile credential bundle/i,
    );
  });

  it("keeps allow and approve sets disjoint for each upstream", () => {
    for (const name of PROXY_NAMES) {
      const proxy = resolveProxyConfig(name, undefined, FULL_ENV);
      expect(proxy).toBeDefined();

      const overlap = proxy!.allow.filter((tool) => proxy!.approve.includes(tool));
      expect(overlap).toEqual([]);
    }
  });

  it("requires approval only for the approved write-tool inventory", () => {
    const approvedTools = PROXY_NAMES.flatMap(
      (name) => resolveProxyConfig(name, undefined, FULL_ENV)?.approve ?? [],
    ).sort();

    expect(approvedTools).toEqual([...APPROVAL_TOOL_NAMES].sort());
  });
});
