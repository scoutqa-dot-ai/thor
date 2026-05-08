import {
  AddCommentToJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssuePresentationArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  CreateFeatureFlagPresentationArgsSchema,
  CreateJiraIssueApprovalArgsSchema,
  CreateJiraIssuePresentationArgsSchema,
  UpdateFeatureFlagApprovalArgsSchema,
  UpdateFeatureFlagPresentationArgsSchema,
  type ApprovalArgs,
  type ApprovalToolName,
} from "@thor/common";
import type { SlackBlock } from "./slack-api.js";

const SLACK_SECTION_TEXT_LIMIT = 3000;
const INLINE_CODE_BLOCK_OVERHEAD = "```json\n\n```".length;
const MAX_INLINE_JSON_CHARS = SLACK_SECTION_TEXT_LIMIT - INLINE_CODE_BLOCK_OVERHEAD;
const TRIM_STEPS = [
  { maxDepth: 6, maxObjectEntries: 50, maxArrayItems: 25, maxStringLength: 500 },
  { maxDepth: 5, maxObjectEntries: 25, maxArrayItems: 12, maxStringLength: 240 },
  { maxDepth: 4, maxObjectEntries: 15, maxArrayItems: 8, maxStringLength: 120 },
  { maxDepth: 3, maxObjectEntries: 10, maxArrayItems: 5, maxStringLength: 80 },
  { maxDepth: 2, maxObjectEntries: 6, maxArrayItems: 3, maxStringLength: 40 },
] as const;
const MIN_TRIM_STEP = {
  maxDepth: 1,
  maxObjectEntries: 3,
  maxArrayItems: 2,
  maxStringLength: 16,
} as const;

type TrimStep = {
  maxDepth: number;
  maxObjectEntries: number;
  maxArrayItems: number;
  maxStringLength: number;
};

export interface ApprovalButtonRoute {
  actionId: string;
  upstreamName?: string;
  threadTs?: string;
}

export interface ApprovalPresentation {
  title: string;
  markdown: string;
}

export function buildApprovalButtonValue(input: {
  actionId: string;
  upstreamName?: string;
  threadTs?: string;
}): string {
  const { actionId, upstreamName, threadTs } = input;
  if (threadTs) {
    return `v3:${actionId}:${encodeURIComponent(upstreamName ?? "")}:${threadTs}`;
  }
  if (upstreamName) {
    return `v2:${actionId}:${upstreamName}`;
  }
  return actionId;
}

/**
 * Extract a categorical failure prefix from remote-cli stderr without echoing
 * the upstream tool's response body — Slack approval cards must not leak raw
 * tool output. Returns undefined for unrecognized stderr.
 */
export function extractApprovalFailureCategory(stderr: string): string | undefined {
  return (
    stderr.match(/^Error calling "[^"]+"/m)?.[0] ?? stderr.match(/^Unknown upstream "[^"]+"/m)?.[0]
  );
}

export function parseApprovalButtonValue(value: string): ApprovalButtonRoute | undefined {
  const parts = value.split(":");

  if (parts[0] === "v3" && parts.length >= 4) {
    const actionId = parts[1];
    const upstreamRaw = parts[2] ?? "";
    const threadTs = parts.slice(3).join(":");
    if (!actionId || !threadTs) return undefined;
    let upstreamName: string;
    try {
      upstreamName = decodeURIComponent(upstreamRaw);
    } catch {
      return undefined;
    }
    return {
      actionId,
      upstreamName: upstreamName || undefined,
      threadTs,
    };
  }

  if (parts[0] === "v2" && parts.length >= 3) {
    const actionId = parts[1];
    const upstreamName = parts.slice(2).join(":");
    if (!actionId || !upstreamName) return undefined;
    return {
      actionId,
      upstreamName,
    };
  }

  return undefined;
}

