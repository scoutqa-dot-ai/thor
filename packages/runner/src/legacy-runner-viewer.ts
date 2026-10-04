import express from "express";
import {
  createLogger,
  logWarn,
  isUuidV7,
  reverseLookupAnchor,
  readTriggerSlice,
  sessionLogPath,
  getWorklogDir,
  SessionEventLogRecordSchema,
  isOmittedMarker,
  iterateJsonlFileLinesSync,
  formatTokens,
  formatDuration,
  formatAge,
  formatBytes,
  formatCostUsd,
  parseOpencodeEvent,
} from "@thor/common";
import type {
  OpencodeEvent,
  ReverseAnchorEntry,
  SessionEventLogRecord,
  ViewerPart,
  ViewerToolPart,
  ViewerPayloadOrOmitted,
  ParsedOpencodeEvent,
} from "@thor/common";
import {
  isOpencodeObject,
  readOpencodeString,
  extractOpencodeTokenCounts,
  type OpencodeTokenCounts,
} from "./opencode-event-fields.js";

const log = createLogger("runner");

/** Read-only legacy viewer; ingress owns SSO and no execution routes or clients are installed. */
export function createLegacyRunnerViewer(): express.Express {
  const app = express();
  function routeParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }
  // Auth and rate limiting for the runner viewer are intentionally enforced
  // at the infrastructure edge (ingress + Vouch), not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.get(
    "/runner/v/:anchorId",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
      const anchorId = routeParam(req.params.anchorId);
      if (!isUuidV7(anchorId)) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Anchor not found", "No Neo anchor context was found."));
        return;
      }
      const anchor = reverseLookupAnchor(anchorId);
      if (!anchorIsKnown(anchor)) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Anchor not found", "No Neo anchor context was found."));
        return;
      }
      res.type("html").send(renderPage("Neo context", "<p>Coming soon.</p>"));
    },
  );

  app.get(
    "/runner/v/:anchorId/:triggerId",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
      const anchorId = routeParam(req.params.anchorId);
      const triggerId = routeParam(req.params.triggerId);

      if (!isUuidV7(anchorId) || !isUuidV7(triggerId)) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Trigger not found", "No Neo trigger slice was found for this anchor."));
        return;
      }

      const owner = resolveOwnerSessionForTrigger(anchorId, triggerId);
      if (!owner.ok) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Trigger not found", "No Neo trigger slice was found for this anchor."));
        return;
      }

      let slice;
      try {
        slice = readTriggerSlice(owner.sessionId, triggerId);
      } catch {
        res
          .status(404)
          .type("html")
          .send(renderPage("Trigger not found", "No Neo trigger slice was found for this anchor."));
        return;
      }
      if ("notFound" in slice) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Trigger not found", "No Neo trigger slice was found for this anchor."));
        return;
      }
      res
        .type("html")
        .send(
          renderSlicePage(
            anchorId,
            triggerId,
            owner.sessionId,
            reverseLookupAnchor(anchorId),
            slice,
            { slackTeamId: process.env.SLACK_TEAM_ID?.trim() || null },
          ),
        );
    },
  );

  return app;
}

function resolveOwnerSessionForTrigger(
  anchorId: string,
  triggerId: string,
): { ok: true; sessionId: string } | { ok: false; reason: "not_found" } {
  const reverse = reverseLookupAnchor(anchorId);
  for (const sessionId of reverse.sessionIds) {
    const slice = readTriggerSlice(sessionId, triggerId);
    if (!("notFound" in slice)) return { ok: true, sessionId };
  }
  return { ok: false, reason: "not_found" };
}

