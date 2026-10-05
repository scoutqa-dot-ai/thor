import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GOOGLE_DRIVE_DOWNLOAD_MAX_WIRE_BYTES, type GoogleDriveDownload } from "@thor/common";

const wrapper = fileURLToPath(new URL("./remote-cli.ts", import.meta.url));
const loader = fileURLToPath(
  new URL("../../remote-cli/node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const downloadArgs = ["drive", "+download", "--file-id", "fixture-id"];
const binary = Buffer.from([0, 255, 128, 10, 13, 0, 42]);
const secretMarker = "PRIVATE_DOWNLOAD_CONTENT_DO_NOT_RENDER";
function file(path: string[], data = binary) {
  return {
    kind: "file" as const,
    path,
    mimeType: "application/octet-stream",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    dataBase64: data.toString("base64"),
  };
}
function manifest(): GoogleDriveDownload {
  return { version: 1, rootName: "report.bin", entries: [file(["report.bin"])], skipped: [] };
}
function response(driveDownload: unknown = manifest()) {
  return { stdout: secretMarker, stderr: secretMarker, exitCode: 0, driveDownload };
}

let server: Server;
let baseUrl: string;
let temp: string;
let reply: unknown;
let status: number;
let contentType: string;
let raw: string | Buffer | undefined;
let received: Array<{ headers: Record<string, unknown>; body: unknown; url: string | undefined }>;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "neo-drive-wrapper-test-"));
  reply = response();
  status = 200;
  contentType = "application/json";
  raw = undefined;
  received = [];
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body: JSON.parse(body), url: req.url });
    res.writeHead(status, { "content-type": contentType });
    res.end(raw ?? JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Wrapper fixture address missing");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
});
async function run(args = downloadArgs, endpoint = "gws", temporaryDirectory = temp) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, wrapper, endpoint, ...args], {
      cwd: temp,
      env: {
        TMPDIR: temporaryDirectory,
        TSX_DISABLE_CACHE: "1",
        HOME: temp,
        THOR_REMOTE_CLI_URL: baseUrl,
        THOR_OPENCODE_DIRECTORY: temp,
        THOR_OPENCODE_SESSION_ID: "fixture-session",
        THOR_OPENCODE_CALL_ID: "fixture-call",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("downloads binary bytes to a private local file and returns only a usable summary", async () => {
  const result = await run();
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toEqual({
    path: expect.any(String),
    files: 1,
    directories: 0,
    bytes: binary.length,
    skipped: 0,
  });
  expect(dirname(summary.path)).toMatch(new RegExp(`^${temp}/neo-drive-[^/]+$`));
  expect(await readFile(summary.path)).toEqual(binary);
  expect((await stat(summary.path)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(summary.path))).mode & 0o777).toBe(0o700);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(binary.toString("base64"));
  expect(result.stdout).not.toContain(file(["x"]).sha256);
  expect(result.stdout).not.toContain(secretMarker);
  expect(received).toEqual([
    {
      url: "/exec/gws",
      headers: expect.objectContaining({
        "x-thor-session-id": "fixture-session",
        "x-thor-call-id": "fixture-call",
      }),
      body: { args: downloadArgs, cwd: temp, directory: temp },
    },
  ]);
  const again = JSON.parse((await run()).stdout);
  expect(again.path).not.toBe(summary.path);
  expect(await readFile(summary.path)).toEqual(binary);
});

it.each([0, 1, 2, 3, 255, 256, 257])(
  "preserves all byte values and base64 padding at length %s",
  async (length) => {
    const data = Buffer.from(Array.from({ length }, (_, index) => index % 256));
    reply = response({
      version: 1,
      rootName: "bytes.bin",
      entries: [file(["bytes.bin"], data)],
      skipped: [],
    });
    const result = await run();
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(await readFile(summary.path)).toEqual(data);
    expect(summary.bytes).toBe(length);
  },
);

it("returns a usable empty root folder", async () => {
  reply = response({
    version: 1,
    rootName: "Empty",
    entries: [{ kind: "directory", path: ["Empty"] }],
    skipped: [],
  });
  const result = await run();
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toEqual({
    path: expect.any(String),
    files: 0,
    directories: 1,
    bytes: 0,
    skipped: 0,
  });
  expect(await readdir(summary.path)).toEqual([]);
});

it("materializes unsorted recursive folders including empty directories and reports skipped shortcuts", async () => {
  const tree = {
    version: 1,
    rootName: "Tree",
    entries: [
      file(["Tree", "sub", "binary"]),
      { kind: "directory", path: ["Tree", "sub", "empty"] },
      { kind: "directory", path: ["Tree", "sub"] },
      { kind: "directory", path: ["Tree"] },
      file(["Tree", "notes.txt"], Buffer.from("Exported document\n")),
    ],
    skipped: [{ fileId: "shortcut-id", name: "Shortcut", reason: "shortcut" }],
  };
  reply = response(tree);
  const result = await run();
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toEqual({
    path: expect.any(String),
    files: 2,
    directories: 3,
    bytes: binary.length + 18,
    skipped: 1,
  });
  expect(await readFile(join(summary.path, "sub", "binary"))).toEqual(binary);
  expect(await readFile(join(summary.path, "notes.txt"), "utf8")).toBe("Exported document\n");
  expect(await readdir(join(summary.path, "sub", "empty"))).toEqual([]);
  for (const path of [
    summary.path,
    join(summary.path, "sub"),
    join(summary.path, "sub", "empty"),
  ]) {
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  }
  expect(result.stderr).toMatch(/1 shortcut\(s\) skipped/);
  expect(result.stdout + result.stderr).not.toContain("dataBase64");
});

it("validates every digest before any filesystem creation, even when the temp location is unavailable", async () => {
  reply = response({
    version: 1,
    rootName: "Root",
    skipped: [],
    entries: [
      { kind: "directory", path: ["Root"] },
      file(["Root", "good"]),
      { ...file(["Root", "bad"]), sha256: "0".repeat(64) },
    ],
  });
  const result = await run(downloadArgs, "gws", join(temp, "nonexistent"));
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/integrity check failed/);
  expect(await readdir(temp)).toEqual([]);
});

