import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("curl wrapper", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createMockCurl(dir: string): string {
    const mockCurlPath = join(dir, "real-curl");
    writeFileSync(
      mockCurlPath,
      `#!/bin/sh
capture="\${MOCK_CURL_CAPTURE_PATH:-}"
if [ -n "$capture" ]; then
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$capture"
  done
fi
if [ -n "\${MOCK_CURL_STDERR:-}" ]; then
  printf '%s' "$MOCK_CURL_STDERR" >&2
fi
if [ -n "\${MOCK_CURL_STDOUT:-}" ]; then
  printf '%s' "$MOCK_CURL_STDOUT"
fi
exit "\${MOCK_CURL_EXIT:-0}"
`,
      { mode: 0o755 },
    );
    return mockCurlPath;
  }

  it("passes through arguments, output, and exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);

    const capturePath = join(dir, "curl-args.txt");
    const mockCurlPath = createMockCurl(dir);
    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/curl"),
        "-sS",
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "--data-urlencode",
        "channel=C123",
        "--data-urlencode",
        "thread_ts=1710000000.000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp-v2",
          THOR_OPENCODE_SESSION_ID: "sess-123",
          THOR_OPENCODE_CALL_ID: "call-456",
          MOCK_CURL_CAPTURE_PATH: capturePath,
          MOCK_CURL_STDOUT: '{"ok":true}',
          MOCK_CURL_STDERR: "real-curl-stderr",
          MOCK_CURL_EXIT: "7",
        },
      },
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toBe('{"ok":true}');
    expect(result.stderr).toContain("real-curl-stderr");
    expect(result.stderr).not.toContain("[thor:meta]");

    const curlArgs = readFileSync(capturePath, "utf8");
    expect(curlArgs).toContain("https://slack.com/api/chat.postMessage");
    expect(curlArgs).toContain("thread_ts=1710000000.000");
  });

  it("does not inject opencode headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);

    const capturePath = join(dir, "curl-args.txt");
    const mockCurlPath = createMockCurl(dir);
    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/curl"),
        "--get",
        "https://slack.com/api/conversations.replies",
        "--data-urlencode",
        "channel=C123",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp-v2",
          THOR_OPENCODE_SESSION_ID: "sess-123",
          THOR_OPENCODE_CALL_ID: "call-456",
          MOCK_CURL_CAPTURE_PATH: capturePath,
        },
      },
    );

    expect(result.status).toBe(0);
    const curlArgs = readFileSync(capturePath, "utf8");
    expect(curlArgs).not.toContain("x-opencode-directory:");
    expect(curlArgs).not.toContain("x-opencode-session-id:");
    expect(curlArgs).not.toContain("x-opencode-call-id:");
  });
});
