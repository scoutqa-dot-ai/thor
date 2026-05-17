import type { AliasRecord, AnchorSessionState, AnchorSessionStatus } from "@thor/common";

export interface Issue {
  path: string;
  message: string;
}

export interface SessionsProps {
  user: string | null;
  rows: AnchorSessionState[];
  refreshedAt: string;
  error: string | null;
  /** Slack workspace team id used to build thread permalinks; null disables linking. */
  slackTeamId: string | null;
}

interface DecodedExternalKey {
  label: string;
  href?: string;
  title?: string;
}

const GIT_BRANCH_PREFIX = "git:branch:";
const GITHUB_ISSUE_PREFIX = "github:issue:";

export function decodeExternalKey(
  key: { aliasType: AliasRecord["aliasType"]; aliasValue: string },
  opts: { slackTeamId: string | null },
): DecodedExternalKey | null {
  switch (key.aliasType) {
    case "slack.thread": {
      const slash = key.aliasValue.indexOf("/");
      if (slash <= 0) return { label: key.aliasValue };
      const channel = key.aliasValue.slice(0, slash);
      const ts = key.aliasValue.slice(slash + 1);
      const date = slackTsToDate(ts);
      const label = date ? `#${channel} · ${date}` : `#${channel} · ${ts}`;
      if (opts.slackTeamId) {
        return {
          label,
          href: `https://app.slack.com/client/${opts.slackTeamId}/${channel}/thread/${channel}-${ts}`,
          title: `${channel}/${ts}`,
        };
      }
      return { label, title: `${channel}/${ts}` };
    }
    case "slack.thread_id":
      return { label: `thread ${key.aliasValue}` };
    case "git.branch": {
      const decoded = safeBase64UrlDecode(key.aliasValue);
      if (!decoded?.startsWith(GIT_BRANCH_PREFIX)) return { label: key.aliasValue };
      const body = decoded.slice(GIT_BRANCH_PREFIX.length);
      const sep = body.indexOf(":");
      if (sep <= 0) return { label: body };
      const repo = body.slice(0, sep);
      const branch = body.slice(sep + 1);
      return { label: `${repo} · ${branch}`, title: decoded };
    }
    case "github.issue": {
      const decoded = safeBase64UrlDecode(key.aliasValue);
      if (!decoded?.startsWith(GITHUB_ISSUE_PREFIX)) return { label: key.aliasValue };
      const body = decoded.slice(GITHUB_ISSUE_PREFIX.length);
      // Body shape: "<inferredRepoName>:<owner>/<repo>#<number>". The owner/repo
      // pair lives after the first colon; link with it directly.
      const sep = body.indexOf(":");
      const tail = sep >= 0 ? body.slice(sep + 1) : body;
      const hash = tail.lastIndexOf("#");
      if (hash <= 0) return { label: tail, title: decoded };
      const ownerRepo = tail.slice(0, hash);
      const num = tail.slice(hash + 1);
      if (!/^\d+$/.test(num) || !ownerRepo.includes("/")) {
        return { label: tail, title: decoded };
      }
      return {
        label: `${ownerRepo}#${num}`,
        href: `https://github.com/${ownerRepo}/issues/${num}`,
        title: decoded,
      };
    }
    default:
      return null;
  }
}

function safeBase64UrlDecode(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    // Round-trip guard: reject non-base64url inputs that decoded to garbage.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function slackTsToDate(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  // Compact display: YYYY-MM-DD HH:MM
  return d.toISOString().replace("T", " ").slice(0, 16);
}

export interface PageProps {
  raw: string;
  mtime: string | null;
  user: string | null;
  readError: string | null;
  parseError: string | null;
  issues: Issue[];
  savedAt: string | null;
  savedBy: string | null;
}

