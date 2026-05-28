import { afterEach, describe, expect, it, vi } from "vitest";
import { buildToolInstructions } from "./tool-instructions.js";

describe("buildToolInstructions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses absolute HTTPS Jira attachment upload URLs", () => {
    const instructions = buildToolInstructions();

    expect(instructions).toContain(
      "https://<site>.atlassian.net/rest/api/3/issue/<KEY>/attachments",
    );
    expect(instructions).toContain(
      "https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>/attachments",
    );
  });

  it("filters the MCP catalog by profile credentials", () => {
    vi.stubEnv("ATLASSIAN_AUTH", "");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "");
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.stubEnv("POSTHOG_API_KEY_QA", "phx_qa");
    vi.stubEnv("GRAFANA_URL", "");
    vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("GRAFANA_ORG_ID", "");
    vi.stubEnv("GRAFANA_URL_QA", "");
    vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN_QA", "");
    vi.stubEnv("GRAFANA_ORG_ID_QA", "");

    const instructions = buildToolInstructions({ profile: "QA" });

    expect(instructions).toContain("## posthog");
    expect(instructions).not.toContain("## atlassian");
    expect(instructions).not.toContain("## grafana");
  });

  it("can omit the MCP catalog while keeping general tool guidance", () => {
    const instructions = buildToolInstructions({ includeMcp: false });

    expect(instructions).not.toContain("[Available MCP tools");
    expect(instructions).toContain("[Jira attachment uploads]");
    expect(instructions).toContain("[Slack capability]");
  });
});
