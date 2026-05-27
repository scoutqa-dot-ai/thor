import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildToolInstructions } from "./tool-instructions.js";

const composePath = fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url));

function serviceBlock(name: string): string[] {
  const lines = readFileSync(composePath, "utf-8").split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^  [^\s].*:$/.test(line)) break;
    if (/^[^\s]/.test(line)) break;
    block.push(line);
  }
  return block;
}

describe("buildToolInstructions", () => {
  it("uses absolute HTTPS Jira attachment upload URLs", () => {
    const instructions = buildToolInstructions("/workspace/repos/my-repo");

    expect(instructions).toContain(
      "https://<site>.atlassian.net/rest/api/3/issue/<KEY>/attachments",
    );
    expect(instructions).toContain(
      "https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>/attachments",
    );
  });

  it("returns undefined when not under /workspace/repos", () => {
    expect(buildToolInstructions("/tmp")).toBeUndefined();
  });

  it("keeps runner deployment env aligned with env-based MCP advertisement", () => {
    const runnerBlock = serviceBlock("runner").join("\n");

    expect(runnerBlock).toContain("env_file:");
    expect(runnerBlock).toContain("- .env");
  });

  it("allows profile-only Grafana deployments in compose", () => {
    const grafanaBlock = serviceBlock("grafana-mcp").join("\n");

    expect(grafanaBlock).toContain("GRAFANA_URL=${GRAFANA_URL:-}");
    expect(grafanaBlock).toContain(
      "GRAFANA_SERVICE_ACCOUNT_TOKEN=${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}",
    );
    expect(grafanaBlock).not.toContain("GRAFANA_URL:?set GRAFANA_URL");
  });
});