function anchorIsKnown(anchor: ReverseAnchorEntry): boolean {
  return anchor.sessionIds.length + anchor.subsessionIds.length + anchor.externalKeys.length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSnippet(value: string | undefined): string {
  // Debugging UI: no redaction, no length cap. Newlines/tabs are collapsed
  // to spaces for one-line rendering surfaces.
  if (!value) return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

/**
 * Narrow a `ViewerPayloadOrOmitted` to a plain JSON object — null/array/
 * primitive/OmittedMarker collapse to undefined so callers can read fields
 * without re-guarding.
 */
function payloadObject(
  value: ViewerPayloadOrOmitted | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isOmittedMarker(value))
    return undefined;
  return value as Record<string, unknown>;
}

/**
 * Render an inline "(<label> omitted, N KB)" badge when `value` is a
 * `{ _omitted: true, bytes: N }` marker produced by capRecord's projection
 * step. Returns the empty string otherwise so callers can concatenate.
 */
function renderOmittedNote(value: unknown, label: string): string {
  if (!isOmittedMarker(value)) return "";
  return ` <span class="omitted">(${escapeHtml(label)} omitted, ${escapeHtml(formatBytes(value.bytes))})</span>`;
}

function viewerToolDisplayName(part: ViewerToolPart): string {
  // No bash-prefix heuristics — the raw `part.tool` is what the data says.
  return typeof part.tool === "string" ? part.tool : "tool";
}

function decodeAliasValue(aliasType: string, aliasValue: string): string {
  if (aliasType !== "git.branch") return aliasValue;
  try {
    const decoded = Buffer.from(aliasValue, "base64url").toString("utf8");
    return decoded.startsWith("git:branch:") ? decoded : aliasValue;
  } catch {
    return aliasValue;
  }
}

/**
 * Some tools have a single input field that *is* the call (skill → `name`,
 * bash → `command`). For those, render that one field inline so the row tells
 * the whole story without a click. `inline` uses `<code>` for short
 * one-liners; `block` uses `<pre>` to preserve newlines (heredocs etc.).
 * Everything else falls back to the generic collapsible JSON dump.
 */
const TOOL_PRIMARY_INPUT_FIELD: Record<string, { field: string; mode: "inline" | "block" }> = {
  skill: { field: "name", mode: "inline" },
  bash: { field: "command", mode: "block" },
};

function renderToolInput(toolName: string, input: unknown): string {
  if (input === undefined) return "";
  if (isOmittedMarker(input)) return renderOmittedNote(input, "input");
  const primary = TOOL_PRIMARY_INPUT_FIELD[toolName];
  if (primary && isOpencodeObject(input)) {
    const val = input[primary.field];
    if (typeof val === "string" && val) {
      const safe = escapeHtml(val);
      return primary.mode === "inline" ? ` <code>${safe}</code>` : `<pre>${safe}</pre>`;
    }
  }
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return `<details><summary>input</summary><pre>${escapeHtml(json)}</pre></details>`;
}

function viewEvent(record: SessionEventLogRecord): ParsedOpencodeEvent | undefined {
  if (record.type !== "opencode_event") return undefined;
  return parseOpencodeEvent(record.event);
}

function eventPart(record: SessionEventLogRecord): ViewerPart | undefined {
  const parsed = viewEvent(record);
  if (parsed?.kind !== "ok") return undefined;
  return parsed.event.type === "message.part.updated" ? parsed.event.properties.part : undefined;
}

function statusFromRawEvent(raw: unknown): "pending" | "running" | "completed" | "error" {
  if (!isOpencodeObject(raw)) return "pending";
  const properties = raw.properties;
  if (!isOpencodeObject(properties)) return "pending";
  const part = properties.part;
  if (!isOpencodeObject(part)) return "pending";
  const state = part.state;
  if (!isOpencodeObject(state)) return "pending";
  const status = state.status;
  return status === "running" || status === "completed" || status === "error" ? status : "pending";
}

function renderUnrecognizedEvent(
  ts: string,
  rawType: string | undefined,
  rawEvent: unknown,
): string {
  const type = rawType ?? "unknown";
  const status = statusFromRawEvent(rawEvent);
  return `<li class="row unknown" data-status="${escapeHtml(status)}"><b>unknown event</b> <span>${escapeHtml(type)}</span> <span class="ts">${escapeHtml(ts)}</span></li>`;
}

function sourceFrom(correlationKey: string | undefined): string {
  if (!correlationKey) return "direct";
  if (correlationKey.startsWith("slack:thread:")) return "slack";
  if (correlationKey.startsWith("git:branch:")) return "git";
  if (correlationKey.startsWith("github:")) return "github";
  if (correlationKey.startsWith("approval:")) return "approval";
  if (correlationKey.startsWith("cron:")) return "cron";
  return "direct";
}

type DecodedSource = { icon: string; label: string; href?: string };

function tryParseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const idx = value.indexOf("{");
  if (idx === -1) return undefined;
  try {
    const parsed = JSON.parse(value.slice(idx));
    return isOpencodeObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decodeSlackSource(
  correlationKey: string,
  promptPreview: string | undefined,
  slackTeamId: string | null,
): DecodedSource {
  const tail = correlationKey.slice("slack:thread:".length);
  const slash = tail.indexOf("/");
  let channel: string | undefined = slash > 0 ? tail.slice(0, slash) : undefined;
  const ts = slash > 0 ? tail.slice(slash + 1) : tail;

  const payload = tryParseJsonObject(promptPreview);
  let user: string | undefined;
  let text: string | undefined;
  if (payload) {
    const event = isOpencodeObject(payload.event) ? payload.event : payload;
    channel = channel ?? readOpencodeString(event.channel);
    user = readOpencodeString(event.user);
    text = readOpencodeString(event.text);
  }

  const head: string[] = [];
  if (channel) head.push(`#${channel}`);
  if (user) head.push(`@${user}`);
  let label = head.join(" · ");
  if (text) {
    const firstLine = text.split("\n", 1)[0] ?? "";
    const quoted = `“${safeSnippet(firstLine)}”`;
    label = label ? `${label} — ${quoted}` : quoted;
  } else if (!label) {
    label = `Slack thread ${ts}`;
  }

  const href =
    channel && ts && slackTeamId
      ? `https://app.slack.com/client/${slackTeamId}/${channel}/thread/${channel}-${ts}`
      : undefined;
  return { icon: "💬", label, href };
}

function decodeGithubSource(promptPreview: string | undefined): DecodedSource | undefined {
  const payload = tryParseJsonObject(promptPreview);
  if (!payload) return undefined;
  const repo = isOpencodeObject(payload.repository)
    ? readOpencodeString(payload.repository.full_name)
    : undefined;
  const sender = isOpencodeObject(payload.sender)
    ? readOpencodeString(payload.sender.login)
    : undefined;

  if (isOpencodeObject(payload.pull_request)) {
    const pr = payload.pull_request;
    const num = typeof pr.number === "number" ? pr.number : undefined;
    const htmlUrl = readOpencodeString(pr.html_url);
    const title = readOpencodeString(pr.title);
    const href =
      htmlUrl ?? (repo && num !== undefined ? `https://github.com/${repo}/pull/${num}` : undefined);
    const parts = [
      num !== undefined ? `PR #${num}` : "PR",
      repo,
      sender ? `@${sender}` : "",
    ].filter((s): s is string => !!s);
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title)}”` : parts.join(" · ");
    return { icon: "🔀", label, href };
  }

  if (isOpencodeObject(payload.issue)) {
    const issue = payload.issue;
    const num = typeof issue.number === "number" ? issue.number : undefined;
    const htmlUrl = readOpencodeString(issue.html_url);
    const title = readOpencodeString(issue.title);
    const href =
      htmlUrl ??
      (repo && num !== undefined ? `https://github.com/${repo}/issues/${num}` : undefined);
    const parts = [
      num !== undefined ? `Issue #${num}` : "Issue",
      repo,
      sender ? `@${sender}` : "",
    ].filter((s): s is string => !!s);
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title)}”` : parts.join(" · ");
    return { icon: "🐞", label, href };
  }

  if (
    typeof payload.ref === "string" &&
    (readOpencodeString(payload.after) || isOpencodeObject(payload.head_commit))
  ) {
    const branch = payload.ref.replace(/^refs\/heads\//, "");
    const sha = readOpencodeString(payload.after)?.slice(0, 7);
    const href = repo && sha ? `https://github.com/${repo}/commit/${sha}` : undefined;
    const left = repo && sha ? `${repo}@${sha}` : repo;
    const parts = [left, `on ${branch}`, sender ? `@${sender}` : ""].filter(
      (s): s is string => !!s,
    );
    return { icon: "📦", label: parts.join(" · "), href };
  }

  if (repo) {
    return { icon: "📦", label: repo, href: `https://github.com/${repo}` };
  }
  return undefined;
}

