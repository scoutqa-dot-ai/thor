import { describe, expect, it, vi } from "vitest";
import { APPROVAL_TOOL_NAMES } from "./approval-events.js";
import { getProxyConfig, PROXY_NAMES, PROXY_REGISTRY } from "./proxies.js";
import { interpolateHeaders } from "./workspace-config.js";

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

  it("interpolates registry auth headers with the current environment", () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic secret");
    vi.stubEnv("POSTHOG_API_KEY", "phc_123");

    expect(interpolateHeaders(getProxyConfig("atlassian")?.upstream.headers)).toEqual({
      Authorization: "Basic secret",
    });
    expect(interpolateHeaders(getProxyConfig("posthog")?.upstream.headers)).toEqual({
      Authorization: "Bearer phc_123",
    });

    vi.unstubAllEnvs();
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