export function formatApprovalArgs(args: Record<string, unknown>): string {
  const full = JSON.stringify(args, null, 2);
  if (full.length <= MAX_INLINE_JSON_CHARS) {
    return full;
  }

  for (const step of TRIM_STEPS) {
    const candidate = JSON.stringify(trimValue(args, step, 0), null, 2);
    if (candidate.length <= MAX_INLINE_JSON_CHARS) {
      return candidate;
    }
  }

  const finalCandidate = JSON.stringify(trimValue(args, MIN_TRIM_STEP, 0), null, 2);
  if (finalCandidate.length <= MAX_INLINE_JSON_CHARS) {
    return finalCandidate;
  }

  return JSON.stringify(buildOversizeSummary(args), null, 2);
}

export function buildApprovalPresentation(
  tool: ApprovalToolName,
  args: ApprovalArgs,
): ApprovalPresentation | undefined {
  try {
    switch (tool) {
      case "createJiraIssue":
        return buildCreateJiraIssuePresentation(args);
      case "addCommentToJiraIssue":
        return buildAddJiraCommentPresentation(args);
      case "create-feature-flag":
        return buildCreateFeatureFlagPresentation(args);
      case "update-feature-flag":
        return buildUpdateFeatureFlagPresentation(args);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function buildActionBlocks(buttonValue: string): SlackBlock[] {
  return [
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approval_approve",
          value: buttonValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "approval_reject",
          value: buttonValue,
        },
      ],
    },
  ];
}

export function buildInlineApprovalBlocks(
  tool: string,
  argsJson: string,
  buttonValue: string,
): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:lock: *Approval required* — \`${tool}\``,
      },
    },
    {
      type: "section",
      expand: true,
      text: {
        type: "mrkdwn",
        text: `\`\`\`json\n${argsJson}\n\`\`\``,
      },
    },
    ...buildActionBlocks(buttonValue),
  ];
}

