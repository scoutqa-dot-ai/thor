import { APPROVAL_TOOL_NAMES } from "./approval-events.ts";
import { envBaseUrl } from "./env.ts";

export const PROXY_NAMES = ["atlassian", "grafana", "langfuse", "posthog"] as const;

export type ProxyName = (typeof PROXY_NAMES)[number];

/**
 * How remote-cli reaches an upstream MCP server: a remote HTTP endpoint, or a
 * local child process spoken to over stdio (which gives each profile its own
 * single-tenant instance).
 */
export type ProxyUpstream =
  | { kind: "http"; url: string; headers?: Record<string, string> }
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> };

export interface ResolvedProxyConfig {
  upstream: ProxyUpstream;
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

// Grafana runs as a per-profile child: the mcp-grafana binary speaking MCP over
// stdio, confined by bwrap. The arg set is static — only the credential env
// (see the stdio spec below) varies per profile. Credentials are passed via env,
// never as bwrap `--setenv` args, so the service-account token never appears in
// the child's argv. Requires the bundled mcp-grafana binary + bubblewrap in the
// remote-cli image and the additive seccomp profile (see docs/plan).
const MCP_GRAFANA_BIN = "/usr/local/bin/mcp-grafana";
const GRAFANA_MCP_ARGS = [
  "-transport",
  "stdio",
  "-enabled-tools",
  "datasource,prometheus,loki,proxied",
];
const GRAFANA_SANDBOX_ARGS = [
  // Rootless namespaces; tear the child down with remote-cli. --unshare-user
  // remaps the uid so the child cannot ptrace/read remote-cli's processes.
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--new-session",
  "--die-with-parent",
  // Pin a deterministic env inside the sandbox (non-secret values, so argv-safe).
  // Credentials are NOT set here — they arrive via the child's env (see the spec
  // below) so the service-account token never lands in argv / /proc/<pid>/cmdline.
  "--setenv",
  "PATH",
  "/usr/local/bin:/usr/bin:/bin",
  "--setenv",
  "HOME",
  "/tmp",
  // Read-only system dirs only. Nothing binds /var/lib/remote-cli (GitHub App
  // key) or /workspace, so the child cannot read remote-cli's secrets or repos.
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind",
  "/bin",
  "/bin",
  "--ro-bind",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--ro-bind",
  "/etc/ssl",
  "/etc/ssl",
  "--ro-bind-try",
  "/etc/resolv.conf",
  "/etc/resolv.conf",
  "--ro-bind-try",
  "/etc/nsswitch.conf",
  "/etc/nsswitch.conf",
  "--ro-bind-try",
  "/etc/hosts",
  "/etc/hosts",
  // Bind the host /proc rather than mounting a fresh one (a fresh `--proc` is
  // rejected on container kernels with a masked /proc). This is safe because
  // --unshare-pid puts the child in a new PID namespace: procfs only renders
  // PIDs that exist in the reader's namespace, so the child sees only its own
  // sandbox processes — host PIDs (and their environ/cmdline/root) are not
  // resolvable. /proc/1 inside is the sandbox init, not remote-cli's PID 1.
  "--bind",
  "/proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  MCP_GRAFANA_BIN,
  ...GRAFANA_MCP_ARGS,
];

// Read-only PostHog tools only. Writes/destructive operations stay hidden;
// any future write capability should go through POSTHOG_APPROVE (human gate),
// not here. PII-heavy surfaces (persons-*, session-recording-*) are
// intentionally omitted.
const POSTHOG_ALLOW = [
  "docs-search",
  // Insights + analytics query family
  "insight-query",
  "insight-get",
  "insights-list",
  "query-trends",
  "query-funnel",
  "query-retention",
  "query-stickiness",
  "query-paths",
  "query-lifecycle",
  // Ad-hoc SQL + schema introspection (replaces the removed generic query-run)
  "execute-sql",
  "read-data-schema",
  "read-data-warehouse-schema",
  // Error tracking
  "query-error-tracking-issue",
  "query-error-tracking-issue-events",
  "query-error-tracking-issues-list",
  // Feature flags
  "feature-flag-get-all",
  "feature-flag-get-definition",
  "feature-flags-status-retrieve",
  // Experiments
  "experiment-get",
  "experiment-get-all",
  "experiment-results-get",
  "experiment-list",
  "experiment-stats",
  // Cohorts, dashboards, surveys
  "cohorts-list",
  "cohorts-retrieve",
  "dashboard-get",
  "dashboards-get-all",
  "surveys-global-stats",
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

// Tool policy stays global per integration (profiles only re-route credentials),
// so the approve inventory is the union of the per-upstream approve lists. Assert
// at load time that it matches the typed approval events; a drift means an
// approved write tool has no disclaimer-compatible schema (or vice versa).
const APPROVED_PROXY_TOOLS = [
  ...ATLASSIAN_APPROVE,
  ...GRAFANA_APPROVE,
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

export function resolveAtlassianCloudId(
  profile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { value?: string; scope: "profile" | "global" } {
  return scopedEnv(env, "ATLASSIAN_CLOUD_ID", profile);
}

export function resolveProxyConfig(
  name: string,
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyConfig | undefined {
  if (!isProxyName(name)) return undefined;

  if (name === "atlassian") {
    const scopedAuth = profile ? envValue(env, `ATLASSIAN_AUTH_${profile}`) : undefined;
    const scopedCloudId = profile ? envValue(env, `ATLASSIAN_CLOUD_ID_${profile}`) : undefined;
    const anyScoped = Boolean(scopedAuth || scopedCloudId);
    const useScoped = Boolean(scopedAuth && scopedCloudId);
    if (profile && anyScoped && !useScoped) {
      const missing = [
        !scopedAuth ? `ATLASSIAN_AUTH_${profile}` : undefined,
        !scopedCloudId ? `ATLASSIAN_CLOUD_ID_${profile}` : undefined,
      ].filter(Boolean);
      throw new Error(
        `partial atlassian profile bundle for "${profile}": missing ${missing.join(", ")}. Set ATLASSIAN_AUTH_${profile} and ATLASSIAN_CLOUD_ID_${profile} together, or none of them.`,
      );
    }
    const auth = useScoped ? scopedAuth : envValue(env, "ATLASSIAN_AUTH");
    const cloudId = useScoped ? scopedCloudId : envValue(env, "ATLASSIAN_CLOUD_ID");
    if (!auth || !cloudId) return undefined;
    return {
      upstream: {
        kind: "http",
        url: "https://mcp.atlassian.com/v1/mcp",
        headers: { Authorization: auth },
      },
      allow: ATLASSIAN_ALLOW,
      approve: ATLASSIAN_APPROVE,
      target: {
        key: targetKey(name, profile, useScoped ? "profile" : "global"),
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
        kind: "http",
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
        kind: "http",
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

  const scopedUrl = profile ? envValue(env, `GRAFANA_URL_${profile}`) : undefined;
  const scopedToken = profile
    ? envValue(env, `GRAFANA_SERVICE_ACCOUNT_TOKEN_${profile}`)
    : undefined;
  const scopedOrg = profile ? envValue(env, `GRAFANA_ORG_ID_${profile}`) : undefined;
  const anyScoped = Boolean(scopedUrl || scopedToken || scopedOrg);
  const useScoped = Boolean(scopedUrl && scopedToken && scopedOrg);
  if (profile && anyScoped && !useScoped) {
    const missing = [
      !scopedUrl ? `GRAFANA_URL_${profile}` : undefined,
      !scopedToken ? `GRAFANA_SERVICE_ACCOUNT_TOKEN_${profile}` : undefined,
      !scopedOrg ? `GRAFANA_ORG_ID_${profile}` : undefined,
    ].filter(Boolean);
    throw new Error(
      `partial grafana profile bundle for "${profile}": missing ${missing.join(", ")}. Set GRAFANA_URL_${profile}, GRAFANA_SERVICE_ACCOUNT_TOKEN_${profile}, and GRAFANA_ORG_ID_${profile} together, or none of them.`,
    );
  }
  const url = useScoped ? scopedUrl : envValue(env, "GRAFANA_URL");
  const token = useScoped ? scopedToken : envValue(env, "GRAFANA_SERVICE_ACCOUNT_TOKEN");
  const orgId = useScoped ? scopedOrg : envValue(env, "GRAFANA_ORG_ID");
  if (!url || !token || !orgId) return undefined;
  const grafanaEnv = {
    GRAFANA_URL: url,
    GRAFANA_SERVICE_ACCOUNT_TOKEN: token,
    GRAFANA_ORG_ID: orgId,
  };
  // Escape hatch for environments that cannot host a rootless bwrap sandbox
  // (e.g. a container-in-container CI runner): run mcp-grafana directly. This
  // removes the isolation around the foreign binary, so it is ONLY safe where
  // remote-cli holds no real secrets (fake CI credentials). Never set in prod.
  const unsandboxed = envValue(env, "THOR_MCP_DISABLE_SANDBOX") === "1";
  return {
    upstream: unsandboxed
      ? { kind: "stdio", command: MCP_GRAFANA_BIN, args: GRAFANA_MCP_ARGS, env: grafanaEnv }
      : { kind: "stdio", command: "bwrap", args: GRAFANA_SANDBOX_ARGS, env: grafanaEnv },
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
