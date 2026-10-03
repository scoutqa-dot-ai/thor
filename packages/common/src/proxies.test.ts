import { describe, expect, it } from "vitest";
import { getProxyConfig, PROXY_NAMES } from "./proxies.js";

describe("proxy registry", () => {
  it("exposes the expected hardcoded upstreams", () => {
    expect(PROXY_NAMES).toEqual([
      "atlassian",
      "grafana",
      "onepassword-browser",
      "posthog",
      "falcon",
      "kali",
    ]);
    expect(getProxyConfig("atlassian")?.upstream.url).toBe("https://mcp.atlassian.com/v1/mcp");
    expect(getProxyConfig("grafana")?.allow).toEqual(
      expect.arrayContaining(["query_prometheus", "list_prometheus_metric_names"]),
    );
    expect(getProxyConfig("onepassword-browser")).toEqual({
      upstream: {
        url: "stdio://onepassword-browser",
        transport: "onepassword-browser",
      },
      allow: [
        "find_login_items",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_navigate",
        "browser_close",
      ],
      approve: ["browser_open_authenticated"],
    });
    expect(getProxyConfig("posthog")?.allow).toContain("query-run");
    expect(getProxyConfig("falcon")?.upstream.url).toBe("http://falcon-mcp:8000/mcp");
    expect(getProxyConfig("falcon")?.allow).toEqual(
      expect.arrayContaining(["falcon_search_detections", "falcon_get_host_details"]),
    );
    expect(getProxyConfig("kali")?.upstream).toEqual({
      url: "${KALI_API_BASE_URL}",
      transport: "kali-api",
    });
    expect(getProxyConfig("kali")?.allow).toEqual(
      expect.arrayContaining(["server_health", "nmap_scan", "execute_command"]),
    );
    expect(getProxyConfig("unknown")).toBeUndefined();
  });

  it("keeps allow and approve sets disjoint for each upstream", () => {
    for (const name of PROXY_NAMES) {
      const proxy = getProxyConfig(name);
      expect(proxy).toBeDefined();

      const overlap = proxy!.allow.filter((tool) => proxy!.approve.includes(tool));
      expect(overlap).toEqual([]);
    }
  });
});
