import { PiTaskRoutingOverridesSchema, type PiTaskRoutingOverrides } from "@thor/common";
import type { SlackThreadEvent } from "./slack.js";

/** Invalid current-request selectors are terminal, visible errors, never silently ignored. */
export class SlackModelDirectiveError extends Error {
  /** Stable directive error tag for dispatch rejection. */
  readonly _tag = "SlackModelDirectiveError";
  /** Construct a safe diagnostic without echoing request contents. */
  constructor() {
    super(
      "Neo model directive invalid: use [profile:strong thinking:high], [model:configured-id thinking:low], or [thinking:high]; profile and model cannot be combined.",
    );
  }
}
/** Current Slack routing evidence, or a fail-closed directive error. */
export type SlackModelRoutingResult =
  | { ok: true; value: PiTaskRoutingOverrides }
  | { ok: false; error: SlackModelDirectiveError };

const looksLikeDirective = (text: string) =>
  /^\[(?:(?:profile|model|thinking)\b|[a-z]+\s*:)/i.test(text);

/** Read the newest queued requester event (chronological input), never rendered thread/history fields. */
export function extractSlackModelRouting(input: {
  events: readonly SlackThreadEvent[];
  triggerSlackId?: string;
}): SlackModelRoutingResult {
  const event =
    input.triggerSlackId === undefined
      ? undefined
      : [...input.events]
          .reverse()
          .find((candidate) => candidate.user === input.triggerSlackId && !candidate.bot_id);
  if (!event) return { ok: true, value: {} };
  const text = event.text ?? "";
  // Slack mention syntax is a delimiter only, not actor authority.
  const task = text.replace(/^\s*<@[A-Z0-9]+> ?/, "");
  const prefix = task.trimStart();
  if (!looksLikeDirective(prefix)) return { ok: true, value: { routingTask: task } };
  const close = prefix.indexOf("]");
  const invalid = (): SlackModelRoutingResult => ({
    ok: false,
    error: new SlackModelDirectiveError(),
  });
  if (close < 0) return invalid();
  const tokens = prefix.slice(1, close).split(/\s+/).filter(Boolean);
  const fields: Record<string, string> = {};
  for (const token of tokens) {
    const match = /^(profile|model|thinking):([^\s\[\]]+)$/.exec(token);
    if (!match || fields[match[1]] !== undefined) return invalid();
    fields[match[1]] = match[2];
  }
  // One ordinary separating space belongs to directive syntax; preserve every
  // remaining character, including newlines/indentation in code-oriented tasks.
  const body = prefix.slice(close + 1).replace(/^ /, "");
  if (tokens.length === 0 || looksLikeDirective(body.trimStart())) return invalid();
  const parsed = PiTaskRoutingOverridesSchema.safeParse({
    ...(fields.profile === undefined ? {} : { modelProfile: fields.profile }),
    ...(fields.model === undefined ? {} : { modelId: fields.model }),
    ...(fields.thinking === undefined ? {} : { thinkingLevel: fields.thinking }),
    routingTask: body,
  });
  return parsed.success ? { ok: true, value: parsed.data } : invalid();
}
