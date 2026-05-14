import { APPROVAL_TOOL_NAMES } from "./approval-events.js";
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