function decodeCronSource(promptPreview: string | undefined): DecodedSource {
  if (!promptPreview) return { icon: "⏰", label: "Cron" };
  const sentence = promptPreview.split(/[.\n]/, 1)[0]?.trim();
  return { icon: "⏰", label: sentence ? safeSnippet(sentence) : "Cron" };
}

function decodeSourceLine(
  correlationKey: string | undefined,
  promptPreview: string | undefined,
  slackTeamId: string | null,
): DecodedSource | undefined {
  if (!correlationKey) return undefined;
  if (correlationKey.startsWith("slack:thread:")) {
    return decodeSlackSource(correlationKey, promptPreview, slackTeamId);
  }
  if (correlationKey.startsWith("github:") || correlationKey.startsWith("git:branch:")) {
    return decodeGithubSource(promptPreview);
  }
  if (correlationKey.startsWith("cron:")) {
    return decodeCronSource(promptPreview);
  }
  return undefined;
}

function getStateTitle(part: ViewerToolPart): string | undefined {
  // Prefer Claude's own `state.title` (e.g. "Lists test-management Neo
  // worktrees"). Fall back to `state.input.description` for tools whose
  // caller supplied it (most notably `task`) so the row carries a label even
  // when `state.title` is absent.
  if (part.state.title) return part.state.title;
  const input = payloadObject(part.state.input);
  return input ? readOpencodeString(input.description) : undefined;
}

function renderDiffLines(patchText: string): string {
  // No line cap — render the entire patch. The whole block lives inside a
  // collapsed <details> on the apply_patch row, so volume is opt-in.
  const out = patchText
    .split("\n")
    .map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return `<span class="diff-meta">${safe}</span>`;
      }
      if (line.startsWith("+")) return `<span class="diff-add">${safe}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${safe}</span>`;
      return `<span>${safe}</span>`;
    })
    .join("\n");
  return `<pre class="diff">${out}</pre>`;
}

function renderApplyPatch(part: ViewerToolPart, durationStr: string | undefined): string {
  const title = getStateTitle(part);
  const rawInput = part.state.input;
  const inputOmitted = renderOmittedNote(rawInput, "patch");
  const input = payloadObject(rawInput);
  const patchText = input ? readOpencodeString(input.patchText) : undefined;
  const status = part.state.status;
  // Status text is suppressed — the colored bullet on the row carries it.
  const hdr = `<b>apply_patch</b>${durationStr ? ` <span>${escapeHtml(durationStr)}</span>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title))}</span>` : ""}${inputOmitted}`;
  if (!patchText) return `<li class="row" data-status="${escapeHtml(status)}">${hdr}</li>`;
  return `<li class="row" data-status="${escapeHtml(status)}"><details><summary>${hdr}</summary>${renderDiffLines(patchText)}</details></li>`;
}

type SubAgentCtx = { visited: Set<string> };

function partDuration(part: ViewerToolPart): string | undefined {
  const time = part.state?.time;
  if (typeof time?.start === "number" && typeof time.end === "number") {
    return formatDuration(time.end - time.start);
  }
  return undefined;
}

/**
 * Time window (ms since epoch) during which this task tool was running. We
 * use it to filter the subagent's session log so only events from THIS
 * invocation surface — main agents often resume the same subagent session
 * later, and we don't want unrelated events to bleed into the card.
 */
function partTimeWindow(part: ViewerToolPart): { start: number; end?: number } | undefined {
  const time = part.state?.time;
  if (typeof time?.start !== "number" || !Number.isFinite(time.start)) return undefined;
  return {
    start: time.start,
    end: typeof time.end === "number" && Number.isFinite(time.end) ? time.end : undefined,
  };
}

/**
 * Yield each record paired with its parsed event and (for message.part.updated)
 * the dedup-by-id resolved latest-state part. Records that should not render
 * (non-opencode_event records, trigger_*, and intermediate updates of a
 * streaming part) are skipped — what comes out is exactly the surface the
 * renderer needs to dispatch on.
 */
function* iterateParsedParts(records: SessionEventLogRecord[]): Generator<{
  rec: SessionEventLogRecord;
  parsed: ParsedOpencodeEvent;
  resolved: ViewerPart | undefined;
}> {
  const latestById = new Map<string, ViewerPart>();
  const firstIdxById = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type !== "opencode_event") continue;
    const parsed = parseOpencodeEvent(rec.event);
    if (parsed.kind !== "ok" || parsed.event.type !== "message.part.updated") continue;
    const part = parsed.event.properties.part;
    if (!part.id) continue;
    latestById.set(part.id, part);
    if (!firstIdxById.has(part.id)) firstIdxById.set(part.id, i);
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type !== "opencode_event") continue;
    const parsed = parseOpencodeEvent(rec.event);
    if (parsed.kind !== "ok" || parsed.event.type !== "message.part.updated") {
      yield { rec, parsed, resolved: undefined };
      continue;
    }
    const part = parsed.event.properties.part;
    if (part.id && firstIdxById.get(part.id) !== i) continue;
    const resolved = part.id ? (latestById.get(part.id) ?? part) : part;
    yield { rec, parsed, resolved };
  }
}

