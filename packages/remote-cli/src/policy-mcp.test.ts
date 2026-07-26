import { describe, expect, it } from "vitest";
import {
  PolicyDriftError,
  PolicyOverlapError,
  validatePolicy,
  type UpstreamTool,
} from "./policy-mcp.ts";

const allow = ["getJiraIssue", "getConfluencePage"];
// Approve-gated writes that carry a Thor disclaimer, so the policy check also
// verifies their disclaimer target field (see DISCLAIMER_TARGET_FIELDS).
const approve = ["createJiraIssue", "createConfluencePage"];

const upstream: UpstreamTool[] = [
  { name: "getJiraIssue" },
  { name: "getConfluencePage" },
  // Jira widens its prose field to a string/ADF union.
  {
    name: "createJiraIssue",
    inputSchema: {
      properties: { description: { anyOf: [{ type: "string" }, { type: "object" }] } },
    },
  },
  { name: "createConfluencePage", inputSchema: { properties: { body: { type: "string" } } } },
  { name: "deleteConfluencePage", inputSchema: { properties: { pageId: { type: "string" } } } },
];

describe("validatePolicy", () => {
  it("accepts a policy whose disclaimer targets exist upstream, including string unions", () => {
    expect(() => validatePolicy(allow, approve, upstream)).not.toThrow();
  });

  it("rejects a configured tool the upstream no longer exposes", () => {
    expect(() => validatePolicy([...allow, "getRetiredThing"], approve, upstream)).toThrow(
      PolicyDriftError,
    );
  });

  it("rejects an approve-gated write whose disclaimer target is gone", () => {
    // The failure this guards is silent upstream: a provider that ignores unknown
    // properties accepts the call and drops the footer, so the artifact ships
    // with no trace back to its trigger.
    const renamed = upstream.map((tool) =>
      tool.name === "createConfluencePage"
        ? { name: tool.name, inputSchema: { properties: { content: { type: "string" } } } }
        : tool,
    );

    expect(() => validatePolicy(allow, approve, renamed)).toThrow(
      /createConfluencePage: upstream has no string property "body"/,
    );
  });

  it("rejects overlap between allow and approve", () => {
    expect(() => validatePolicy(allow, [...approve, "getJiraIssue"], upstream)).toThrow(
      PolicyOverlapError,
    );
  });
});
