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
