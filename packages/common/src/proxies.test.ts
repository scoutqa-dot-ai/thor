import { describe, expect, it } from "vitest";
import { APPROVAL_TOOL_NAMES } from "./approval-events.js";
import {
  getAvailableProxyNames,
  getProxyConfig,
  PROXY_NAMES,
  PROXY_REGISTRY,
  resolveProxyConfig,
} from "./proxies.js";

describe("proxy registry", () => {
  it("exposes the expected hardcoded upstreams", () => {
    expect(PROXY_NAMES).toEqual(["atlassian", "grafana", "posthog"]);
    expect(getProxyConfig("atlassian")?.upstream.url).toBe("https://mcp.atlassian.com/v1/mcp");
    expect(getProxyConfig("grafana")?.allow).toEqual(
      expect.arrayContaining(["query_prometheus", "list_prometheus_metric_names"]),
    );
    expect(getProxyConfig("posthog")?.allow).toContain("query-run");
    expect(getProxyConfig("unknown")).toBeUndefined();
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
    expect(resolveProxyConfig("posthog", "LABS", env)?.target.envScope).toBe("global");
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

  it("keeps allow and approve sets disjoint for each upstream", () => {
    for (const name of PROXY_NAMES) {
      const proxy = getProxyConfig(name);
      expect(proxy).toBeDefined();

      const overlap = proxy!.allow.filter((tool) => proxy!.approve.includes(tool));
      expect(overlap).toEqual([]);
    }
  });

  it("requires approval only for the approved write-tool inventory", () => {
    const approvedTools = Object.values(PROXY_REGISTRY)
      .flatMap((proxy) => proxy.approve)
      .sort();

    expect(approvedTools).toEqual([...APPROVAL_TOOL_NAMES].sort());
  });
});