export function buildApprovalPresentationBlocks(
  presentation: ApprovalPresentation,
  buttonValue: string,
): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:lock: *${trimForSlack(presentation.title, 280)}*`,
      },
    },
    {
      type: "section",
      expand: true,
      text: {
        type: "mrkdwn",
        text: trimForSlack(presentation.markdown, SLACK_SECTION_TEXT_LIMIT),
      },
    },
    ...buildActionBlocks(buttonValue),
  ];
}

function buildCreateJiraIssuePresentation(args: ApprovalArgs): ApprovalPresentation {
  CreateJiraIssueApprovalArgsSchema.parse(args);
  const parsed = CreateJiraIssuePresentationArgsSchema.parse(args);
  return {
    title: `Create Jira issue: ${renderValue(parsed.summary) ?? "Untitled Jira issue"}`,
    markdown: joinMarkdown([
      bullet("Project", parsed.projectKey),
      bullet("Issue type", parsed.issueTypeName),
      bullet("Summary", parsed.summary),
      section("Description", parsed.description),
    ]),
  };
}

function buildAddJiraCommentPresentation(args: ApprovalArgs): ApprovalPresentation {
  AddCommentToJiraIssueApprovalArgsSchema.parse(args);
  const parsed = AddCommentToJiraIssuePresentationArgsSchema.parse(args);
  return {
    title: `Comment on Jira issue: ${renderValue(parsed.issueIdOrKey) ?? "unknown issue"}`,
    markdown: joinMarkdown([
      bullet("Issue", parsed.issueIdOrKey),
      section("Comment", parsed.commentBody),
    ]),
  };
}

function buildCreateFeatureFlagPresentation(args: ApprovalArgs): ApprovalPresentation {
  CreateFeatureFlagApprovalArgsSchema.parse(args);
  const parsed = CreateFeatureFlagPresentationArgsSchema.parse(args);
  const titleTarget = renderValue(parsed.name ?? parsed.key) ?? "feature flag";
  return {
    title: `Create feature flag: ${titleTarget}`,
    markdown: joinMarkdown([
      bullet("Key", parsed.key),
      bullet("Name", parsed.name),
      section("Description", parsed.description),
      bullet("Active", parsed.active),
      bullet("Rollout", parsed.rolloutPercentage),
      bullet("Filters", parsed.filters),
    ]),
  };
}

function buildUpdateFeatureFlagPresentation(args: ApprovalArgs): ApprovalPresentation {
  UpdateFeatureFlagApprovalArgsSchema.parse(args);
  const parsed = UpdateFeatureFlagPresentationArgsSchema.parse(args);
  const changes = [
    bullet("name", parsed.name),
    section("description", parsed.description),
    bullet("active", parsed.active),
    bullet("rolloutPercentage", parsed.rolloutPercentage),
    bullet("filters", parsed.filters),
  ];
  return {
    title: `Update feature flag: ${renderValue(parsed.key) ?? "feature flag"}`,
    markdown: joinMarkdown([bullet("Flag", parsed.key), ...changes]),
  };
}

function renderValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? escapeMrkdwnText(trimmed) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return value
      .map((item) => renderValue(item) ?? escapeMrkdwnText(JSON.stringify(item)))
      .join(", ");
  }
  try {
    return escapeMrkdwnText(trimString(JSON.stringify(value), 500));
  } catch {
    return escapeMrkdwnText(JSON.stringify(trimValue(value, MIN_TRIM_STEP, 0)));
  }
}

function bullet(label: string, value: unknown): string | undefined {
  const rendered = renderValue(value);
  return rendered ? `*${escapeMrkdwnText(label)}:* ${rendered}` : undefined;
}

function section(label: string, value: unknown): string | undefined {
  const rendered = renderValue(value);
  return rendered ? `*${escapeMrkdwnText(label)}:*\n${rendered}` : undefined;
}

function joinMarkdown(lines: Array<string | undefined>): string {
  const rendered = lines.filter((line): line is string => Boolean(line));
  return rendered.length > 0 ? rendered.join("\n\n") : "No arguments provided.";
}

function trimForSlack(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";

  let omittedCount = value.length - maxLength;
  while (omittedCount < value.length) {
    const suffix = `…[+${omittedCount} chars]`;
    const prefixLength = maxLength - suffix.length;
    if (prefixLength <= 0) {
      return value.slice(0, maxLength);
    }

    const nextOmittedCount = value.length - prefixLength;
    if (nextOmittedCount === omittedCount) {
      return `${value.slice(0, prefixLength)}${suffix}`;
    }
    omittedCount = nextOmittedCount;
  }

  return value.slice(0, maxLength);
}

function escapeMrkdwnText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trimValue(value: unknown, step: TrimStep, depth: number): unknown {
  if (typeof value === "string") {
    return trimString(value, step.maxStringLength);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= step.maxDepth) {
      return `[array trimmed: ${value.length} items]`;
    }

    const kept = value.slice(0, step.maxArrayItems).map((item) => trimValue(item, step, depth + 1));
    if (value.length > step.maxArrayItems) {
      kept.push(`[+${value.length - step.maxArrayItems} more items]`);
    }
    return kept;
  }

  const entries = Object.entries(value);
  if (depth >= step.maxDepth) {
    return `[object trimmed: ${entries.length} keys]`;
  }

  const trimmed: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, step.maxObjectEntries)) {
    trimmed[key] = trimValue(nested, step, depth + 1);
  }
  if (entries.length > step.maxObjectEntries) {
    trimmed._trimmed = `[+${entries.length - step.maxObjectEntries} more keys]`;
  }
  return trimmed;
}

function trimString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[+${value.length - maxLength} chars]`;
}

function buildOversizeSummary(args: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(args);
  return {
    _trimmed: "approval args too large for Slack",
    topLevelKeys: keys.slice(0, 20),
    counts: {
      rootKeys: keys.length,
    },
  };
}
