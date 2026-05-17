import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = new URL("./slack-upload", import.meta.url).pathname;
const tempRoot = mkdtempSync(path.join(tmpdir(), "slack-upload-wrapper-test-"));
const fakeCurl = path.join(tempRoot, "curl");
const uploadFile = path.join(tempRoot, "report.txt");

writeFileSync(uploadFile, "hello from slack-upload test\n");
writeFileSync(
  fakeCurl,
  `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const url = args.find((arg) => arg.startsWith("https://")) || "";

if (url === "https://slack.com/api/files.getUploadURLExternal") {
  process.stdout.write(JSON.stringify({ ok: true, upload_url: "https://upload.test/file", file_id: "F123" }));
  process.exit(0);
}

if (url === "https://upload.test/file") {
  const outIndex = args.indexOf("-o");
  const formatIndex = args.indexOf("-w");
  if (outIndex !== -1) fs.writeFileSync(args[outIndex + 1], "uploaded");
  process.stdout.write(formatIndex !== -1 ? "200" : "");
  process.exit(0);
}

if (url === "https://slack.com/api/files.completeUploadExternal") {
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}

process.stderr.write("unexpected curl invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
);
chmodSync(fakeCurl, 0o755);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("slack-upload wrapper", () => {
  it("prints a minimal success response after a successful upload flow", async () => {
    const result = await execFileAsync("sh", [wrapper, uploadFile, "--channel", "C123"], {
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.stdout).toBe('{"ok":true}\n');
    expect(result.stderr).toBe("");
  });
});
