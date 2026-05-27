import { describe, expect, it } from "vitest";
import { APPROVAL_TOOL_NAMES } from "./approval-events.js";
import {
  getAvailableProxyNames,
  getProxyConfig,
  normalizeProfileEnvSuffix,
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

    expect(resolveProxyConfig("atlassian", "labs", env)?.upstream.headers).toEqual({
      Authorization: "Basic labs",
    });
    expect(resolveProxyConfig("atlassian", "qa", env)?.upstream.headers).toEqual({
      Authorization: "Basic global",
    });
    expect(resolveProxyConfig("posthog", "labs", env)?.target.envScope).toBe("global");
    expect(resolveProxyConfig("posthog", "labs", env)?.upstream.headers?.Authorization).toBe(
      "Bearer phc_global",
    );
  });

  it("normalizes suffixes and resolves grafana as a bundle", () => {
    expect(normalizeProfileEnvSuffix("qa-labs east")).toBe("QA_LABS_EAST");
    expect(normalizeProfileEnvSuffix("___qa-labs east___")).toBe("QA_LABS_EAST");
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_URL_LABS: "https://grafana.labs",
      GRAFANA_SERVICE_ACCOUNT_TOKEN_LABS: "labs-token",
      GRAFANA_ORG_ID_LABS: "7",
      ATLASSIAN_AUTH_LABS: "Basic labs",
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("grafana", "labs", env)?.upstream.headers).toEqual({
      "X-Grafana-Url": "https://grafana.labs",
      Authorization: "Bearer labs-token",
      "X-Grafana-Org-Id": "7",
    });
    expect(resolveProxyConfig("grafana", "qa", env)?.upstream.headers).toEqual({
      "X-Grafana-Url": "https://grafana.global",
      Authorization: "Bearer global-token",
    });
    expect(getAvailableProxyNames("labs", env)).toEqual(["atlassian", "grafana"]);
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
    const approvedTools = Object.values(PROXY_REGISTRY).flatMap((proxy) => proxy.approve).sort();

    expect(approvedTools).toEqual([...APPROVAL_TOOL_NAMES].sort());
  });
});
