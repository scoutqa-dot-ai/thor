// Runs inside the disposable OpenCode image against the real wrapper + gws.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseUrl = process.env.THOR_REMOTE_CLI_URL;
const state = async () => (await fetch(`${baseUrl}/fixture-state`)).json();
async function gws(args) {
  return (await exec("gws", args)).stdout;
}

assert.match(await gws(["--version"]), /0\.22\.5/);
assert.match(await gws(["--help"]), /gws/);
assert.match(await gws(["docs", "documents", "get", "--help"]), /params/);
assert.match(await gws(["schema", "docs.documents.get"]), /documentId/);
assert.equal((await state()).tokenRequests, 0, "discovery must not authenticate");

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

const pages = (await gws(["drive", "files", "list", "--page-all"]))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(pages.length, 10, "server must bound otherwise endless pagination");
assert.equal(pages.at(-1).nextPageToken, "10");
assert.equal(
  (await gws(["drive", "files", "list", "--page-all", "--page-limit=2"])).trim().split("\n").length,
  2,
);

const beforeDenials = await state();
for (const args of [
  ["docs", "documents", "create"],
  ["sheets", "+append", "--help"],
  ["drive", "files", "export"],
  ["drive", "files", "get", "--params", '{"fileId":"id","alt":"media"}'],
  ["drive", "files", "list", "--params", "@/var/lib/remote-cli/gws/fixture-credentials.json"],
  ["auth", "export", "--unmasked"],
]) {
  await assert.rejects(
    exec("gws", args),
    (error) => error.code === 1 && /gws policy:/.test(error.stderr),
  );
}
assert.deepEqual(
  await state(),
  beforeDenials,
  "denied commands must not reach auth or Google APIs",
);
await assert.rejects(
  exec("gws", ["drive", "files", "get", "--params", '{"fileId":"missing"}']),
  (error) => error.code === 1 && /Fixture file not found/.test(error.stdout + error.stderr),
);

const final = await state();
assert.ok(final.tokenRequests > 0, "real service-account token exchange must run");
assert.ok(final.requests.some((request) => request.query.includeTabsContent === "true"));
assert.ok(final.requests.some((request) => request.query.q === "name contains 'report'"));
assert.ok(
  final.requests.every(
    (request) => request.method === "GET" || request.path.endsWith(":getByDataFilter"),
  ),
);
for (const path of [
  "/etc/thor/google-workspace",
  "/var/lib/remote-cli/gws",
  "/usr/local/lib/node_modules/@googleworkspace/cli",
]) {
  await assert.rejects(access(path), { code: "ENOENT" });
}
assert.equal(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, undefined);
assert.match(
  await readFile("/home/thor/.config/opencode/skills/gws/SKILL.md", "utf8"),
  /includeTabsContent/,
);
console.log(
  "PASS: pinned gws + OpenCode wrapper, Drive/Docs/Sheets, pagination, denials, errors, and credential isolation",
);
