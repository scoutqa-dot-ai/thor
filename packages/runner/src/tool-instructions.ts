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

  const allowed = getRepoUpstreams(config, repo);
  if (!allowed || allowed.length === 0) return undefined;

  const sections: string[] = [];

  for (const upstreamName of allowed) {
    const proxyDef = getProxyConfig(upstreamName);
    if (!proxyDef) continue;

    if (proxyDef.allow.length > 0) {
      sections.push(`## ${upstreamName} (allow)`);
      for (const name of proxyDef.allow) sections.push(`- ${name}`);
    }

    if (proxyDef.approve.length > 0) {
      sections.push(`## ${upstreamName} (approve — requires human approval)`);
      for (const name of proxyDef.approve) sections.push(`- ${name}`);
    }
  }

  if (sections.length === 0) return undefined;

  return [
    "[Available MCP tools — use the `mcp` CLI to call these]",
    "",
    ...sections,
    "",
    'Usage: mcp <upstream> <tool> \'{"arg":"value"}\'',
    "Always pass a single JSON string argument.",
    "Run `mcp <upstream> <tool> --help` to see tool description and input schema.",
    "Run `approval status <id>` to check approval status.",
  ].join("\n");
}
