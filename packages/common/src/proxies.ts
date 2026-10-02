import { APPROVAL_TOOL_NAMES, NON_PROXY_APPROVAL_TOOL_NAMES } from "./approval-events.js";
import type { ProxyConfig } from "./workspace-config.js";

export const PROXY_NAMES = [
  "atlassian",
  "grafana",
  "onepassword-browser",
  "posthog",
  "falcon",
  "kali",
] as const;

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
    approve: ["createJiraIssue", "addCommentToJiraIssue", "editJiraIssue", "transitionJiraIssue"],
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
  "onepassword-browser": {
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
  falcon: {
    upstream: { url: "http://falcon-mcp:8000/mcp" },
    allow: [
      "falcon_check_connectivity",
      "falcon_list_enabled_modules",
      "falcon_list_enabled_tools",
      "falcon_search_detections",
      "falcon_get_detection_details",
      "falcon_search_hosts",
      "falcon_get_host_details",
      "falcon_search_actors",
      "falcon_search_indicators",
      "falcon_search_reports",
      "falcon_get_mitre_report",
      "falcon_search_vulnerabilities",
    ],
    approve: [],
  },
  kali: {
    upstream: { url: "${KALI_API_BASE_URL}", transport: "kali-api" },
    allow: [
      "nmap_scan",
      "gobuster_scan",
      "dirb_scan",
      "nikto_scan",
      "sqlmap_scan",
      "metasploit_run",
      "hydra_attack",
      "john_crack",
      "wpscan_analyze",
      "enum4linux_scan",
      "server_health",
      "execute_command",
    ],
    approve: [],
  },
};

const configuredApprovedTools = Object.values(PROXY_REGISTRY)
  .flatMap((proxy) => proxy.approve)
  .sort();
const nonProxyApprovalTools = new Set<string>(NON_PROXY_APPROVAL_TOOL_NAMES);
const typedApprovalTools = APPROVAL_TOOL_NAMES.filter(
  (tool) => !nonProxyApprovalTools.has(tool),
).sort();

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