export interface StatusProps {
  savedAt: string | null;
  savedBy: string | null;
  error: string | null;
  issues: Issue[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nav(active: "config" | "sessions"): string {
  const item = (href: string, label: string, key: "config" | "sessions") =>
    `<a class="${active === key ? "active" : ""}" href="${href}">${label}</a>`;
  return `<nav class="nav">${item("/admin/config", "Config", "config")}${item("/admin/sessions", "Sessions", "sessions")}</nav>`;
}

function baseStyles(): string {
  return `body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 1180px; padding: 0 1rem; color: #222; }
  h1 { margin-top: 0; font-size: 1.4rem; }
  .nav { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .nav a { color: #333; text-decoration: none; padding: 0.35rem 0.6rem; border: 1px solid #ddd; border-radius: 999px; }
  .nav a.active { background: #333; color: #fff; border-color: #333; }
  .bar { display: flex; gap: 1rem; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; font-size: 0.85rem; color: #666; }
  .meta { color: #666; }
  .status { padding: 0.6rem 0.8rem; border-radius: 4px; margin: 0.75rem 0; font-size: 0.9rem; min-height: 1.2rem; }
  .status.ok { background: #e7f5e7; border: 1px solid #79c979; color: #1a5a1a; }
  .status.error { background: #fdecec; border: 1px solid #e08f8f; color: #8a1f1f; }
  .status ul { margin: 0.3rem 0 0 1.2rem; padding: 0; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 2px; }`;
}

export function renderStatusFragment(props: StatusProps): string {
  if (props.error) {
    const issues = props.issues
      .map((i) => `<li><code>${esc(i.path)}</code>: ${esc(i.message)}</li>`)
      .join("");
    return `<div id="status" class="status error">
      <strong>${esc(props.error)}</strong>
      ${issues ? `<ul>${issues}</ul>` : ""}
    </div>`;
  }
  if (props.savedAt) {
    const who = props.savedBy ? ` by ${esc(props.savedBy)}` : "";
    return `<div id="status" class="status ok">Saved at ${esc(props.savedAt)}${who}</div>`;
  }
  return `<div id="status" class="status"></div>`;
}

export function renderConfigPage(props: PageProps): string {
  const status = renderStatusFragment({
    savedAt: props.savedAt,
    savedBy: props.savedBy,
    error: props.parseError,
    issues: props.issues,
  });
  const readError = props.readError
    ? `<div class="status error">Failed to read config: ${esc(props.readError)}</div>`
    : "";
  const meta = props.mtime ? `<span class="meta">File modified: ${esc(props.mtime)}</span>` : "";
  const who = props.user ? `<span class="meta">Signed in: ${esc(props.user)}</span>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Thor Admin — Config</title>
<style>
  ${baseStyles()}
  body { max-width: 960px; }
  button { padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer; border: 1px solid #333; background: #333; color: #fff; border-radius: 4px; }
  button:hover { background: #000; }
  #editor { border: 1px solid #ccc; border-radius: 4px; overflow: hidden; }
  .cm-editor { height: 540px; }
  .cm-scroller { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .actions { margin-top: 0.75rem; display: flex; justify-content: flex-end; }
</style>
</head>
<body>
  ${nav("config")}
  <h1>Workspace config</h1>
  <div class="bar">
    <div>${meta}</div>
    <div>${who}</div>
  </div>
  ${readError}
  <form id="config-form"
        hx-post="/admin/config"
        hx-target="#status"
        hx-swap="outerHTML"
        hx-vals='js:{config: window.__cm.state.doc.toString()}'>
    <textarea id="config-initial" style="display:none">${esc(props.raw)}</textarea>
    <div id="editor"></div>
    <div class="actions">
      <button type="submit">Save</button>
    </div>
  </form>
  ${status}

<script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
<script type="module">
  import {EditorView, basicSetup} from "https://esm.sh/codemirror@6.0.1";
  import {json, jsonParseLinter} from "https://esm.sh/@codemirror/lang-json@6.0.1";
  import {linter, lintGutter} from "https://esm.sh/@codemirror/lint@6.8.4";
  const src = document.getElementById("config-initial");
  const view = new EditorView({
    doc: src.value,
    extensions: [basicSetup, json(), lintGutter(), linter(jsonParseLinter())],
    parent: document.getElementById("editor"),
  });
  window.__cm = view;
</script>
</body>
</html>`;
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtRelative(iso: string | undefined, ms: number | undefined): string {
  if (!iso) return "—";
  if (ms === undefined) return `<span title="${esc(iso)}">${esc(iso)}</span>`;
  return `<span title="${esc(iso)}">${fmtDuration(ms)} ago</span>`;
}

function short(value?: string): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function statusLabel(status: AnchorSessionStatus): string {
  return status.replace("_", " ");
}

export function renderSessionsFragment(props: SessionsProps): string {
  const counts: Record<AnchorSessionStatus, number> = {
    stuck: 0,
    in_progress: 0,
    idle: 0,
    unknown: 0,
  };
  for (const row of props.rows) counts[row.status]++;
  const cards = ["stuck", "in_progress", "idle", "unknown"]
    .map(
      (key) =>
        `<div class="card ${key}"><strong>${counts[key as AnchorSessionStatus]}</strong><span>${statusLabel(key as AnchorSessionStatus)}</span></div>`,
    )
    .join("");
  const error = props.error
    ? `<div class="status error">Failed to read session state: ${esc(props.error)}</div>`
    : "";
  const body = props.rows.length
    ? `<table><thead><tr><th>Status</th><th>Anchor</th><th>Current session</th><th>External keys</th><th>Trigger</th><th>Last result</th><th>Started</th><th>Last event</th><th>Age / idle</th><th>Diagnostics</th></tr></thead><tbody>${props.rows
        .map((row) => {
          const owner =
            row.ownerSessionId && row.ownerSessionId !== row.currentSessionId
              ? `<br><small>owner ${esc(row.ownerSessionId)}</small>`
              : "";
          const hasNewSlack = row.externalKeys.some((k) => k.aliasType === "slack.thread");
          const chipParts = row.externalKeys
            .filter((k) => !(hasNewSlack && k.aliasType === "slack.thread_id"))
            .map((k) => {
              const decoded = decodeExternalKey(k, { slackTeamId: props.slackTeamId });
              if (!decoded) return "";
              const title = decoded.title ? ` title="${esc(decoded.title)}"` : "";
              if (decoded.href) {
                return `<a class="chip" href="${esc(decoded.href)}" target="_blank" rel="noopener"${title}>${esc(decoded.label)}</a>`;
              }
              return `<span class="chip"${title}>${esc(decoded.label)}</span>`;
            })
            .filter(Boolean);
          const keys = chipParts.length ? chipParts.join(" ") : "—";
          const trigger = row.triggerId
            ? `<a href="/runner/v/${encodeURIComponent(row.anchorId)}/${encodeURIComponent(row.triggerId)}">${esc(short(row.triggerId))}</a>`
            : "—";
          const lastResult = row.latestTerminalStatus
            ? `<span class="chip">${esc(row.latestTerminalStatus)}</span>`
            : "—";
          const ageIdle =
            row.ageMs !== undefined &&
            row.idleMs !== undefined &&
            Math.abs(row.ageMs - row.idleMs) < 1000
              ? fmtDuration(row.ageMs)
              : `${fmtDuration(row.ageMs)} / ${fmtDuration(row.idleMs)}`;
          const diagParts: string[] = [];
          if (row.sessionIds.length) diagParts.push(`${row.sessionIds.length} sessions`);
          if (row.subsessionIds.length) diagParts.push(`${row.subsessionIds.length} subsessions`);
          if (row.skippedMalformed) diagParts.push(`${row.skippedMalformed} malformed`);
          if (row.reason) diagParts.push(row.reason);
          const diag = diagParts.map((v) => esc(v)).join("; ");
          return `<tr><td><span class="badge ${esc(row.status)}">${esc(statusLabel(row.status))}</span></td><td><code title="${esc(row.anchorId)}">${esc(short(row.anchorId))}</code></td><td>${esc(short(row.currentSessionId))}${owner}</td><td>${keys}</td><td>${trigger}</td><td>${lastResult}</td><td>${fmtRelative(row.triggerStartedAt, row.ageMs)}</td><td>${fmtRelative(row.lastEventTs, row.idleMs)}</td><td>${ageIdle}</td><td>${diag || "—"}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<div class="empty">No anchors have been recorded yet. Session state is derived from <code>aliases.jsonl</code> and <code>sessions/*.jsonl</code>.</div>`;
  return `<section id="sessions-panel" hx-get="/admin/sessions/fragment" hx-trigger="every 10s" hx-swap="outerHTML">
    ${error}
    <div class="refresh-bar">
      <span class="meta">Refreshed <span title="${esc(props.refreshedAt)}">${esc(props.refreshedAt)}</span></span>
      <button type="button" hx-get="/admin/sessions/fragment" hx-target="#sessions-panel" hx-swap="outerHTML">Refresh</button>
    </div>
    <div class="cards">${cards}</div>
    ${body}
  </section>`;
}

export function renderSessionsPage(props: SessionsProps): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Thor Admin — Sessions</title>
<style>
  ${baseStyles()}
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #eee; padding: 0.45rem; text-align: left; vertical-align: top; }
  th { background: #fafafa; color: #555; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.6rem; margin: 1rem 0; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 0.7rem; background: #fff; }
  .card strong { display: block; font-size: 1.2rem; }
  .card span { color: #666; font-size: 0.8rem; }
  .badge, .chip { display: inline-block; border-radius: 999px; padding: 0.12rem 0.45rem; font-size: 0.75rem; }
  .badge.stuck { background: #fdecec; color: #8a1f1f; }
  .badge.in_progress { background: #fff7dc; color: #725000; }
  .badge.idle { background: #eef3f8; color: #35506b; }
  .badge.unknown { background: #eee; color: #555; }
  .chip { background: #f2f2f2; margin: 0 0.2rem 0.2rem 0; }
  a.chip { color: #14559d; text-decoration: none; }
  a.chip:hover { background: #e3ecf5; text-decoration: underline; }
  .empty { border: 1px dashed #bbb; border-radius: 6px; padding: 1rem; color: #666; }
  .refresh-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 0.5rem; font-size: 0.85rem; color: #666; }
  .refresh-bar button { padding: 0.25rem 0.7rem; font-size: 0.8rem; cursor: pointer; border: 1px solid #ccc; background: #fff; color: #333; border-radius: 4px; }
  .refresh-bar button:hover { background: #f4f4f4; }
  td span[title] { cursor: help; }
</style>
</head>
<body>
  ${nav("sessions")}
  <h1>Sessions</h1>
  <div class="bar"><div class="meta">Likely stuck after 5 minutes without events.</div><div>${props.user ? `Signed in: ${esc(props.user)}` : ""}</div></div>
  ${renderSessionsFragment(props)}
  <script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
</body>
</html>`;
}
