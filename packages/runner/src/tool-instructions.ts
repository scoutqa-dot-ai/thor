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

  const hasSlackChannels = (repoConfig.channels?.length ?? 0) > 0;

  const allowed = getRepoUpstreams(config, repo);
  if (!allowed) return undefined;

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

  if (hasSlackChannels) {
    blocks.push(
      [
        "[Slack capability]",
        "This repo is mapped to Slack channels.",
        "Use the Slack skill and real Slack Web API URLs over mitmproxy (do not use `mcp slack`).",
        "Use direct `curl` for `https://slack.com/api/chat.postMessage` writes and preserve raw JSON stdout.",
        "Use direct `curl` for `https://slack.com/api/reactions.add` only when adding a requested emoji reaction; do not call Slack update/delete or reaction remove methods.",
        "Use direct `curl`/`fetch` to Slack read APIs (for example `conversations.replies` or `conversations.history`).",
      ].join("\n"),
    );
  }

  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}
