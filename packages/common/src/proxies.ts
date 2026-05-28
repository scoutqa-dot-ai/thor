import { APPROVAL_TOOL_NAMES } from "./approval-events.js";
import { normalizeProfileEnvSuffix } from "./profile-normalization.js";
import type { ProxyConfig } from "./workspace-config.js";

export const PROXY_NAMES = ["atlassian", "grafana", "posthog"] as const;

export type ProxyName = (typeof PROXY_NAMES)[number];

export const PROXY_REGISTRY: Record<ProxyName, ProxyConfig> = {
  atlassian: {
    upstream: {
      url: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "${ATLASSIAN_AUTH}" },
    },
    allow: [
      "atlassianUserInfo",
      "getJiraIssue",
      "createIssueLink",
      "searchJiraIssuesUsingJql",
      "getConfluenceSpaces",
      "getConfluencePage",
      "searchConfluenceUsingCql",
      "getConfluencePageDescendants",
      "getConfluencePageFooterComments",
      "getConfluencePageInlineComments",
      "getConfluenceCommentChildren",
      "search",
      "fetch",
    ],
    approve: ["createJiraIssue", "addCommentToJiraIssue"],
  },
  grafana: {
    upstream: { url: "http://grafana-mcp:8000/mcp" },
    allow: [
      "list_datasources",
      "get_datasource",
      "query_prometheus",
      "list_prometheus_metric_metadata",
      "list_prometheus_metric_names",
      "list_prometheus_label_names",
      "list_prometheus_label_values",
      "query_prometheus_histogram",
      "query_loki_logs",
      "list_loki_label_names",
      "list_loki_label_values",
      "query_loki_stats",
      "query_loki_patterns",
      "tempo_traceql-search",
      "tempo_traceql-metrics-instant",
      "tempo_traceql-metrics-range",
      "tempo_get-trace",
      "tempo_get-attribute-names",
      "tempo_get-attribute-values",
      "tempo_docs-traceql",
    ],
    approve: [],
  },
  posthog: {
    upstream: {
      url: "https://mcp.posthog.com/mcp",
      headers: { Authorization: "Bearer ${POSTHOG_API_KEY}" },
    },
    allow: [
      "docs-search",
      "error-details",
      "list-errors",
      "feature-flag-get-all",
      "feature-flag-get-definition",
      "insight-query",
      "insight-get",
      "insights-get-all",
      "query-run",
      "query-generate-hogql-from-question",
      "event-definitions-list",
      "properties-list",
      "logs-query",
      "logs-list-attributes",
      "logs-list-attribute-values",
      "error-tracking-issues-list",
      "error-tracking-issues-retrieve",
      "entity-search",
      "cohorts-list",
      "cohorts-retrieve",
      "dashboard-get",
      "dashboard-reorder-tiles",
      "dashboards-get-all",
      "experiment-get",
      "experiment-get-all",
      "experiment-results-get",
      "surveys-global-stats",
      "update-issue-status",
    ],
    approve: ["create-feature-flag"],
  },
};

