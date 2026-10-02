// Runs inside the disposable OpenCode image against the real wrapper + gws.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseUrl = process.env.THOR_REMOTE_CLI_URL;
const state = async () => (await fetch(`${baseUrl}/fixture-state`)).json();
async function gws(args) {
  const pending = await exec("gws", args);
  const event = JSON.parse(pending.stdout);
  assert.equal(event.type, "approval_required");
  assert.equal(event.tool, "google_workspace_command");
  assert.match(event.args.command_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(event.args.google_workspace_email, "person@example.com");

  const response = await fetch(`${baseUrl}/fixture-approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId: event.actionId }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  if (result.exitCode !== 0) {
    const error = new Error(result.stderr || result.stdout || "gws fixture command failed");
    error.code = result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

assert.match(await gws(["--version"]), /0\.22\.5/);
assert.match(await gws(["--help"]), /gws/);
assert.match(await gws(["docs", "documents", "get", "--help"]), /params/);
assert.match(await gws(["schema", "docs.documents.get"]), /documentId/);
assert.match(await gws(["schema", "docs.documents.create"]), /POST/);
await assert.rejects(
  exec("gws", ["auth", "--help"]),
  (error) => error.code === 1 && /auth commands are disabled/.test(error.stderr),
);
assert.ok((await state()).tokenRequests > 0, "approved commands must refresh user OAuth");

// Even a repo-local dotenv cannot select credentials/token/cache for the server.
await writeFile(
  "/workspace/.env",
  "GOOGLE_WORKSPACE_CLI_TOKEN=attacker-token\nGOOGLE_WORKSPACE_CLI_CONFIG_DIR=/workspace/poison\n",
);
assert.equal(
  JSON.parse(
    await gws([
      "drive",
      "files",
      "list",
      "--params",
      '{"q":"name contains \'report\'","pageSize":5}',
    ]),
  ).files[0].name,
  "Fixture report",
);
const doc = JSON.parse(
  await gws([
    "docs",
    "documents",
    "get",
    "--params",
    '{"documentId":"doc-id","includeTabsContent":true}',
  ]),
);
assert.equal(
  doc.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content,
  "Fixture document text\n",
);
const sheet = JSON.parse(
  await gws(["sheets", "+read", "--spreadsheet", "sheet-id", "--range", "Sheet1!A1:B2"]),
);
assert.deepEqual(sheet.values, [["Fixture", 42]]);
const batch = JSON.parse(
  await gws([
    "sheets",
    "spreadsheets",
    "values",
    "batchGet",
    "--params",
    '{"spreadsheetId":"sheet-id","ranges":["Sheet1!A1:B2","Sheet2!A1:B2"]}',
  ]),
);
assert.equal(batch.valueRanges.length, 2);
assert.equal(
  JSON.parse(
    await gws([
      "sheets",
      "spreadsheets",
      "getByDataFilter",
      "--params",
      '{"spreadsheetId":"sheet-id"}',
      "--json",
      '{"includeGridData":true}',
    ]),
  ).spreadsheetId,
  "sheet-id",
);

const pages = (await gws(["drive", "files", "list", "--page-all", "--page-limit=12"]))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(pages.length, 12, "caller pagination must reach upstream without a Thor cap");
assert.equal(pages.at(-1).nextPageToken, "12");
assert.equal(
  (await gws(["drive", "files", "list", "--page-all", "--page-limit=2"])).trim().split("\n").length,
  2,
);

assert.match(await gws(["drive", "files", "list", "--format", "yaml"]), /^files:/m);
assert.deepEqual(
  JSON.parse(await gws(["docs", "documents", "create", "--json", '{"title":"Fixture write"}'])),
  {
    documentId: "created-document",
    title: "Fixture write",
  },
);
await assert.rejects(
  gws(["docs", "documents", "create", "--json", '{"title":"Denied"}']),
  (error) =>
    error.code === 1 && /Fixture write permission denied/.test(error.stdout + error.stderr),
);
const invalidArgv = await fetch(`${baseUrl}/exec/gws`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: [1] }),
});
assert.equal(invalidArgv.status, 400);

assert.deepEqual(
  JSON.parse(
    (
      await exec("drata", [
        "api",
        "POST",
        "/drata-fixture/resources",
        "--json",
        '{"name":"Fixture"}',
      ])
    ).stdout,
  ),
  {
    method: "POST",
    data: { name: "Fixture" },
  },
);
assert.equal((await exec("drata", ["api", "DELETE", "/drata-fixture/resources/1"])).stdout, "null");
await assert.rejects(
  exec("drata", ["api", "PATCH", "/drata-fixture/denied", "--json", "{}"]),
  (error) => error.code === 1 && /Drata fixture permission denied/.test(error.stdout),
);
await assert.rejects(
  gws(["drive", "files", "get", "--params", '{"fileId":"missing"}']),
  (error) => error.code === 1 && /Fixture file not found/.test(error.stdout + error.stderr),
);

const final = await state();
assert.equal(final.authorizationTokenRequests, 1, "one OAuth connection exchange must run");
assert.ok(final.tokenRequests > 0, "per-command OAuth refresh must run");
assert.ok(final.requests.some((request) => request.query.includeTabsContent === "true"));
assert.ok(final.requests.some((request) => request.query.q === "name contains 'report'"));
assert.equal(
  final.requests.filter((request) => request.path === "/v1/documents" && request.method === "POST")
    .length,
  2,
);
assert.equal(final.drataTokenRequests, 1);
assert.deepEqual(
  final.drataRequests.map((request) => request.method),
  ["POST", "DELETE", "PATCH"],
);
for (const path of [
  "/etc/thor/google-workspace",
  "/var/lib/remote-cli/gws",
  "/usr/local/lib/node_modules/@googleworkspace/cli",
]) {
  await assert.rejects(access(path), { code: "ENOENT" });
}
assert.equal(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, undefined);
assert.equal(process.env.DRATA_CLIENT_SECRET, undefined);
assert.match(
  await readFile("/home/thor/.config/opencode/skills/gws/SKILL.md", "utf8"),
  /includeTabsContent/,
);
console.log(
  "PASS: per-user GWS OAuth/approval, reads/writes, caller formatting/pagination, upstream denials, and private mounts",
);
