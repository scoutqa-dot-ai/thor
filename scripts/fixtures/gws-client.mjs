// Runs inside a disposable Pi/OpenCode agent image against the real wrapper + gws.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
assert.match(await gws(["schema", "docs.documents.create"]), /POST/);
await assert.rejects(
  exec("gws", ["auth", "--help"]),
  (error) => error.code === 1 && /auth commands are disabled/.test(error.stderr),
);
assert.equal((await state()).tokenRequests, 0, "public discovery must not refresh user OAuth");

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
assert.equal(pages.length, 12, "caller pagination must reach upstream without a Neo cap");
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

// The installed agent shim must produce actual agent-local bytes, not broker paths.
const downloadBinary = Buffer.from([0, 255, 128, 10]);
const nestedBinary = Buffer.from([0, 42, 255, 7, 9]);
const exportedText = "Fixture exported text\n";
const downloadRoots = [];
try {
  const singleOutput = await gws(["drive", "+download", "--file-id", "download-file"]);
  const single = JSON.parse(singleOutput);
  downloadRoots.push(dirname(single.path));
  assert.deepEqual(single, {
    path: single.path,
    files: 1,
    directories: 0,
    bytes: downloadBinary.length,
    skipped: 0,
  });
  assert.match(single.path, /^\/tmp\/neo-drive-[^/]+\/blob\.bin$/);
  assert.deepEqual(await readFile(single.path), downloadBinary);
  assert.equal((await stat(single.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(single.path))).mode & 0o777, 0o700);
  assert.ok(!singleOutput.includes(downloadBinary.toString("base64")));
  const folderOutput = await exec("gws", ["drive", "+download", "--file-id", "download-folder"]);
  const folder = JSON.parse(folderOutput.stdout);
  downloadRoots.push(dirname(folder.path));
  assert.deepEqual(folder, {
    path: folder.path,
    files: 3,
    directories: 3,
    bytes: downloadBinary.length + nestedBinary.length + Buffer.byteLength(exportedText),
    skipped: 1,
  });
  assert.match(folderOutput.stderr, /1 shortcut\(s\) skipped/);
  assert.deepEqual(await readFile(join(folder.path, "blob.bin")), downloadBinary);
  assert.deepEqual(await readFile(join(folder.path, "nested", "nested.bin")), nestedBinary);
  assert.equal(await readFile(join(folder.path, "Notes.txt"), "utf8"), exportedText);
  assert.deepEqual(await readdir(join(folder.path, "empty")), []);
  for (const directory of [folder.path, join(folder.path, "nested"), join(folder.path, "empty")])
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.ok(!folderOutput.stdout.includes("dataBase64"));
  assert.ok(!folderOutput.stdout.includes(exportedText));
  assert.ok(!folderOutput.stdout.includes("sha256"));
  const empty = JSON.parse(await gws(["drive", "+download", "--file-id", "download-empty"]));
  downloadRoots.push(dirname(empty.path));
  assert.deepEqual(empty, { path: empty.path, files: 0, directories: 1, bytes: 0, skipped: 0 });
  assert.deepEqual(await readdir(empty.path), []);
} finally {
  for (const root of downloadRoots) await rm(root, { recursive: true, force: true });
}

const final = await state();
assert.equal(final.authorizationTokenRequests, 1, "one OAuth connection exchange must run");
assert.ok(final.tokenRequests > 0, "per-command OAuth refresh must run");
assert.equal(
  final.executionDirectories.length,
  final.tokenRequests - final.downloadExecutions,
  "each CLI account command uses a distinct private cwd; direct downloads refresh without a child",
);
assert.equal((await fetch(`${baseUrl}/fixture-cleanup`)).status, 200);
assert.equal(final.downloadExecutions, 3, "one separate OAuth refresh per direct download");
assert.equal(
  final.downloadRequests.length,
  12,
  "file, paginated folder, exports and empty-folder transfers",
);
assert.ok(final.downloadRequests.some((request) => request.query.pageToken === "fixture-page-2"));
assert.ok(final.downloadRequests.some((request) => request.path.endsWith("/export")));
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
const skillPath = await access("/etc/thor/skills/gws/SKILL.md")
  .then(() => "/etc/thor/skills/gws/SKILL.md")
  .catch(() => "/home/thor/.config/opencode/skills/gws/SKILL.md");
assert.match(await readFile(skillPath, "utf8"), /includeTabsContent/);
assert.match(await readFile(skillPath, "utf8"), /gws drive \+download --file-id FILE_ID/);
console.log(
  `PASS: ${final.executionDirectories.length} isolated account commands, ${final.requests.length} CLI API requests, ${final.downloadExecutions} direct downloads (${final.downloadRequests.length} Drive requests), 2 writes (including denied write)`,
  "PASS: real gws shim, local binary/folder/empty-directory/export fidelity, shortcut warning, production CLI kernel isolation and cleanup, dummy OAuth reads/writes, formatting/pagination, upstream denials and private mounts",
);
