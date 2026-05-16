import {
  extractRepoFromCwd,
  getProxyConfig,
  getRepoUpstreams,
  type WorkspaceConfig,
} from "@thor/common";

export function buildToolInstructions(
  config: WorkspaceConfig,
  directory: string,
): string | undefined {
  const repo = extractRepoFromCwd(directory);
  if (!repo) return undefined;

  const repoConfig = config.repos[repo];
  if (!repoConfig) return undefined;

  const allowed = getRepoUpstreams(config, repo);
  if (!allowed) return undefined;

  const hasAtlassian = allowed.includes("atlassian");

  const mcpSections: string[] = [];

  for (const upstreamName of allowed) {
    const proxyDef = getProxyConfig(upstreamName);
    if (!proxyDef) continue;

    if (proxyDef.allow.length > 0) {
      mcpSections.push(`## ${upstreamName} (allow)`);
      for (const name of proxyDef.allow) mcpSections.push(`- ${name}`);
    }

    if (proxyDef.approve.length > 0) {
      mcpSections.push(`## ${upstreamName} (approve — requires human approval)`);
      for (const name of proxyDef.approve) mcpSections.push(`- ${name}`);
    }
  }

  const blocks: string[] = [];

  if (mcpSections.length > 0) {
    blocks.push(
      [
        "[Available MCP tools — use the `mcp` CLI to call these]",
        "",
        ...mcpSections,
        "",
        'Usage: mcp <upstream> <tool> \'{"arg":"value"}\'',
        "Always pass a single JSON string argument.",
        "Run `mcp <upstream> <tool> --help` to see tool description and input schema.",
        "Run `approval status <id>` to check approval status.",
      ].join("\n"),
    );
  }

  if (hasAtlassian) {
    blocks.push(
      [
        "[Jira attachment uploads]",
        "No MCP tool exists for Jira attachments. POST a multipart `file` field via `curl`/`fetch` to:",
        "- `https://<site>.atlassian.net/rest/api/3/issue/<KEY>/attachments`",
        "- `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>/attachments`",
        "The proxy injects auth and the required XSRF header only for those POST endpoint shapes.",
        "Other Jira writes still go through MCP.",
      ].join("\n"),
    );
  }

  blocks.push(
    [
      "[Slack capability]",
      "Use `slack-post-message` for Slack message writes.",
      "Load Slack skill for details about using `curl`/`fetch` with `reactions.add`, `conversations.replies` etc.",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
