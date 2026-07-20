import {
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  GhIssueCreateApprovalArgsSchema,
  AwsExecApprovalArgsSchema,
  CreateJiraIssueApprovalArgsSchema,
  type ApprovalToolName,
} from "./approval-events.ts";
import { findSlackTriggerCorrelationKey } from "./event-log.ts";

const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_THREAD_CORRELATION_PREFIX = "slack:thread:";
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

type SlackTextObject = { type: "mrkdwn"; text: string } | { type: "plain_text"; text: string };

export type SlackBlock =
  | { type: "divider" }
  | { type: "section"; text: SlackTextObject; expand?: true }
  | {
      type: "actions";
      elements: Array<{
        type: "button";
        text: { type: "plain_text"; text: string };
        style?: "primary" | "danger";
        action_id: "approval_approve" | "approval_reject";
        value: string;
      }>;
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

export interface ApprovalSlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export interface SlackThreadTarget {
  channel: string;
  threadTs: string;
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
  return actionId;
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

  return undefined;
}

function parseSlackThreadAlias(aliasValue: string): SlackThreadTarget | undefined {
  const separator = aliasValue.indexOf("/");
  if (separator <= 0 || separator === aliasValue.length - 1) return undefined;
  const channel = aliasValue.slice(0, separator);
  const threadTs = aliasValue.slice(separator + 1);
  if (!channel || !threadTs) return undefined;
  return { channel, threadTs };
}

export function resolveSlackThreadTargetFromTrigger(
  sessionId: string,
): SlackThreadTarget | { error: string } {
  const correlationKey = findSlackTriggerCorrelationKey(sessionId);
  if (!correlationKey) {
    return { error: `session ${sessionId} has no Slack trigger correlation key` };
  }

  const aliasValue = correlationKey.slice(SLACK_THREAD_CORRELATION_PREFIX.length);
  const parsed = parseSlackThreadAlias(aliasValue);
  if (!parsed) {
    return {
      error: `session ${sessionId} has unsupported Slack thread correlation key: ${correlationKey}`,
    };
  }
  return parsed;
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
  args: Record<string, unknown>,
): ApprovalPresentation | undefined {
  try {
    switch (tool) {
      case "createJiraIssue":
        return buildCreateJiraIssuePresentation(args);
      case "addCommentToJiraIssue":
        return buildAddJiraCommentPresentation(args);
      case "create-feature-flag":
        return buildCreateFeatureFlagPresentation(args);
      case "ghIssueCreate":
        return buildGhIssueCreatePresentation(args);
      case "awsExec":
        return buildAwsExecPresentation(args);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function buildApprovalSlackMessage(input: {
  actionId: string;
  tool: ApprovalToolName;
  args: Record<string, unknown>;
  upstreamName?: string;
  threadTs: string;
}): ApprovalSlackMessage {
  const buttonValue = buildApprovalButtonValue({
    actionId: input.actionId,
    upstreamName: input.upstreamName,
    threadTs: input.threadTs,
  });
  const presentation = buildApprovalPresentation(input.tool, input.args);

  if (presentation) {
    return {
      text: presentation.title,
      blocks: buildApprovalPresentationBlocks(presentation, buttonValue),
    };
  }

  const argsJson = formatApprovalArgs(input.args);
  return {
    text: `Approval required for \`${input.tool}\``,
    blocks: buildInlineApprovalBlocks(input.tool, argsJson, buttonValue),
  };
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

function buildCreateJiraIssuePresentation(args: Record<string, unknown>): ApprovalPresentation {
  const parsed = CreateJiraIssueApprovalArgsSchema.parse(args);
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

function buildAddJiraCommentPresentation(args: Record<string, unknown>): ApprovalPresentation {
  const parsed = AddCommentToJiraIssueApprovalArgsSchema.parse(args);
  return {
    title: `Comment on Jira issue: ${renderValue(parsed.issueIdOrKey) ?? "unknown issue"}`,
    markdown: joinMarkdown([renderValue(parsed.commentBody)]),
  };
}

function buildCreateFeatureFlagPresentation(args: Record<string, unknown>): ApprovalPresentation {
  const parsed = CreateFeatureFlagApprovalArgsSchema.parse(args);
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

function buildGhIssueCreatePresentation(args: Record<string, unknown>): ApprovalPresentation {
  const parsed = GhIssueCreateApprovalArgsSchema.parse(args);
  return {
    title: `Create GitHub issue: ${renderValue(parsed.title) ?? "Untitled issue"}`,
    markdown: joinMarkdown([
      bullet("Directory", parsed.cwd),
      bullet("Title", parsed.title),
      bullet("Labels", parsed.labels?.join(", ")),
      bullet("Assignees", parsed.assignees?.join(", ")),
      bullet("Milestone", parsed.milestone),
      bullet("Parent", parsed.parent),
      section("Body preview", parsed.bodyPreview),
    ]),
  };
}

function buildAwsExecPresentation(args: Record<string, unknown>): ApprovalPresentation {
  const parsed = AwsExecApprovalArgsSchema.parse(args);
  const commandArgvJson = JSON.stringify(["aws", ...parsed.args], null, 2).replace(/`/g, "\\u0060");
  return {
    title: "Run aws command",
    markdown: joinMarkdown([
      bullet("Directory", parsed.cwd),
      // Render the exact argv shape; escaping backticks prevents an argument
      // from closing the Slack code fence.
      `*Command argv:*\n\`\`\`json\n${commandArgvJson}\n\`\`\``,
    ]),
  };
}

function renderValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? escapeMrkdwnText(trimmed) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return escapeMrkdwnText(JSON.stringify(value));
}

function bullet(label: string, value: unknown): string | undefined {
  const rendered = renderValue(value);
  return rendered ? `*${escapeMrkdwnText(label)}:* ${rendered}` : undefined;
}

function section(label: string, value: unknown): string | undefined {
  const rendered = renderValue(value);
  return rendered ? `*${escapeMrkdwnText(label)}:*\n${rendered}` : undefined;
}

function joinMarkdown(parts: Array<string | undefined>): string {
  const rendered = parts.filter((part): part is string => Boolean(part));
  return rendered.length > 0 ? rendered.join("\n\n") : "No arguments provided.";
}

function escapeMrkdwnText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trimForSlack(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const overflow = value.length - maxChars;
  const suffix = `…[+${overflow} chars]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function trimValue(value: unknown, step: TrimStep, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length <= step.maxStringLength) return value;
    const overflow = value.length - step.maxStringLength;
    return `${value.slice(0, step.maxStringLength)}…[+${overflow} chars]`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= step.maxDepth) return summarizeValue(value);
  if (Array.isArray(value)) {
    const kept = value.slice(0, step.maxArrayItems).map((item) => trimValue(item, step, depth + 1));
    if (value.length > step.maxArrayItems)
      kept.push(`[+${value.length - step.maxArrayItems} more items]`);
    return kept;
  }
  const entries = Object.entries(value);
  const keptEntries = entries
    .slice(0, step.maxObjectEntries)
    .map(([key, item]) => [key, trimValue(item, step, depth + 1)]);
  if (entries.length > step.maxObjectEntries) {
    keptEntries.push(["_trimmed", `[+${entries.length - step.maxObjectEntries} more keys]`]);
  }
  return Object.fromEntries(keptEntries);
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `[array(${value.length})]`;
  if (value instanceof Object) return `[object(${Object.keys(value).length})]`;
  return String(value);
}

function buildOversizeSummary(args: Record<string, unknown>) {
  return {
    _summary: "approval args too large for Slack",
    _keys: Object.keys(args).slice(0, 20),
  };
}
