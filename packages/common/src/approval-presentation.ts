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

/**
 * Render the approval card body for a known tool. The set of approval tools is
 * a closed discriminated union (`ApprovalRequiredEventPayloadSchema`) and the
 * gate (`createPending`) rejects anything outside it, so this is total: the
 * `assertNever` default makes "every tool has a presentation" a compile-time
 * invariant and fails loudly at runtime for a value force-cast past the type.
 */
export function buildApprovalPresentation(
  tool: ApprovalToolName,
  args: Record<string, unknown>,
): ApprovalPresentation {
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
    default: {
      const _exhaustive: never = tool;
      throw new Error(`No approval presentation for tool: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Whether the presentation body exceeds Slack's section limit and must be
 * uploaded as a file rather than truncated into the card. Title overflow is not
 * considered — titles are short by construction; the body carries the content.
 */
export function approvalPresentationIsOversize(presentation: ApprovalPresentation): boolean {
  return presentation.markdown.length > SLACK_SECTION_TEXT_LIMIT;
}

/** Full, untruncated Markdown for the uploaded approval file. */
export function buildApprovalFileMarkdown(presentation: ApprovalPresentation): string {
  return `# ${presentation.title}\n\n${presentation.markdown}\n`;
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

/**
 * When `fileUrl` is set, the body was uploaded as a file (oversize): the card
 * shows a truncated preview and links the full content below it.
 */
export function buildApprovalPresentationBlocks(
  presentation: ApprovalPresentation,
  buttonValue: string,
  fileUrl?: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
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
  ];
  if (fileUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:paperclip: <${fileUrl}|View the full content>`,
      },
    });
  }
  blocks.push(...buildActionBlocks(buttonValue));
  return blocks;
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
