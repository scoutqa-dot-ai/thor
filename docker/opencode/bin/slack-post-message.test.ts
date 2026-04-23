import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("slack-post-message", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves JSON stdout, emits thor meta, and forwards proxy headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-slack-post-message-"));
    tempDirs.push(dir);

    const capturePath = join(dir, "curl-args.txt");
    const mockCurlPath = join(dir, "curl");
    writeFileSync(
      mockCurlPath,
      `#!/bin/sh
output_file=""
status="200"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output_file="$1"
  elif [ "$1" = "-w" ]; then
    shift
  else
    printf '%s\n' "$1" >> "${capturePath}"
  fi
  shift
done
printf '{"ok":true,"ts":"1710000000.001","channel":"C123"}\n' > "$output_file"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/slack-post-message"),
        "--channel",
        "C123",
        "--thread-ts",
        "1710000000.000",
        "--text",
        "hello",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH || ""}`,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
          THOR_OPENCODE_SESSION_ID: "sess-123",
          THOR_OPENCODE_CALL_ID: "call-456",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true,"ts":"1710000000.001","channel":"C123"}\n');
    expect(result.stderr).toContain('[thor:meta] {"type":"alias","alias":"slack:thread:1710000000.000","context":"Replied in thread in C123"}');

    const curlArgs = readFileSync(capturePath, "utf8");
    expect(curlArgs).toContain("https://slack.com/api/chat.postMessage");
    expect(curlArgs).toContain("x-opencode-directory: /workspace/worktrees/thor/refactor/slack-mcp");
    expect(curlArgs).toContain("x-opencode-session-id: sess-123");
    expect(curlArgs).toContain("x-opencode-call-id: call-456");
    expect(curlArgs).toContain("thread_ts=1710000000.000");
    expect(curlArgs).toContain("text=hello");
  });

  it("fails before calling curl when opencode directory is missing", () => {
    const result = spawnSync(
      "sh",
      [join(process.cwd(), "docker/opencode/bin/slack-post-message"), "--channel", "C123", "--text", "hello"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("THOR_OPENCODE_DIRECTORY is required for Slack writes");
  });
});
