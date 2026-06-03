import { APPROVAL_TOOL_NAMES } from "./approval-events.ts";
import { envBaseUrl } from "./env.ts";

export const PROXY_NAMES = ["atlassian", "grafana", "katalon", "langfuse", "posthog"] as const;

export type ProxyName = (typeof PROXY_NAMES)[number];

export interface ResolvedProxyConfig {
  upstream: {
    url: string;
    headers?: Record<string, string>;
  };
  allow: string[];
  approve: string[];
  target: {
    key: string;
    name: ProxyName;
    profile?: string;
  };
}

const ATLASSIAN_ALLOW = [
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
];
const ATLASSIAN_APPROVE = ["createJiraIssue", "addCommentToJiraIssue"];

const GRAFANA_ALLOW = [
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
];
const GRAFANA_APPROVE: string[] = [];

const POSTHOG_ALLOW = [
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
];
const POSTHOG_APPROVE = ["create-feature-flag"];

const LANGFUSE_ALLOW = [
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
];
const LANGFUSE_APPROVE: string[] = [];

// Read-only Katalon True Platform tools (list/find/read/fetch families). Every
// create/update/delete/move/manage/schedule tool and the write-workflow
// scaffolding tools (build_*/prepare_*/get_upload_*) are intentionally omitted →
// they classify as `hidden` and are unreachable. Derived from the live tools/list
// and cross-checked at connect time by validatePolicy.
const KATALON_ALLOW = [
  "list_projects",
  "list_repositories",
  "find_iterations",
  "find_requirements",
  "read_requirement",
  "find_test_cases",
  "read_test_cases",
  "find_test_cases_by_requirement",
  "find_test_suites",
  "read_test_suite",
  "find_test_suite_collections",
  "find_test_folders",
  "read_test_result",
  "find_test_results",
  "list_alm_integrations",
  "list_test_cloud_environments",
  "list_test_cloud_agents",
  "list_test_cloud_apps",
  "list_test_cloud_tunnels",
  "list_executions",
  "read_execution",
  "list_execution_outputs",
  "find_execution_profiles",
  "read_execution_test_results",
  "list_schedule",
  "read_schedule_detail",
  "read_auts",
  "read_manual_ai_session",
  "fetch_requirement_data",
  "fetch_defect_data",
  "fetch_test_configuration_data",
  "fetch_test_case_data",
  "fetch_test_stability_data",
  "read_manual_test_run_detail_by_order",
];
const KATALON_APPROVE: string[] = [];

// The Katalon MCP server authenticates via HTTP Basic auth with the API key in
// the password position; the username is ignored by the server, so we send a
// fixed, non-empty label rather than leaking the key into the username.
const KATALON_BASIC_USER = "thor";

// Tool policy stays global per integration (profiles only re-route credentials),
// so the approve inventory is the union of the per-upstream approve lists. Assert
// at load time that it matches the typed approval events; a drift means an
// approved write tool has no disclaimer-compatible schema (or vice versa).
const APPROVED_PROXY_TOOLS = [
  ...ATLASSIAN_APPROVE,
  ...GRAFANA_APPROVE,
  ...KATALON_APPROVE,
  ...LANGFUSE_APPROVE,
  ...POSTHOG_APPROVE,
].sort();
const typedApprovalTools = [...APPROVAL_TOOL_NAMES].sort();