export interface ResolvedProxyConfig extends ProxyConfig {
  target: {
    key: string;
    name: ProxyName;
    profile?: string;
    envScope: "profile" | "global";
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value : undefined;
}

function scopedEnv(
  env: NodeJS.ProcessEnv,
  baseName: string,
  profile: string | undefined,
): { value?: string; scope: "profile" | "global" } {
  const suffix = profile ? normalizeProfileEnvSuffix(profile) : "";
  if (suffix) {
    const scoped = envValue(env, `${baseName}_${suffix}`);
    if (scoped) return { value: scoped, scope: "profile" };
  }
  return { value: envValue(env, baseName), scope: "global" };
}

function targetKey(name: ProxyName, profile: string | undefined, scope: "profile" | "global") {
  const suffix = profile && scope === "profile" ? normalizeProfileEnvSuffix(profile) : "GLOBAL";
  return `${name}:${suffix}`;
}

export function resolveProxyConfig(
  name: string,
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyConfig | undefined {
  if (!isProxyName(name)) return undefined;
  const policy = PROXY_REGISTRY[name];

  if (name === "atlassian") {
    const auth = scopedEnv(env, "ATLASSIAN_AUTH", profile);
    if (!auth.value) return undefined;
    return {
      ...policy,
      upstream: { url: policy.upstream.url, headers: { Authorization: auth.value } },
      target: {
        key: targetKey(name, profile, auth.scope),
        name,
        ...(profile && { profile }),
        envScope: auth.scope,
      },
    };
  }

  if (name === "posthog") {
    const apiKey = scopedEnv(env, "POSTHOG_API_KEY", profile);
    if (!apiKey.value) return undefined;
    return {
      ...policy,
      upstream: { url: policy.upstream.url, headers: { Authorization: `Bearer ${apiKey.value}` } },
      target: {
        key: targetKey(name, profile, apiKey.scope),
        name,
        ...(profile && { profile }),
        envScope: apiKey.scope,
      },
    };
  }

  const suffix = profile ? normalizeProfileEnvSuffix(profile) : "";
  const scopedUrl = suffix ? envValue(env, `GRAFANA_URL_${suffix}`) : undefined;
  const scopedToken = suffix ? envValue(env, `GRAFANA_SERVICE_ACCOUNT_TOKEN_${suffix}`) : undefined;
  const scopedOrg = suffix ? envValue(env, `GRAFANA_ORG_ID_${suffix}`) : undefined;
  const anyScoped = Boolean(scopedUrl || scopedToken || scopedOrg);
  const useScoped = Boolean(scopedUrl && scopedToken);
  if (suffix && anyScoped && !useScoped) {
    const missing = [
      !scopedUrl ? `GRAFANA_URL_${suffix}` : undefined,
      !scopedToken ? `GRAFANA_SERVICE_ACCOUNT_TOKEN_${suffix}` : undefined,
    ].filter(Boolean);
    throw new Error(
      `partial grafana profile bundle for "${profile}": missing ${missing.join(", ")}. Set the whole bundle or none of it.`,
    );
  }
  const url = useScoped ? scopedUrl : envValue(env, "GRAFANA_URL");
  const token = useScoped ? scopedToken : envValue(env, "GRAFANA_SERVICE_ACCOUNT_TOKEN");
  if (!url || !token) return undefined;
  const orgId = useScoped ? scopedOrg : envValue(env, "GRAFANA_ORG_ID");
  return {
    ...policy,
    upstream: {
      url: policy.upstream.url,
      headers: {
        "X-Grafana-URL": url,
        "X-Grafana-Service-Account-Token": token,
        ...(orgId ? { "X-Grafana-Org-Id": orgId } : {}),
      },
    },
    target: {
      key: targetKey(name, profile, useScoped ? "profile" : "global"),
      name,
      ...(profile && { profile }),
      envScope: useScoped ? "profile" : "global",
    },
  };
}

export function getAvailableProxyNames(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProxyName[] {
  return PROXY_NAMES.filter((name) => resolveProxyConfig(name, profile, env) !== undefined);
}

const configuredApprovedTools = Object.values(PROXY_REGISTRY)
  .flatMap((proxy) => proxy.approve)
  .sort();
const typedApprovalTools = [...APPROVAL_TOOL_NAMES].sort();

if (
  configuredApprovedTools.length !== typedApprovalTools.length ||
  configuredApprovedTools.some((tool, index) => tool !== typedApprovalTools[index])
) {
  throw new Error(
    `Approval tool inventory mismatch between proxy policy and typed approval events. Configured approve tools: ${configuredApprovedTools.join(", ") || "(none)"}; typed approval tools: ${typedApprovalTools.join(", ") || "(none)"}`,
  );
}

export function isProxyName(name: string): name is ProxyName {
  return (PROXY_NAMES as readonly string[]).includes(name);
}

export function getProxyConfig(name: string): ProxyConfig | undefined {
  return isProxyName(name) ? PROXY_REGISTRY[name] : undefined;
}
