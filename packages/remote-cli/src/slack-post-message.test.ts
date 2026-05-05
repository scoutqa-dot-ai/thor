import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAlias, resolveSessionForCorrelationKey } from "@thor/common";
import { createRemoteCliApp } from "./index.js";
import type { SlackPostMessageDeps } from "./slack-post-message.js";

describe("remote-cli slack-post-message endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let appendAliasMock: ReturnType<typeof vi.fn>;
  let aliasErrorMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    appendAliasMock = vi.fn(() => ({ ok: true }));
    aliasErrorMock = vi.fn();

    const remoteCli = createRemoteCliApp({
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
  });

  it("posts mrkdwn stdin and registers a new-thread alias", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: "C123", ts: "1777940309.867569" }));

    const response = await postSlack(
      { args: ["--channel", "C123"], stdin: "hello *world*\n" },
      { "x-thor-session-id": "session-1" },
    );
    const body = (await response.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stdout: '{"ok":true,"channel":"C123","ts":"1777940309.867569"}\n',
      stderr: "",
      exitCode: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
        body: JSON.stringify({ channel: "C123", text: "hello *world*\n", mrkdwn: true }),
      }),
    );
    expect(appendAliasMock).toHaveBeenCalledWith("session-1", "slack:thread:1777940309.867569");
  });

  it("registers reply aliases against the requested thread timestamp", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: "C123", ts: "1777940310.111111" }));

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

  it("fails missing session id before calling Slack", async () => {
    const response = await postSlack({ args: ["--channel", "C123"], stdin: "hello" });
    const body = (await response.json()) as { stderr: string };

    expect(response.status).toBe(400);
    expect(body.stderr).toContain("missing x-thor-session-id");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appendAliasMock).not.toHaveBeenCalled();
  });

  it("rejects invalid args, empty stdin, missing token, and blocks before Slack", async () => {
    await expectFailure({ args: [], stdin: "hi" }, "--channel is required");
    await expectFailure({ args: ["--channel"], stdin: "hi" }, "--channel requires a value");
    await expectFailure(
      { args: ["--channel", "C123", "--thread-ts", "not-a-ts"], stdin: "hi" },
      "--thread-ts must be a Slack timestamp",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--thread-ts"], stdin: "hi" },
      "--thread-ts requires a value",
    );
    await expectFailure(
      { args: ["--channel", "C123", "--thread-ts="], stdin: "hi" },
      "--thread-ts requires a value",
    );
    await expectFailure({ args: ["--channel", "C123"], stdin: "   \n" }, "must not be empty");
    await expectFailure(
      { args: ["--channel", "C123", "--format", "blocks"], stdin: "[]" },
      "blocks is not yet supported",
    );

    const remoteCli = createRemoteCliApp({
      slackPostMessage: { env: {} as NodeJS.ProcessEnv, fetch: fetchMock as unknown as typeof fetch },
    });
    const noTokenServer = createServer(remoteCli.app);
    noTokenServer.listen(0, "127.0.0.1");
    await once(noTokenServer, "listening");
    const noTokenUrl = `http://127.0.0.1:${(noTokenServer.address() as AddressInfo).port}`;
    const noTokenResponse = await fetch(`${noTokenUrl}/exec/slack-post-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-thor-session-id": "session-3" },
      body: JSON.stringify({ args: ["--channel", "C123"], stdin: "hi" }),
    });
    expect(((await noTokenResponse.json()) as { stderr: string }).stderr).toContain(
      "SLACK_BOT_TOKEN is not set",
    );
    await new Promise<void>((resolve, reject) =>
      noTokenServer.close((err) => (err ? reject(err) : resolve())),
    );
    await remoteCli.close();

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
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: "C123", ts: "1777940309.867569" }));
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
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: "C123", ts: "1777940310.111111" }));
    const remoteCli = createRemoteCliApp({
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
        body: JSON.stringify({ args: ["--channel", "C123"], stdin: "new controlled thread" }),
      });
      expect(topLevel.status).toBe(200);
      expect(resolveSessionForCorrelationKey("slack:thread:1777940309.867569")).toBe(
        "non-slack-session",
      );

      const reply = await fetch(`${integrationUrl}/exec/slack-post-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-thor-session-id": "non-slack-session" },
        body: JSON.stringify({
          args: ["--channel", "C123", "--thread-ts", "1777940309.867569"],
          stdin: "controlled reply",
        }),
      });
      expect(reply.status).toBe(200);
      expect(resolveSessionForCorrelationKey("slack:thread:1777940309.867569")).toBe(
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

  async function expectFailure(body: Record<string, unknown>, message: string): Promise<void> {
    const response = await postSlack(body, { "x-thor-session-id": "session-validation" });
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
      body: JSON.stringify(body),
    });
  }

  function jsonResponse(body: unknown): Response {
    return { json: async () => body } as Response;
  }
});