if (
  APPROVED_PROXY_TOOLS.length !== typedApprovalTools.length ||
  APPROVED_PROXY_TOOLS.some((tool, index) => tool !== typedApprovalTools[index])
) {
  throw new Error(
    `Approval tool inventory mismatch between proxy policy and typed approval events. Configured approve tools: ${APPROVED_PROXY_TOOLS.join(", ") || "(none)"}; typed approval tools: ${typedApprovalTools.join(", ") || "(none)"}`,
  );
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function scopedEnv(
  env: NodeJS.ProcessEnv,
  baseName: string,
  profile: string | undefined,
): { value?: string; scope: "profile" | "global" } {
  if (profile) {
    const scoped = envValue(env, `${baseName}_${profile}`);
    if (scoped) return { value: scoped, scope: "profile" };
  }
  return { value: envValue(env, baseName), scope: "global" };
}

function targetKey(name: ProxyName, profile: string | undefined, scope: "profile" | "global") {
  return `${name}:${profile && scope === "profile" ? profile : "GLOBAL"}`;
}

export function resolveProxyConfig(
  name: string,
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyConfig | undefined {
  if (!isProxyName(name)) return undefined;

  if (name === "atlassian") {
    const auth = scopedEnv(env, "ATLASSIAN_AUTH", profile);
    if (!auth.value) return undefined;
    return {
      upstream: {
        url: "https://mcp.atlassian.com/v1/mcp",
        headers: { Authorization: auth.value },
      },
      allow: ATLASSIAN_ALLOW,
      approve: ATLASSIAN_APPROVE,
      target: {
        key: targetKey(name, profile, auth.scope),
        name,
        ...(profile && { profile }),
      },
    };
  }

  if (name === "posthog") {
    const apiKey = scopedEnv(env, "POSTHOG_API_KEY", profile);
    if (!apiKey.value) return undefined;
    return {
      upstream: {
        url: "https://mcp.posthog.com/mcp",
        headers: { Authorization: `Bearer ${apiKey.value}` },
      },
      allow: POSTHOG_ALLOW,
      approve: POSTHOG_APPROVE,
      target: {
        key: targetKey(name, profile, apiKey.scope),
        name,
        ...(profile && { profile }),
      },
    };
  }

  if (name === "langfuse") {
    const scopedPublic = profile ? envValue(env, `LANGFUSE_PUBLIC_KEY_${profile}`) : undefined;
    const scopedSecret = profile ? envValue(env, `LANGFUSE_SECRET_KEY_${profile}`) : undefined;
    const scopedBaseUrl = profile ? envValue(env, `LANGFUSE_BASE_URL_${profile}`) : undefined;
    const anyScoped = Boolean(scopedPublic || scopedSecret || scopedBaseUrl);
    const useScoped = Boolean(scopedPublic && scopedSecret && scopedBaseUrl);
    if (profile && anyScoped && !useScoped) {
      const missing = [
        !scopedPublic ? `LANGFUSE_PUBLIC_KEY_${profile}` : undefined,
        !scopedSecret ? `LANGFUSE_SECRET_KEY_${profile}` : undefined,
        !scopedBaseUrl ? `LANGFUSE_BASE_URL_${profile}` : undefined,
      ].filter(Boolean);
      throw new Error(
        `partial langfuse profile bundle for "${profile}": missing ${missing.join(", ")}. Set LANGFUSE_PUBLIC_KEY_${profile}, LANGFUSE_SECRET_KEY_${profile}, and LANGFUSE_BASE_URL_${profile} together, or none of them.`,
      );
    }
    const baseUrlVar = useScoped ? `LANGFUSE_BASE_URL_${profile}` : "LANGFUSE_BASE_URL";
    const publicKey = useScoped ? scopedPublic : envValue(env, "LANGFUSE_PUBLIC_KEY");
    const secretKey = useScoped ? scopedSecret : envValue(env, "LANGFUSE_SECRET_KEY");
    if (!publicKey || !secretKey || !envValue(env, baseUrlVar)) return undefined;
    const token = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    return {
      upstream: {
        url: `${envBaseUrl(env, baseUrlVar)}/api/public/mcp`,
        headers: { Authorization: `Basic ${token}` },
      },
      allow: LANGFUSE_ALLOW,
      approve: LANGFUSE_APPROVE,
      target: {
        key: targetKey(name, profile, useScoped ? "profile" : "global"),
        name,
        ...(profile && { profile }),
      },
    };
  }

  if (name === "katalon") {
    const scopedKey = profile ? envValue(env, `KATALON_API_KEY_${profile}`) : undefined;
    const scopedBaseUrl = profile ? envValue(env, `KATALON_BASE_URL_${profile}`) : undefined;
    const anyScoped = Boolean(scopedKey || scopedBaseUrl);
    const useScoped = Boolean(scopedKey && scopedBaseUrl);
    if (profile && anyScoped && !useScoped) {
      const missing = [
        !scopedKey ? `KATALON_API_KEY_${profile}` : undefined,
        !scopedBaseUrl ? `KATALON_BASE_URL_${profile}` : undefined,
      ].filter(Boolean);
      throw new Error(
        `partial katalon profile bundle for "${profile}": missing ${missing.join(", ")}. Set KATALON_API_KEY_${profile} and KATALON_BASE_URL_${profile} together, or neither.`,
      );
    }
    const baseUrlVar = useScoped ? `KATALON_BASE_URL_${profile}` : "KATALON_BASE_URL";
    const apiKey = useScoped ? scopedKey : envValue(env, "KATALON_API_KEY");
    if (!apiKey || !envValue(env, baseUrlVar)) return undefined;
    const token = Buffer.from(`${KATALON_BASIC_USER}:${apiKey}`).toString("base64");
    return {
      upstream: {
        url: `${envBaseUrl(env, baseUrlVar)}/mcp`,
        headers: { Authorization: `Basic ${token}` },
      },
      allow: KATALON_ALLOW,
      approve: KATALON_APPROVE,
      target: {
        key: targetKey(name, profile, useScoped ? "profile" : "global"),
        name,
        ...(profile && { profile }),
      },
    };
  }

  const scopedUrl = profile ? envValue(env, `GRAFANA_URL_${profile}`) : undefined;
  const scopedToken = profile
    ? envValue(env, `GRAFANA_SERVICE_ACCOUNT_TOKEN_${profile}`)
    : undefined;
  const scopedOrg = profile ? envValue(env, `GRAFANA_ORG_ID_${profile}`) : undefined;
  const anyScoped = Boolean(scopedUrl || scopedToken || scopedOrg);
  const useScoped = Boolean(scopedUrl && scopedToken);
  if (profile && anyScoped && !useScoped) {
    const missing = [
      !scopedUrl ? `GRAFANA_URL_${profile}` : undefined,
      !scopedToken ? `GRAFANA_SERVICE_ACCOUNT_TOKEN_${profile}` : undefined,
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
    upstream: {
      url: "http://grafana-mcp:8000/mcp",
      headers: {
        "X-Grafana-URL": url,
        "X-Grafana-Service-Account-Token": token,
        ...(orgId ? { "X-Grafana-Org-Id": orgId } : {}),
      },
    },
    allow: GRAFANA_ALLOW,
    approve: GRAFANA_APPROVE,
    target: {
      key: targetKey(name, profile, useScoped ? "profile" : "global"),
      name,
      ...(profile && { profile }),
    },
  };
}

export function getAvailableProxyNames(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProxyName[] {
  return PROXY_NAMES.filter((name) => resolveProxyConfig(name, profile, env) !== undefined);
}

export function isProxyName(name: string): name is ProxyName {
  return (PROXY_NAMES as readonly string[]).includes(name);
}