/** Bump stat counters on the ledger for tool/error/step-finish parts. */
function consumePartStats(part: ViewerPart, ledger: AgentLedger): void {
  if (part.type === "tool") {
    ledger.toolParts++;
    if (part.state.status === "error") ledger.errorRows++;
    return;
  }
  if (part.type === "step-finish") {
    const tokenTotal = numericTokenTotal(part.tokens);
    if (tokenTotal !== undefined) {
      ledger.totalTokens += tokenTotal;
      ledger.hasTokens = true;
    }
    const breakdown = extractOpencodeTokenCounts(part.tokens);
    if (breakdown) addTokenCounts(ledger.tokens, breakdown);
  }
}

/**
 * Render a single part to HTML. Empty string for silent parts (step-start,
 * snapshot, patch, agent, file, subtask, retry, empty reasoning). step-finish
 * renders as a step-boundary divider.
 */
function renderPart(part: ViewerPart, ledger: AgentLedger, ctx: SubAgentCtx): string {
  if (part.type === "tool") {
    const duration = partDuration(part);
    if (part.tool === "apply_patch") return renderApplyPatch(part, duration);
    if (part.tool === "task") return renderTaskCard(part, duration, ctx, ledger);
    const status = part.state.status;
    const name = viewerToolDisplayName(part);
    const title = getStateTitle(part);
    const input = renderToolInput(name, part.state.input);
    return `<li class="row" data-status="${escapeHtml(status)}"><b>tool</b> <span>${escapeHtml(name)}</span>${duration ? ` <span>${duration}</span>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title))}</span>` : ""}${status === "error" ? ` <span class="err">${escapeHtml(safeSnippet(part.state.error))}</span>` : ""}${input}</li>`;
  }
  if (part.type === "text") {
    return `<li class="row" data-status="completed"><b>text</b><div class="text-body">${escapeHtml(part.text)}</div></li>`;
  }
  if (part.type === "reasoning") {
    if (!part.text.trim()) return "";
    return `<li class="row" data-status="completed"><b>reasoning</b><div class="text-body">${escapeHtml(part.text)}</div></li>`;
  }
  if (part.type === "step-finish") {
    return `<li class="row step-boundary" data-status="completed"><hr></li>`;
  }
  if (part.type === "compaction") {
    return `<li class="row" data-status="completed"><b>context compacted</b>${part.auto ? " <span>auto</span>" : ""}</li>`;
  }
  return "";
}

function renderSessionErrorRow(event: Extract<OpencodeEvent, { type: "session.error" }>): string {
  const error = event.properties.error;
  const msg =
    error && typeof error === "object" && !isOmittedMarker(error) && !Array.isArray(error)
      ? (((error as { data?: { message?: string } }).data?.message ??
          (error as { message?: string }).message ??
          (error as { name?: string }).name) as string | undefined)
      : typeof error === "string"
        ? error
        : undefined;
  return `<li class="row err" data-status="error"><b>session error</b> ${escapeHtml(safeSnippet(msg ?? "Unknown error"))}</li>`;
}

/**
 * Shared rendering loop. Walks records, dispatches event types, accumulates
 * stats into `ledger`, returns the rendered rows. Used by both the main
 * timeline and the subagent inline renderer — callers wrap the result in
 * their preferred container.
 */
