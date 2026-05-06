import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAlias, resolveSessionForCorrelationKey } from "@thor/common";

vi.mock("./policy.js", async () => {
  const actual = await vi.importActual<typeof import("./policy.js")>("./policy.js");
  return {
    ...actual,
    validateCwd: vi.fn(() => null),
  };
});

import { createRemoteCliApp } from "./index.js";
import type { SlackPostMessageDeps } from "./slack-post-message.js";

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
    appendAliasMock = vi.fn(() => ({ ok: true }));
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
      { args: ["--channel", "C999"], stdin: "hello *world*\n" },
      { "x-thor-session-id": "session-1" },
    );
    const body = (await response.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stdout: '{"ok":true,"channel":"C999","ts":"1777940309.867569"}\n',
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
    expect(appendAliasMock).toHaveBeenCalledWith("session-1", "slack:thread:1777940309.867569");
  });

  it("registers reply aliases against the requested thread timestamp", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1777940310.111111" }),
    );

    const response = await postSlack(
      {
        args: ["--channel", "C123", "--thread-ts", "1777940309.867569"],
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
          thread_ts: "1777940309.867569",
        }),
      }),
    );
    expect(appendAliasMock).toHaveBeenCalledWith("session-2", "slack:thread:1777940309.867569");
  });

  it("requires a live Thor session before calling Slack", async () => {
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "session-stale",
        anchorId: "00000000-0000-7000-8000-000000000107",
      }),
    ).toEqual({ ok: true });
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "session-current",
        anchorId: "00000000-0000-7000-8000-000000000107",
      }),
    ).toEqual({ ok: true });

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
      { args: ["--channel", "C123", "--thread-ts", "not-a-ts"], stdin: "hi" },
      "--thread-ts must be a Slack timestamp",
    );
    await expectFailure({ args: ["--channel", "C123"], stdin: "   \n" }, "must not be empty");

    expect(fetchMock).not.toHaveBeenCalled();
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
        args: ["--channel", "C123", "--blocks-file", blocksFile],
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
    appendAliasMock.mockReturnValue({ ok: false, error });

    const response = await postSlack(
      { args: ["--channel", "C123"], stdin: "hello" },
      { "x-thor-session-id": "session-5" },
    );
    const body = (await response.json()) as { exitCode: number };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(0);
    expect(aliasErrorMock).toHaveBeenCalledWith(error, {
      sessionId: "session-5",
      correlationKey: "slack:thread:1777940309.867569",
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
      expect(
        appendAlias({
          aliasType: "opencode.session",
          aliasValue: "non-slack-session",
          anchorId: "00000000-0000-7000-8000-000000000c01",
        }),
      ).toEqual({ ok: true });

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
      expect(resolveSessionForCorrelationKey("slack:thread:1777940309.867569")).toBe(
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
      expect(resolveSessionForCorrelationKey("slack:thread:1777940309.867569")).toBe(
        "non-slack-session",
      );

      expect(
        appendAlias({
          aliasType: "opencode.subsession",
          aliasValue: "child-non-slack-session",
          anchorId: "00000000-0000-7000-8000-000000000c01",
        }),
      ).toEqual({ ok: true });
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
      expect(resolveSessionForCorrelationKey("slack:thread:1777940311.222222")).toBe(
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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: sessionId,
        anchorId,
      }),
    ).toEqual({ ok: true });
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
