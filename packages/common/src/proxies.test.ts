import { describe, expect, it } from "vitest";
import { getAvailableProxyNames, PROXY_NAMES, resolveProxyConfig } from "./proxies.ts";

const FULL_ENV: NodeJS.ProcessEnv = {
  ATLASSIAN_AUTH: "Basic global",
  POSTHOG_API_KEY: "phc_global",
  GRAFANA_URL: "https://grafana.global",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
  GRAFANA_ORG_ID: "1",
  LANGFUSE_PUBLIC_KEY: "pk-global",
  LANGFUSE_SECRET_KEY: "sk-global",
  LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
};

describe("proxy registry", () => {
  // resolveProxyConfig returns the ProxyUpstream union; these assertions only
  // concern HTTP upstreams, so narrow once here instead of at every call site.
  const httpUpstream = (name: string, profile: string | undefined, env: NodeJS.ProcessEnv) => {
    const upstream = resolveProxyConfig(name, profile, env)?.upstream;
    if (upstream?.kind !== "http") throw new Error(`expected http upstream for "${name}"`);
    return upstream;
  };

  it("exposes the expected hardcoded upstreams", () => {
    expect(httpUpstream("atlassian", undefined, FULL_ENV).url).toBe(
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

    expect(httpUpstream("atlassian", "LABS", env).headers).toEqual({
      Authorization: "Basic labs",
    });
    expect(httpUpstream("atlassian", "QA", env).headers).toEqual({
      Authorization: "Basic global",
    });
    expect(httpUpstream("posthog", "LABS", env).headers?.Authorization).toBe("Bearer phc_global");
  });

  it("resolves grafana as a sandboxed stdio child with per-profile credential env", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
      GRAFANA_URL_LABS: "https://grafana.labs",
      GRAFANA_SERVICE_ACCOUNT_TOKEN_LABS: "labs-token",
      GRAFANA_ORG_ID_LABS: "7",
      ATLASSIAN_AUTH_LABS: "Basic labs",
    } as NodeJS.ProcessEnv;

    const labs = resolveProxyConfig("grafana", "LABS", env)?.upstream;
    // Credentials ride in env, never in argv — the token must not be a bwrap arg.
    expect(labs).toMatchObject({ kind: "stdio", command: "bwrap" });
    if (labs?.kind !== "stdio") throw new Error("expected stdio upstream");
    expect(labs.env).toEqual({
      GRAFANA_URL: "https://grafana.labs",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "labs-token",
      GRAFANA_ORG_ID: "7",
    });
    expect(labs.args).toContain("/usr/local/bin/mcp-grafana");
    expect(labs.args).not.toContain("labs-token");

    // QA has no scoped bundle, so it falls back to the global credentials.
    const qa = resolveProxyConfig("grafana", "QA", env)?.upstream;
    if (qa?.kind !== "stdio") throw new Error("expected stdio upstream");
    expect(qa.env).toEqual({
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
    });
    expect(getAvailableProxyNames("LABS", env)).toEqual(["atlassian", "grafana"]);
  });

  it("runs mcp-grafana directly (no bwrap) only when THOR_MCP_DISABLE_SANDBOX=1", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
      THOR_MCP_DISABLE_SANDBOX: "1",
    } as NodeJS.ProcessEnv;

    const unsandboxed = resolveProxyConfig("grafana", undefined, env)?.upstream;
    if (unsandboxed?.kind !== "stdio") throw new Error("expected stdio upstream");
    expect(unsandboxed.command).toBe("/usr/local/bin/mcp-grafana");
    expect(unsandboxed.args).not.toContain("--unshare-user"); // no bwrap wrapper
    expect(unsandboxed.env.GRAFANA_SERVICE_ACCOUNT_TOKEN).toBe("global-token");

    // Default (flag unset) stays sandboxed under bwrap.
    const sandboxed = resolveProxyConfig("grafana", undefined, {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
    } as NodeJS.ProcessEnv)?.upstream;
    expect(sandboxed).toMatchObject({ kind: "stdio", command: "bwrap" });

    const falseyString = resolveProxyConfig("grafana", undefined, {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
      THOR_MCP_DISABLE_SANDBOX: "false",
    } as NodeJS.ProcessEnv)?.upstream;
    expect(falseyString).toMatchObject({ kind: "stdio", command: "bwrap" });
  });

  it("fails hard on a partial grafana profile bundle instead of silently using globals", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      GRAFANA_ORG_ID: "1",
      GRAFANA_URL_QA: "https://grafana.qa",
      // GRAFANA_SERVICE_ACCOUNT_TOKEN_QA intentionally missing.
    } as NodeJS.ProcessEnv;

    expect(() => resolveProxyConfig("grafana", "QA", env)).toThrow(
      /partial grafana profile bundle/i,
    );

    // Org id is now part of the required bundle: URL + token without it still fails.
    expect(() =>
      resolveProxyConfig("grafana", "QA", {
        GRAFANA_URL_QA: "https://grafana.qa",
        GRAFANA_SERVICE_ACCOUNT_TOKEN_QA: "qa-token",
        // GRAFANA_ORG_ID_QA intentionally missing.
      } as NodeJS.ProcessEnv),
    ).toThrow(/GRAFANA_ORG_ID_QA/);
  });

  it("disables grafana when GRAFANA_ORG_ID is missing from the global bundle", () => {
    const env = {
      GRAFANA_URL: "https://grafana.global",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "global-token",
      // GRAFANA_ORG_ID intentionally missing.
    } as NodeJS.ProcessEnv;

    expect(resolveProxyConfig("grafana", undefined, env)).toBeUndefined();
    expect(getAvailableProxyNames(undefined, env)).not.toContain("grafana");
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
    const globalUpstream = httpUpstream("langfuse", undefined, env);
    expect(globalUpstream.url).toBe("https://us.cloud.langfuse.com/api/public/mcp");
    expect(globalUpstream.headers).toEqual({
      Authorization: `Basic ${Buffer.from("pk-global:sk-global").toString("base64")}`,
    });
    expect(globalCfg?.approve).toEqual([]);

    // A full profile bundle routes its own creds at its own host, distinct target key.
    const eu = resolveProxyConfig("langfuse", "EU", env);
    expect(eu?.upstream).toEqual({
      kind: "http",
      url: "https://cloud.langfuse.com/api/public/mcp",
      headers: { Authorization: `Basic ${Buffer.from("pk-eu:sk-eu").toString("base64")}` },
    });
    expect(eu?.target.key).toBe("langfuse:EU");

    // A profile with no scoped vars at all falls back to the whole global bundle.
    expect(httpUpstream("langfuse", "QA", env).url).toBe(
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
