import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAlias, resolveSessionForCorrelationKey } from "@thor/common";

import { createRemoteCliApp } from "./index.ts";
import type { SlackPostMessageDeps } from "./slack-post-message.ts";

describe("remote-cli slack-post-message endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let appendAliasMock: ReturnType<typeof vi.fn>;
  let aliasErrorMock: ReturnType<typeof vi.fn>;
  let worklogRoot: string;
  let testCwd: string;

  beforeEach(async () => {
    fetchMock = vi.fn();
    appendAliasMock = vi.fn();
    aliasErrorMock = vi.fn();
    testCwd = mkdtempSync(join("/tmp", "remote-cli-slack-cwd-"));
    worklogRoot = mkdtempSync(join(tmpdir(), "remote-cli-slack-post-"));
    process.env.WORKLOG_DIR = worklogRoot;

    bindSession("session-1", "00000000-0000-7000-8000-000000000101");
    bindSession("session-2", "00000000-0000-7000-8000-000000000102");
    bindSession("session-4", "00000000-0000-7000-8000-000000000104");
    bindSession("session-5", "00000000-0000-7000-8000-000000000105");
    bindSession("session-validation", "00000000-0000-7000-8000-000000000106");

    const remoteCli = createRemoteCliApp({
      env: { slackBotToken: "xoxb-test" } as any,
      slackPostMessage: {
        env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
        fetch: fetchMock as unknown as typeof fetch,
        appendAlias: appendAliasMock as unknown as SlackPostMessageDeps["appendAlias"],
        logAliasError: aliasErrorMock as unknown as SlackPostMessageDeps["logAliasError"],
      },
    });
    closeRemoteCli = remoteCli.close;
    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeRemoteCli();
    rmSync(worklogRoot, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
    delete process.env.WORKLOG_DIR;
  });

  it("posts mrkdwn to any channel and registers a new-thread alias", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C999", ts: "1777940309.867569" }),
    );

    const response = await postSlack(
      { cwd: undefined, args: ["--channel", "C999"], stdin: "hello *world*\n" },
      { "x-thor-session-id": "session-1" },
    );
    const body = (await response.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stdout: '{"ok":true}\n',
      stderr: "",
      exitCode: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
        body: JSON.stringify({ channel: "C999", text: "hello *world*\n", mrkdwn: true }),
      }),
    );
    expect(appendAliasMock).toHaveBeenCalledWith(
      "session-1",
      "slack:thread:C999/1777940309.867569",
    );
  });

  it("registers reply aliases against the requested thread value", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940310.111111" }),
    );

    const response = await postSlack(
      {
        args: ["--channel", "C123", "--thread-ts", "thread-parent-token"],
        stdin: "reply",
      },
      { "x-thor-session-id": "session-2" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          text: "reply",
          mrkdwn: true,
          thread_ts: "thread-parent-token",
        }),
      }),
    );
    expect(appendAliasMock).toHaveBeenCalledWith(
      "session-2",
      "slack:thread:C123/thread-parent-token",
    );
  });

  it("requires a live Thor session before calling Slack", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "session-stale",
      anchorId: "00000000-0000-7000-8000-000000000107",
    });
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "session-current",
      anchorId: "00000000-0000-7000-8000-000000000107",
    });

    await expectFailure(
      { args: ["--channel", "C123"], stdin: "hello" },
      "invalid x-thor-session-id",
      { "x-thor-session-id": "session-stale" },
    );
    await expectFailure(
      { args: ["--channel", "C123"], stdin: "hello" },
      "invalid x-thor-session-id",
      { "x-thor-session-id": "session-fake" },
    );
    await expectFailure(
      { args: ["--channel", "C123"], stdin: "hello" },
      "missing x-thor-session-id",
      {},
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(appendAliasMock).not.toHaveBeenCalled();
  });

  it("rejects invalid message inputs before calling Slack", async () => {
    await expectFailure({ args: [], stdin: "hi" }, "--channel is required");
    await expectFailure(
      { args: ["--channel", "C123", "--thread-ts"], stdin: "hi" },
      "--thread-ts requires a value",
    );
    await expectFailure({ args: ["--channel", "C123"], stdin: "   \n" }, "must not be empty");
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "I found the **root cause** and the fix is ready.\n",
      },
      "must not include CommonMark double-star emphasis",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "I found the **root cause** and the fix is ready.\n",
      },
      "Use Slack mrkdwn instead: `*bold*` (not `**bold**`)",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "| Name | Status |\n|---|---|\n| Thor | Ready |\n",
      },
      "must not include markdown table separators",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "| Name | Status |\n|---|---|\n| Thor | Ready |\n",
      },
      "Use Slack mrkdwn instead: `*bold*` (not `**bold**`)",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "Name | Status\n--- | ---\nThor | Ready\n",
      },
      "must not include markdown table separators",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "| **Name** | Status |\n|---|---|\n| Thor | Ready |\n",
      },
      "use --blocks-file with Slack blocks/table output instead",
    );
    await expectFailure(
      {
        args: ["--channel", "C123"],
        stdin: "First line.\\nSecond line because the agent forgot the heredoc.\n",
      },
      "must not contain literal `\\n` escape sequences",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts real newlines and literal backslash-n inside code spans or fences", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940312.555555" }),
    );

    const paragraphBreak = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin: "First paragraph.\n\nSecond paragraph.\n",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(paragraphBreak.status).toBe(200);

    const literalInCodeSpan = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin: "Use the `\\n` escape only inside code, like this: `printf 'a\\nb'`.\n",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(literalInCodeSpan.status).toBe(200);

    const literalInFence = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin: "Example:\n```\nprintf 'a\\nb\\n'\n```\nPlain text after.\n",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(literalInFence.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("allows literal double stars and table-looking text inside code spans or fences", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940312.444444" }),
    );

    const inlineCode = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin: "Use `**literal**` in this example and keep `Name | Status` literal.\n",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(inlineCode.status).toBe(200);

    const fencedCode = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin:
          "```\n**literal**\nName | Status\n--- | ---\nThor | Ready\n```\nOutside text stays plain.\n",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(fencedCode.status).toBe(200);

    const balancedFenceLine = await postSlack(
      {
        args: ["--channel", "C123"],
        stdin: "```literal```\nOutside has **bad emphasis**\n",
      },
      { "x-thor-session-id": "session-validation" },
    );
    expect(balancedFenceLine.status).toBe(400);
    expect(((await balancedFenceLine.json()) as { stderr: string }).stderr).toContain(
      "must not include CommonMark double-star emphasis",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts blocks files only from allowed roots", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940312.333333" }),
    );
    const blocksFile = join(testCwd, "blocks.json");
    writeFileSync(
      blocksFile,
      JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "from tmp" } }]),
      "utf8",
    );

    const response = await postSlack(
      {
        args: ["--channel", "C123", "--blocks-file", "blocks.json"],
        stdin: "fallback text",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          text: "fallback text",
          mrkdwn: true,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "from tmp" } }],
        }),
      }),
    );

    fetchMock.mockClear();
    const escapedLink = join(testCwd, "escaped-blocks.json");
    symlinkSync("/etc/passwd", escapedLink);
    await expectFailure(
      { args: ["--channel", "C123", "--blocks-file", "/etc/passwd"], stdin: "hi" },
      "--blocks-file must be under /tmp or /workspace",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--blocks-file", "../../../etc/passwd"], stdin: "hi" },
      "--blocks-file must be under /tmp or /workspace",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--blocks-file", escapedLink], stdin: "hi" },
      "--blocks-file must be under /tmp or /workspace",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads --file attachments as File N into the thread before posting the message", async () => {
    writeFileSync(join(testCwd, "a.txt"), "alpha", "utf8");
    writeFileSync(join(testCwd, "b.txt"), "beta", "utf8");
    fetchMock.mockImplementation((async (url: string) => {
      if (url.endsWith("/files.getUploadURLExternal")) {
        return jsonResponse({
          ok: true,
          upload_url: "https://files.slack.test/upload/abc",
          file_id: "F1",
        });
      }
      if (url === "https://files.slack.test/upload/abc") return new Response("", { status: 200 });
      if (url.endsWith("/files.completeUploadExternal")) {
        return jsonResponse({ ok: true, files: [{ id: "F1", permalink: "https://slk/F1" }] });
      }
      if (url.endsWith("/chat.postMessage")) {
        return jsonResponse({ ok: true, channel: "C123", ts: "1777940309.867569" });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof fetch);

    const response = await postSlack(
      {
        args: [
          "--channel",
          "C123",
          "--thread-ts",
          "1777940300.000000",
          "--file",
          "a.txt",
          "--file",
          "b.txt",
        ],
        stdin: "here are the files",
      },
      { "x-thor-session-id": "session-1" },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      stdout: '{"ok":true}\n',
      stderr: "",
      exitCode: 0,
    });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // Both files fully upload (3 calls each) before the single postMessage.
    expect(urls[urls.length - 1]).toBe("https://slack.com/api/chat.postMessage");
    expect(urls.filter((u) => u.endsWith("/chat.postMessage"))).toHaveLength(1);

    // The two completeUploadExternal calls carry the sequential labels and the
    // requested thread; the raw uploads carry each file's exact bytes.
    const completes = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/files.completeUploadExternal"),
    );
    const labels = completes.map((c) =>
      new URLSearchParams(String((c[1] as RequestInit).body)).get("initial_comment"),
    );
    expect(labels).toEqual(["File 1", "File 2"]);
    for (const c of completes) {
      expect(new URLSearchParams(String((c[1] as RequestInit).body)).get("thread_ts")).toBe(
        "1777940300.000000",
      );
    }
    const rawBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]) === "https://files.slack.test/upload/abc")
      .map((c) => String((c[1] as RequestInit).body));
    expect(rawBodies).toEqual(["alpha", "beta"]);
  });

  it("rejects --file paths outside the allowed roots and never uploads or posts", async () => {
    writeFileSync(join(testCwd, "ok.txt"), "hi", "utf8");
    await expectFailure(
      { args: ["--channel", "C123", "--file", "/etc/passwd"], stdin: "hi" },
      "--file must be under /tmp or /workspace",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--file", "../../../etc/passwd"], stdin: "hi" },
      "--file must be under /tmp or /workspace",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--file", "missing.txt"], stdin: "hi" },
      "failed to read --file missing.txt: path does not exist",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the command and posts no message when an attachment upload fails", async () => {
    writeFileSync(join(testCwd, "a.txt"), "alpha", "utf8");
    fetchMock.mockImplementation((async (url: string) => {
      if (url.endsWith("/files.getUploadURLExternal")) {
        return jsonResponse({ ok: false, error: "missing_scope" });
      }
      throw new Error(`unexpected url after failed upload: ${url}`);
    }) as unknown as typeof fetch);

    const response = await postSlack(
      { args: ["--channel", "C123", "--file", "a.txt"], stdin: "here" },
      { "x-thor-session-id": "session-1" },
    );
    const body = (await response.json()) as { stderr: string };
    expect(response.status).toBe(400);
    expect(body.stderr).toContain(
      "failed to upload File 1 (a.txt): Slack API error: missing_scope",
    );
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      "https://slack.com/api/chat.postMessage",
    );
  });

  it("returns Slack ok:false without alias registration", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "channel_not_found" }));

    const response = await postSlack(
      { args: ["--channel", "C404"], stdin: "hello" },
      { "x-thor-session-id": "session-4" },
    );
    const body = (await response.json()) as { stderr: string };

    expect(response.status).toBe(400);
    expect(body.stderr).toContain("Slack API error: channel_not_found");
    expect(appendAliasMock).not.toHaveBeenCalled();
  });

  it("logs alias registration failure but preserves Slack success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940309.867569" }),
    );
    const error = new Error("alias store unavailable");
    appendAliasMock.mockImplementation(() => {
      throw error;
    });

    const response = await postSlack(
      { args: ["--channel", "C123"], stdin: "hello" },
      { "x-thor-session-id": "session-5" },
    );
    const body = (await response.json()) as { exitCode: number };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(0);
    expect(aliasErrorMock).toHaveBeenCalledWith(error, {
      sessionId: "session-5",
      correlationKey: "slack:thread:C123/1777940309.867569",
    });
  });

  it("registers aliases that Slack continuations resolve back to the originating session", async () => {
    const worklogRoot = mkdtempSync(join(tmpdir(), "remote-cli-slack-alias-test-"));
    const previousWorklogDir = process.env.WORKLOG_DIR;
    process.env.WORKLOG_DIR = worklogRoot;

    const integrationFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: "C123", ts: "1777940309.867569" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: "C123", ts: "1777940310.111111" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: "C123", ts: "1777940311.222222" }));
    const remoteCli = createRemoteCliApp({
      env: { slackBotToken: "xoxb-test" } as any,
      slackPostMessage: {
        env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
        fetch: integrationFetch,
      },
    });
    const integrationServer = createServer(remoteCli.app);

    try {
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "non-slack-session",
        anchorId: "00000000-0000-7000-8000-000000000c01",
      });

      integrationServer.listen(0, "127.0.0.1");
      await once(integrationServer, "listening");
      const integrationUrl = `http://127.0.0.1:${(integrationServer.address() as AddressInfo).port}`;

      const topLevel = await fetch(`${integrationUrl}/exec/slack-post-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-thor-session-id": "non-slack-session" },
        body: JSON.stringify({
          cwd: testCwd,
          args: ["--channel", "C123"],
          stdin: "new controlled thread",
        }),
      });
      expect(topLevel.status).toBe(200);
      expect(resolveSessionForCorrelationKey("slack:thread:C123/1777940309.867569")).toBe(
        "non-slack-session",
      );

      const reply = await fetch(`${integrationUrl}/exec/slack-post-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-thor-session-id": "non-slack-session" },
        body: JSON.stringify({
          cwd: testCwd,
          args: ["--channel", "C123", "--thread-ts", "1777940309.867569"],
          stdin: "controlled reply",
        }),
      });
      expect(reply.status).toBe(200);
      expect(resolveSessionForCorrelationKey("slack:thread:C123/1777940309.867569")).toBe(
        "non-slack-session",
      );

      appendAlias({
        aliasType: "opencode.subsession",
        aliasValue: "child-non-slack-session",
        anchorId: "00000000-0000-7000-8000-000000000c01",
      });
      const childPost = await fetch(`${integrationUrl}/exec/slack-post-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-thor-session-id": "child-non-slack-session",
        },
        body: JSON.stringify({
          cwd: testCwd,
          args: ["--channel", "C123"],
          stdin: "controlled child-session thread",
        }),
      });
      expect(childPost.status).toBe(200);
      expect(resolveSessionForCorrelationKey("slack:thread:C123/1777940311.222222")).toBe(
        "non-slack-session",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        integrationServer.close((err) => (err ? reject(err) : resolve())),
      );
      await remoteCli.close();
      if (previousWorklogDir === undefined) {
        delete process.env.WORKLOG_DIR;
      } else {
        process.env.WORKLOG_DIR = previousWorklogDir;
      }
      rmSync(worklogRoot, { recursive: true, force: true });
    }
  });

  function bindSession(sessionId: string, anchorId: string): void {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: sessionId,
      anchorId,
    });
  }

  async function expectFailure(
    body: Record<string, unknown>,
    message: string,
    headers: Record<string, string> = { "x-thor-session-id": "session-validation" },
  ): Promise<void> {
    const response = await postSlack(body, headers);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { stderr: string }).stderr).toContain(message);
  }

  async function postSlack(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/exec/slack-post-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ cwd: testCwd, ...body }),
    });
  }

  function jsonResponse(body: unknown): Response {
    return { json: async () => body } as Response;
  }
});