it.each([
  { ...manifest(), rootName: "..", entries: [file([".."])] },
  { ...manifest(), entries: [file(["report.bin", "..", "outside"])] },
  { ...manifest(), entries: [file(["/outside"])] },
  {
    version: 1,
    rootName: "Root",
    skipped: [],
    entries: [
      { kind: "directory", path: ["Root"] },
      file(["Root", "Name"]),
      file(["Root", "name"]),
    ],
  },
  { version: 1, rootName: "Root", skipped: [], entries: [file(["Root"]), file(["Root", "child"])] },
  { ...manifest(), entries: [{ ...file(["report.bin"]), size: 999 }] },
  { ...manifest(), entries: [{ ...file(["report.bin"]), dataBase64: secretMarker }] },
])(
  "rejects unsafe or inconsistent manifests without rendering payloads or leaving files",
  async (invalid) => {
    reply = response(invalid);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Drive download response rejected; no local files were created.\n");
    expect(await readdir(temp)).toEqual([]);
  },
);

it("removes an entire half-created tree when the real filesystem rejects an overlong local path", async () => {
  const entries: GoogleDriveDownload["entries"] = [{ kind: "directory", path: ["Root"] }];
  const path = ["Root"];
  for (let depth = 0; depth < 30; depth++) {
    path.push("d".repeat(180));
    entries.push({ kind: "directory", path: [...path] });
  }
  entries.push(file([...path, "file.bin"]));
  reply = response({ version: 1, rootName: "Root", entries, skipped: [] });
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/local write failed; temporary files were removed/);
  expect(await readdir(temp)).toEqual([]);
});

it("rolls back already-written files when a later exclusive write fails on the real filesystem", async () => {
  const entries: GoogleDriveDownload["entries"] = [{ kind: "directory", path: ["Root"] }];
  const path = ["Root"];
  // Each directory fits Linux PATH_MAX; the final filename deliberately exceeds it.
  const depth = Math.floor((4095 - temp.length - "/neo-drive-xxxxxx/Root".length) / 181);
  for (let index = 0; index < depth; index++) {
    path.push("d".repeat(180));
    entries.push({ kind: "directory", path: [...path] });
  }
  entries.push(file(["Root", "written-first.bin"]), file([...path, "f".repeat(180)]));
  reply = response({ version: 1, rootName: "Root", entries, skipped: [] });
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/local write failed; temporary files were removed/);
  expect(await readdir(temp)).toEqual([]);
});

it("fails clearly with an old broker missing the artifact, without forwarding its stdout", async () => {
  reply = { stdout: secretMarker, stderr: "", exitCode: 0 };
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/artifact missing; rebuild/);
});

it.each([200, 500])("rejects artifacts on failed execution (HTTP %s)", async (httpStatus) => {
  status = httpStatus;
  reply = { ...response(), exitCode: 1 };
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(secretMarker);
  expect(await readdir(temp)).toEqual([]);
});

it("does not expose raw JSON parser errors or NDJSON payloads on a download", async () => {
  raw = `{INVALID:${secretMarker}`;
  contentType = "application/x-ndjson";
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Drive download response failed; no local files were created.\n");
});

it("bounds the download wire body before parsing and reports only a safe failure", async () => {
  raw = Buffer.alloc(GOOGLE_DRIVE_DOWNLOAD_MAX_WIRE_BYTES + 1, 0x78);
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Drive download response failed; no local files were created.\n");
  expect(await readdir(temp)).toEqual([]);
}, 30_000);

it.each([{ extra: [] }, { extra: ["--output", "out"] }, { extra: ["--format", "json"] }])(
  "accepts only the exact download command without caller paths (%j)",
  async ({ extra }) => {
    const args = extra.length
      ? [...downloadArgs, ...extra]
      : ["drive", "+download", "--file-id", "root"];
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/requires exactly/);
    expect(received).toEqual([]);
  },
);

it("preserves download authorization waits and ordinary discovery/API/error output", async () => {
  status = 428;
  reply = {
    stdout: "",
    stderr: "Google Workspace connection required; private link sent.\n",
    exitCode: 1,
    authWait: { type: "google_auth_wait", id: "wait-id", expiresAtMs: 1234 },
  };
  expect(await run()).toEqual({
    code: 1,
    stdout: "",
    stderr: "Google Workspace connection required; private link sent.\n",
  });
  status = 200;
  reply = { stdout: "gws help\n", stderr: "", exitCode: 0 };
  expect(await run(["--help"])).toEqual({ code: 0, stdout: "gws help\n", stderr: "" });
  reply = { stdout: '{"files":[]}\n', stderr: "warning\n", exitCode: 0 };
  expect(await run(["drive", "files", "list"])).toEqual({
    code: 0,
    stdout: '{"files":[]}\n',
    stderr: "warning\n",
  });
  status = 403;
  reply = { stdout: "denied\n", stderr: "provider denied\n", exitCode: 7 };
  expect(await run(["drive", "files", "list"])).toEqual({
    code: 7,
    stdout: "denied\n",
    stderr: "provider denied\n",
  });
  status = 200;
  contentType = "application/x-ndjson";
  raw = '{"type":"stdout","data":"streamed"}\n{"type":"exit","exitCode":0}\n';
  expect(await run([], "scoutqa")).toEqual({ code: 0, stdout: "streamed", stderr: "" });
});
