export interface Issue {
  path: string;
  message: string;
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
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #222; }
  h1 { margin-top: 0; font-size: 1.4rem; }
  .bar { display: flex; gap: 1rem; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; font-size: 0.85rem; color: #666; }
  .meta { color: #666; }
  button { padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer; border: 1px solid #333; background: #333; color: #fff; border-radius: 4px; }
  button:hover { background: #000; }
  #editor { border: 1px solid #ccc; border-radius: 4px; overflow: hidden; }
  .cm-editor { height: 540px; }
  .cm-scroller { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .status { padding: 0.6rem 0.8rem; border-radius: 4px; margin: 0.75rem 0; font-size: 0.9rem; min-height: 1.2rem; }
  .status.ok { background: #e7f5e7; border: 1px solid #79c979; color: #1a5a1a; }
  .status.error { background: #fdecec; border: 1px solid #e08f8f; color: #8a1f1f; }
  .status ul { margin: 0.3rem 0 0 1.2rem; padding: 0; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 2px; }
  .actions { margin-top: 0.75rem; display: flex; justify-content: flex-end; }
</style>
</head>
<body>
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
        hx-on::before-request="document.getElementById('config').value = window.__cm.state.doc.toString()">
    <textarea id="config" name="config" style="display:none">${esc(props.raw)}</textarea>
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
  const src = document.getElementById("config");
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