function renderActivity(
  records: SessionEventLogRecord[],
  ledger: AgentLedger,
  ctx: SubAgentCtx,
): string[] {
  const rows: string[] = [];
  for (const { rec, parsed, resolved } of iterateParsedParts(records)) {
    if (parsed.kind === "truncated") {
      rows.push(
        `<li class="row truncated" data-status="pending"><b>truncated event</b> <span class="ts">${escapeHtml(rec.ts)}</span></li>`,
      );
      continue;
    }
    if (parsed.kind === "unrecognized") {
      const rawEvent = rec.type === "opencode_event" ? rec.event : undefined;
      rows.push(renderUnrecognizedEvent(rec.ts, parsed.rawType, rawEvent));
      continue;
    }
    const event = parsed.event;
    if (event.type === "session.idle" || event.type === "session.status") continue;
    if (event.type === "session.error") {
      ledger.errorRows++;
      rows.push(renderSessionErrorRow(event));
      continue;
    }
    if (!resolved) continue; // recognized telemetry-only events
    consumePartStats(resolved, ledger);
    const row = renderPart(resolved, ledger, ctx);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Render a subagent session's activity inline. Subagent sessions are written
 * to their own `ses_*.jsonl` files (no trigger boundaries — task tool spawns
 * them outside the trigger endpoint), so we stream the file line-by-line,
 * filter to the trigger's time window, dedup by part id, and emit every major
 * row (tool + non-empty assistant text). No record cap — the viewer is
 * authenticated behind Vouch and must show the full subagent activity.
 *
 * Nested `task` tools call back into this function so the recursion follows
 * the subagent chain. `ctx.visited` is the only guard — cycles (a subagent
 * pointing back at itself or an ancestor) are the only thing that would
 * otherwise loop.
 */
function renderInlineSubagent(
  sessionId: string,
  ctx: SubAgentCtx,
  window: { start: number; end?: number } | undefined,
  label: string,
  modelId: string | undefined,
): { html: string | undefined; ledger: AgentLedger } | undefined {
  if (ctx.visited.has(sessionId)) return undefined;
  // Without a time window we can't tell which subagent events belong to THIS
  // invocation versus earlier/later resumes of the same session. Skip the
  // inline render rather than show stale rows.
  if (!window) return undefined;
  let path: string;
  try {
    path = sessionLogPath(sessionId);
  } catch {
    return undefined;
  }
  const records: SessionEventLogRecord[] = [];
  const readStarted = performance.now();
  let bytesRead = 0;
  let linesRead = 0;
  for (const line of iterateJsonlFileLinesSync(path)) {
    bytesRead += line.length + 1;
    linesRead++;
    try {
      const obj = JSON.parse(line);
      const v = SessionEventLogRecordSchema.safeParse(obj);
      if (!v.success) continue;
      const ts = Date.parse(v.data.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts < window.start) continue;
      if (window.end !== undefined && ts > window.end) continue;
      records.push(v.data);
    } catch {
      // skip malformed lines
    }
  }
  const readElapsedMs = performance.now() - readStarted;
  if (readElapsedMs > 50) {
    logWarn(log, "slow_subagent_jsonl_read", {
      sessionId,
      path,
      elapsedMs: Math.round(readElapsedMs),
      bytes: bytesRead,
      lines: linesRead,
      retained: records.length,
    });
  }
  if (!records.length) return undefined;

  const nextCtx: SubAgentCtx = {
    visited: new Set([...ctx.visited, sessionId]),
  };

  // The subagent's model id comes from the parent's `task` tool part metadata
  // (OpenCode tags the spawn with the child's model). Records inside the
  // subagent's own session don't carry it on step-finish parts, and any
  // modelID seen there would be a *grandchild's* model (another task tool).
  const ledger = emptyLedger(label, sessionId, modelId ? [modelId] : []);
  const rows = renderActivity(records, ledger, nextCtx);
  const html = rows.length
    ? `<details><summary>subagent activity (${rows.length} row${rows.length === 1 ? "" : "s"})</summary><ul class="events sub-events">${rows.join("")}</ul></details>`
    : undefined;
  // Even when the subagent had no display-worthy rows we keep the ledger so
  // its step-finish tokens still surface in the totals table.
  return { html, ledger };
}

function renderTaskCard(
  part: ViewerToolPart,
  durationStr: string | undefined,
  ctx: SubAgentCtx,
  parentLedger: AgentLedger,
): string {
  const rawInput = part.state.input;
  const inputOmitted = renderOmittedNote(rawInput, "input");
  const input = payloadObject(rawInput);
  const subagent = input ? readOpencodeString(input.subagent_type) : undefined;
  const description = input ? readOpencodeString(input.description) : undefined;
  const prompt = input ? readOpencodeString(input.prompt) : undefined;
  const status = part.state.status;
  const rawMetadata = part.state.metadata;
  const metadataOmitted = renderOmittedNote(rawMetadata, "metadata");
  const metadata = payloadObject(rawMetadata);
  const subSession = metadata ? readOpencodeString(metadata.sessionId) : undefined;
  const hdr = `🤖 <b>task</b>${subagent ? ` · ${escapeHtml(subagent)}` : ""}${durationStr ? ` · ${escapeHtml(durationStr)}` : ""}${inputOmitted}${metadataOmitted}`;
  const desc = description ? `<div>${escapeHtml(safeSnippet(description))}</div>` : "";
  const subChip = subSession
    ? `<div class="task-sub">subagent session <code>${escapeHtml(safeSnippet(subSession))}</code></div>`
    : "";
  const promptBlock = prompt
    ? `<details><summary>prompt</summary><pre>${escapeHtml(prompt)}</pre></details>`
    : "";
  // Task `state.output` is the model-facing summary of the subagent run.
  // We deliberately do not render it here — the subagent activity expansion
  // below already surfaces the assistant text and tool rows that comprise it.
  let subActivity = "";
  if (subSession) {
    const ledgerLabel = subagent ? `task · ${subagent}` : "task";
    // OpenCode tags the `task` tool part with the *child's* model — that's
    // the reliable source for the subagent's model id.
    const taskModelInfo = metadata && isOpencodeObject(metadata.model) ? metadata.model : undefined;
    const childModelId = taskModelInfo ? readOpencodeString(taskModelInfo.modelID) : undefined;
    const result = renderInlineSubagent(
      subSession,
      ctx,
      partTimeWindow(part),
      ledgerLabel,
      childModelId,
    );
    if (result) {
      parentLedger.children.push(result.ledger);
      subActivity = result.html ?? "";
    }
  }
  return `<li class="task-card" data-status="${escapeHtml(status)}"><div class="task-hdr">${hdr}</div>${desc}${subChip}${promptBlock}${subActivity}</li>`;
}

function renderSourceLine(source: DecodedSource): string {
  const inner = `${source.icon} ${escapeHtml(source.label)}`;
  if (source.href) {
    const safeHref = source.href.startsWith("https://") ? source.href : undefined;
    if (safeHref) {
      return `<p class="source"><a href="${escapeHtml(safeHref)}" rel="noopener noreferrer">${inner} ↗</a></p>`;
    }
  }
  return `<p class="source">${inner}</p>`;
}

function numericTokenTotal(tokens: unknown): number | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  let total = 0;
  let found = false;
  const stack: unknown[] = [tokens];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (typeof child === "number" && Number.isFinite(child)) {
        total += child;
        found = true;
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return found ? total : undefined;
}

/**
 * Recover the user prompt body from the opencode_event stream. Neo wraps
 * every prompt as `[correlation-key: <key>]\n\n<body>` before sending it to
 * OpenCode (see prompt construction in `legacy-runner.ts`), and OpenCode echoes that
 * text back through `message.part.updated` events. The first such text part
 * for this trigger's correlation key is the original prompt.
 */
function extractCorrelationKeyPrompt(
  records: SessionEventLogRecord[],
  correlationKey: string,
): string | undefined {
  const prefix = `[correlation-key: ${correlationKey}]`;
  for (const record of records) {
    if (record.type !== "opencode_event") continue;
    const part = eventPart(record);
    if (!part || part.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (!text.startsWith(prefix)) continue;
    return text.slice(prefix.length).replace(/^\s+/, "");
  }
  return undefined;
}

/**
 * Per-million-token USD prices for the model ids Neo currently runs against.
 *
 * Source: https://models.dev/api.json (snapshot 2026-05-15). To refresh:
 *   curl -s https://models.dev/api.json | jq '.openai.models["gpt-5.4","gpt-5.5"]'
 *
 * Only the exact ids Neo uses are listed; any other model id renders without
 * a cost estimate so we never surface guessed numbers. The 200k+ context tier
 * (which roughly doubles the published prices) is intentionally ignored — we
 * render the base-tier estimate and prefix it with `~`.
 */
const MODEL_PRICING_USD_PER_M: Record<
  string,
  { input: number; output: number; cacheRead?: number }
> = {
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
};

function estimateCostUsd(
  tokens: OpencodeTokenCounts,
  modelId: string | undefined,
): number | undefined {
  if (!modelId) return undefined;
  const pricing = MODEL_PRICING_USD_PER_M[modelId];
  if (!pricing) return undefined;
  const cacheRead = pricing.cacheRead ?? pricing.input;
  // Reasoning tokens are billed at the completion (output) rate.
  return (
    (tokens.input * pricing.input +
      (tokens.output + tokens.reasoning) * pricing.output +
      tokens.cacheRead * cacheRead) /
    1_000_000
  );
}

type AgentLedger = {
  label: string;
  sessionId: string;
  modelIds: Set<string>;
  tokens: OpencodeTokenCounts;
  children: AgentLedger[];
  /** Bumped per rendered tool part. */
  toolParts: number;
  /** Bumped per error-status tool part and per session.error event. */
  errorRows: number;
  /** Sum of `step-finish` numeric token totals (single-number summary). */
  totalTokens: number;
  /** True once any step-finish has carried token counts. Drives footer
   *  visibility for model/cost so empty triggers don't surface defaults. */
  hasTokens: boolean;
};

function emptyLedger(
  label: string,
  sessionId: string,
  modelIds: Iterable<string> = [],
): AgentLedger {
  return {
    label,
    sessionId,
    modelIds: new Set(modelIds),
    tokens: emptyTokenCounts(),
    children: [],
    toolParts: 0,
    errorRows: 0,
    totalTokens: 0,
    hasTokens: false,
  };
}

function emptyTokenCounts(): OpencodeTokenCounts {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
}

function addTokenCounts(target: OpencodeTokenCounts, src: OpencodeTokenCounts): void {
  target.input += src.input;
  target.output += src.output;
  target.reasoning += src.reasoning;
  target.cacheRead += src.cacheRead;
}

function hasAnyTokens(t: OpencodeTokenCounts): boolean {
  return t.input + t.output + t.reasoning + t.cacheRead > 0;
}

function sumLedgerTokens(node: AgentLedger): OpencodeTokenCounts {
  const acc = emptyTokenCounts();
  const walk = (n: AgentLedger) => {
    addTokenCounts(acc, n.tokens);
    n.children.forEach(walk);
  };
  walk(node);
  return acc;
}

function flattenLedger(root: AgentLedger): Array<{ ledger: AgentLedger; depth: number }> {
  const out: Array<{ ledger: AgentLedger; depth: number }> = [];
  const walk = (n: AgentLedger, depth: number) => {
    out.push({ ledger: n, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
}

function ledgerRowCost(l: AgentLedger): number | undefined {
  if (l.modelIds.size !== 1) return undefined;
  const [m] = l.modelIds;
  return estimateCostUsd(l.tokens, m);
}

function tokenCell(n: number): string {
  return n > 0 ? escapeHtml(formatTokens(n)) : "—";
}

function renderTotalsTable(root: AgentLedger): string {
  const flat = flattenLedger(root);
  const total = sumLedgerTokens(root);
  let totalCost = 0;
  let costPartial = false;
  const rows = flat.map(({ ledger, depth }) => {
    const indent = `style="padding-left:${depth * 16 + 8}px"`;
    const prefix = depth > 0 ? "└ " : "";
    const sidChip = ledger.sessionId
      ? ` <code class="ledger-sid" title="${escapeHtml(ledger.sessionId)}">${escapeHtml(ledger.sessionId)}</code>`
      : "";
    const models = [...ledger.modelIds].sort();
    const modelCell = models.length ? escapeHtml(models.join(", ")) : "—";
    const cost = ledgerRowCost(ledger);
    if (cost !== undefined && cost > 0) {
      totalCost += cost;
    } else if (hasAnyTokens(ledger.tokens)) {
      costPartial = true;
    }
    const costCell = cost !== undefined && cost > 0 ? `~${formatCostUsd(cost)}` : "—";
    return (
      `<tr><th scope="row" ${indent}>${prefix}${escapeHtml(ledger.label)}${sidChip}</th>` +
      `<td>${modelCell}</td>` +
      `<td>${tokenCell(ledger.tokens.input)}</td>` +
      `<td>${tokenCell(ledger.tokens.cacheRead)}</td>` +
      `<td>${tokenCell(ledger.tokens.output)}</td>` +
      `<td>${tokenCell(ledger.tokens.reasoning)}</td>` +
      `<td>${costCell}</td></tr>`
    );
  });
  const totalCostCell =
    totalCost > 0 ? `${costPartial ? "≥ " : ""}~${formatCostUsd(totalCost)}` : "—";
  const totalRow =
    `<tr class="totals-total"><th scope="row">Total</th><td>—</td>` +
    `<td>${tokenCell(total.input)}</td>` +
    `<td>${tokenCell(total.cacheRead)}</td>` +
    `<td>${tokenCell(total.output)}</td>` +
    `<td>${tokenCell(total.reasoning)}</td>` +
    `<td>${totalCostCell}</td></tr>`;
  return (
    `<table class="totals-table"><thead><tr>` +
    `<th>Agent</th><th>Model</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Cost</th>` +
    `</tr></thead><tbody>${rows.join("")}${totalRow}</tbody></table>`
  );
}

/** UUIDs render as their last 7 characters everywhere on the viewer. */
function shortUuid(value: string): string {
  return value.length > 7 ? value.slice(-7) : value;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="/favicon-v4.svg"><link rel="manifest" href="/site.webmanifest"><title>${escapeHtml(title)}</title><style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}main{max-width:900px;margin:0 auto;padding:24px}.pill{display:inline-block;border-radius:999px;padding:4px 10px;font-weight:700}.completed{background:#dcfce7;color:#166534}.error,.crashed{background:#fee2e2;color:#991b1b}.aborted{background:#ffedd5;color:#9a3412}.in_flight{background:#fef9c3;color:#854d0e}.summary{color:#334155;font-weight:500;margin:8px 0}.chips{color:#475569;font-size:0.9em;margin:4px 0}.chips code{font-size:0.95em}.live{display:inline-block;margin-left:8px;color:#dc2626;font-size:0.9em;animation:thor-pulse 1.6s ease-in-out infinite}@keyframes thor-pulse{0%,100%{opacity:1}50%{opacity:0.35}}@media (prefers-reduced-motion:reduce){.live{animation:none}}.row.truncated{color:#94a3b8;font-style:italic}.row.truncated .ts{color:#cbd5e1;font-size:0.85em;margin-left:4px}.omitted{color:#94a3b8;font-style:italic;font-size:0.9em}.source{margin:8px 0;font-size:1.05em}.source a{color:#0f172a;text-decoration:none;border-bottom:1px solid #cbd5e1}.source a:hover{border-bottom-color:#0f172a}.events{list-style:none;padding-left:0}.events>li{margin:6px 0}.row.step-boundary{padding-left:0}.row.step-boundary::before{display:none}.row.step-boundary hr{border:none;border-top:1px dashed #cbd5e1;margin:8px 0}.row{position:relative;padding-left:18px}.row::before{content:"";position:absolute;left:2px;top:0.55em;width:8px;height:8px;border-radius:50%;background:#94a3b8}.row[data-status="completed"]::before{background:#22c55e}.row[data-status="running"]::before{background:#facc15}.row[data-status="pending"]::before{background:#cbd5e1}.row[data-status="error"]::before{background:#ef4444}.row[data-status="aborted"]::before{background:#f97316}.tool-title{color:#475569;font-style:italic;margin-left:6px}.text-body{white-space:pre-wrap;margin:4px 0 0;color:#0f172a;font-size:0.95em}.task-card{background:#f1f5f9;border-left:3px solid #6366f1;padding:8px 12px;border-radius:4px;margin:6px 0;list-style:none}.task-card .task-hdr{color:#3730a3;font-size:0.9em;font-weight:600;margin-bottom:4px}.task-card .task-sub{color:#475569;font-size:0.85em;margin:2px 0 4px}.sub-events{margin:6px 0 0;padding-left:12px;border-left:2px solid #c7d2fe}.totals{color:#475569;font-size:0.95em;margin:12px 0 4px}.totals-table{border-collapse:collapse;font-size:0.9em;margin:8px 0;width:100%}.totals-table th,.totals-table td{padding:4px 8px;text-align:right;border-bottom:1px solid #e2e8f0}.totals-table thead th{color:#64748b;font-weight:600;text-align:right;border-bottom:1px solid #cbd5e1}.totals-table thead th:first-child,.totals-table tbody th{text-align:left}.totals-table tbody th{font-weight:500;color:#0f172a}.totals-table .ledger-sid{color:#64748b;font-size:0.85em;margin-left:4px}.totals-table tr.totals-total th,.totals-table tr.totals-total td{font-weight:700;border-top:2px solid #cbd5e1;border-bottom:none;padding-top:6px}.diff{font-size:0.85em;line-height:1.4}.diff .diff-add{color:#86efac;display:block}.diff .diff-del{color:#fca5a5;display:block}.diff .diff-meta{color:#94a3b8;display:block}details{margin:4px 0}summary{cursor:pointer}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${body}</main></body></html>`;
}

function renderSlicePage(
  anchorId: string,
  triggerId: string,
  ownerSessionId: string,
  anchor: ReverseAnchorEntry,
  slice: Exclude<ReturnType<typeof readTriggerSlice>, { notFound: true }>,
  opts: { slackTeamId: string | null },
): string {
  const start = slice.records.find(
    (record) => record.type === "trigger_start" && record.triggerId === triggerId,
  );
  const end = slice.records.find(
    (record) => record.type === "trigger_end" && record.triggerId === triggerId,
  );
  const correlationKey = start?.type === "trigger_start" ? start.correlationKey : undefined;
  // The user prompt body lives in the opencode_event stream as the first
  // `text` part prefixed with `[correlation-key: <key>]` — see prompt
  // construction in `legacy-runner.ts`. Strip the prefix to recover the original prompt;
  // that's what `decodeSourceLine` parses for Slack/GitHub fields.
  const promptPreview = correlationKey
    ? extractCorrelationKeyPrompt(slice.records, correlationKey)
    : undefined;

  // TODO(model-attribution): the main agent's model isn't recorded anywhere
  // in the on-disk JSONL today — OpenCode emits it on `message.updated`
  // events which Neo's runner doesn't subscribe to, and `step-finish` parts
  // don't carry it. We hardcode `gpt-5.4` (Neo's current default main-agent
  // model) so the totals/cost stay useful; switch to the real value once
  // the runner persists `message.updated` events or we call `sessions.get`
  // at render time.
  const rootLedger = emptyLedger("main", ownerSessionId, ["gpt-5.4"]);
  const tokenTotals = rootLedger.tokens;
  const modelIds = rootLedger.modelIds;
  const subAgentCtx: SubAgentCtx = { visited: new Set([ownerSessionId]) };
  const rows = renderActivity(slice.records, rootLedger, subAgentCtx);
  const { toolParts, errorRows, totalTokens, hasTokens } = rootLedger;

  const aliases = anchor.externalKeys
    .map(
      (key) => `${key.aliasType}: ${safeSnippet(decodeAliasValue(key.aliasType, key.aliasValue))}`,
    )
    .join("; ");
  const durationStr = formatDuration(end?.type === "trigger_end" ? end.durationMs : undefined);
  // "last event ago" is only useful while in flight (admin watching for a
  // stall). On terminal triggers it just restates how long ago the trigger
  // ended — drop it.
  const ageStr = slice.status === "in_flight" ? formatAge(slice.lastEventTs) : undefined;
  const summaryBits = [
    durationStr,
    `${toolParts} tools`,
    errorRows ? `${errorRows} errors` : undefined,
    ageStr ? `last event ${ageStr} ago` : undefined,
  ].filter((s): s is string => !!s);
  const summaryLine = summaryBits.join(" · ");

  const pillReason =
    (slice.status === "aborted" || slice.status === "crashed") && slice.reason
      ? ` · ${escapeHtml(safeSnippet(slice.reason))}`
      : "";
  const livePill =
    slice.status === "in_flight" ? ` <span class="live" aria-label="live">● live</span>` : "";
  const ownerChip = `<code>${escapeHtml(safeSnippet(ownerSessionId))}</code>`;
  const currentChip =
    anchor.currentSessionId && anchor.currentSessionId !== ownerSessionId
      ? ` · current <code>${escapeHtml(safeSnippet(anchor.currentSessionId))}</code>`
      : "";
  // Subagent token rollup: when the trigger spawned subagents, render a table
  // (one row per agent, indented by depth) so admins can see per-subagent cost
  // alongside the main trigger. Otherwise keep the single-line footer.
  let totalsFooter = "";
  if (rootLedger.children.length > 0) {
    totalsFooter = `<div class="totals">${renderTotalsTable(rootLedger)}</div>`;
  } else {
    const totalsBits: string[] = [];
    if (hasTokens) {
      const tokenParts: string[] = [];
      if (tokenTotals.input) tokenParts.push(`${formatTokens(tokenTotals.input)} input`);
      if (tokenTotals.cacheRead) tokenParts.push(`${formatTokens(tokenTotals.cacheRead)} cached`);
      if (tokenTotals.output) tokenParts.push(`${formatTokens(tokenTotals.output)} output`);
      if (tokenTotals.reasoning)
        tokenParts.push(`${formatTokens(tokenTotals.reasoning)} reasoning`);
      totalsBits.push(
        tokenParts.length
          ? `Tokens: ${tokenParts.join(" · ")}`
          : `Tokens: ${formatTokens(totalTokens)}`,
      );
    }
    const sortedModelIds = [...modelIds].sort();
    // Only surface model/cost when we actually saw token data — avoids
    // confidently displaying the hardcoded `gpt-5.4` default on zero-token
    // sessions (e.g. an aborted trigger with no step-finish parts).
    if (hasTokens) {
      if (sortedModelIds.length === 1) {
        totalsBits.push(`Model: ${escapeHtml(sortedModelIds[0]!)}`);
      } else if (sortedModelIds.length > 1) {
        totalsBits.push(`Models: ${sortedModelIds.map((m) => escapeHtml(m)).join(", ")}`);
      }
      if (sortedModelIds.length === 1) {
        const cost = estimateCostUsd(tokenTotals, sortedModelIds[0]);
        if (cost !== undefined && cost > 0) {
          totalsBits.push(`Est cost: ~${formatCostUsd(cost)}`);
        }
      }
    }
    totalsFooter = totalsBits.length ? `<p class="totals">${totalsBits.join(" · ")}</p>` : "";
  }
  const decodedSource = decodeSourceLine(correlationKey, promptPreview, opts.slackTeamId);
  const sourceLine = decodedSource ? renderSourceLine(decodedSource) : "";
  // Tab title: <source-type> · <short-trigger-id> · Neo.
  // Short id makes multiple open tabs distinguishable without duplicating the
  // full source label that the in-page source line already shows.
  const pageTitle = `${sourceFrom(correlationKey)} · ${shortUuid(triggerId)} · Neo`;

  const activityHtml = rows.length
    ? `<ul class="events">${rows.join("")}</ul>`
    : "<p>No meaningful events recorded.</p>";

  // The prompt body now lives as the first activity row (the
  // `[correlation-key: …]` text part). No need for a separate preview block
  // in Trigger context.

  const body = `<section><span class="pill ${slice.status}">${escapeHtml(slice.status.replace("_", " "))}${pillReason}</span>${livePill}<h2>${escapeHtml(sourceFrom(correlationKey))} trigger</h2>${sourceLine}${summaryLine ? `<p class="summary">${escapeHtml(summaryLine)}</p>` : ""}<p class="chips">anchor <code title="${escapeHtml(anchorId)}">${escapeHtml(shortUuid(anchorId))}</code> · trigger <code title="${escapeHtml(triggerId)}">${escapeHtml(shortUuid(triggerId))}</code> · session ${ownerChip}${currentChip}</p></section><section><h3>Trigger context</h3>${correlationKey ? `<p>Correlation <code>${escapeHtml(safeSnippet(correlationKey))}</code></p>` : ""}${aliases ? `<p>Aliases: ${escapeHtml(aliases)}</p>` : ""}<p>Sessions: ${anchor.sessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id))}</code>`).join(" ") || "none"}</p>${anchor.subsessionIds.length ? `<p>Subsessions: ${anchor.subsessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id))}</code>`).join(" ")}</p>` : ""}</section><section>${activityHtml}${totalsFooter}</section>`;
  return renderPage(pageTitle, body);
}
