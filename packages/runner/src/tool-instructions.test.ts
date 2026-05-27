import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildToolInstructions } from "./tool-instructions.js";

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
    const compose = readFileSync("docker-compose.yml", "utf-8");
    const runnerBlock = compose.match(/\n  runner:\n[\s\S]*?\n  gateway:/)?.[0] ?? "";

    expect(runnerBlock).toContain("env_file:");
    expect(runnerBlock).toContain("- .env");
  });

  it("allows profile-only Grafana deployments in compose", () => {
    const compose = readFileSync("docker-compose.yml", "utf-8");
    const grafanaBlock = compose.match(/\n  grafana-mcp:\n[\s\S]*?\n  mitmproxy:/)?.[0] ?? "";

    expect(grafanaBlock).toContain("GRAFANA_URL=${GRAFANA_URL:-}");
    expect(grafanaBlock).toContain(
      "GRAFANA_SERVICE_ACCOUNT_TOKEN=${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}",
    );
    expect(grafanaBlock).not.toContain("GRAFANA_URL:?set GRAFANA_URL");
  });
});
