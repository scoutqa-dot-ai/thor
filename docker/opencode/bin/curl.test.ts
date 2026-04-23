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

  it("special-cases chat.postMessage and emits alias from request thread_ts", () => {
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
        "--data-urlencode",
        "text=hello",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
          THOR_OPENCODE_SESSION_ID: "sess-123",
          THOR_OPENCODE_CALL_ID: "call-456",
          MOCK_CURL_CAPTURE_PATH: capturePath,
          MOCK_CURL_STDOUT: '{"ok":true,"channel":"C123","ts":"1710000000.001"}',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true,"channel":"C123","ts":"1710000000.001"}');
    expect(result.stderr).toContain(
      '[thor:meta] {"type":"alias","alias":"slack:thread:1710000000.000","context":"Replied in thread in C123"}',
    );

    const curlArgs = readFileSync(capturePath, "utf8");
    expect(curlArgs).toContain("https://slack.com/api/chat.postMessage");
    expect(curlArgs).toContain("x-opencode-directory: /workspace/worktrees/thor/refactor/slack-mcp");
    expect(curlArgs).toContain("x-opencode-session-id: sess-123");
    expect(curlArgs).toContain("x-opencode-call-id: call-456");
  });

  it("uses response ts when request does not include thread_ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);
    const mockCurlPath = createMockCurl(dir);

    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/curl"),
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "--data-urlencode",
        "channel=C999",
        "--data-urlencode",
        "text=hello",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
          MOCK_CURL_STDOUT: '{"ok":true,"channel":"C999","message":{"thread_ts":"1710099999.456"}}',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      '[thor:meta] {"type":"alias","alias":"slack:thread:1710099999.456","context":"New thread posted to C999"}',
    );
  });

  it("does not fail when response metadata parsing fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);
    const mockCurlPath = createMockCurl(dir);

    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/curl"),
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "--data-urlencode",
        "channel=C123",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
          MOCK_CURL_STDOUT: "not-json-response",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("not-json-response");
    expect(result.stderr).not.toContain("[thor:meta]");
  });

  it("forwards real curl exit code for special-cased call", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);
    const mockCurlPath = createMockCurl(dir);

    const result = spawnSync(
      "sh",
      [join(process.cwd(), "docker/opencode/bin/curl"), "-X", "POST", "https://slack.com/api/chat.postMessage"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          THOR_REAL_CURL_BIN: mockCurlPath,
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
          MOCK_CURL_STDOUT: '{"ok":true}',
          MOCK_CURL_EXIT: "28",
        },
      },
    );

    expect(result.status).toBe(28);
  });

  it("passes through non-postMessage requests untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-curl-wrapper-"));
    tempDirs.push(dir);

    const capturePath = join(dir, "curl-args.txt");
    const mockCurlPath = createMockCurl(dir);
    const result = spawnSync(
      "sh",
      [
        join(process.cwd(), "docker/opencode/bin/curl"),
        "-sS",
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
          THOR_OPENCODE_DIRECTORY: "/workspace/worktrees/thor/refactor/slack-mcp",
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
    expect(curlArgs).toContain("https://slack.com/api/conversations.replies");
    expect(curlArgs).not.toContain("x-opencode-directory:");
    expect(curlArgs).not.toContain("x-opencode-session-id:");
    expect(curlArgs).not.toContain("x-opencode-call-id:");
  });
});
