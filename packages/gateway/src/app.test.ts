import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import type { EventQueue } from "./queue.js";

function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

async function withServer<T>(
  fetchImpl: typeof fetch,
  run: (baseUrl: string, queue: EventQueue) => Promise<T>,
): Promise<T> {
  const queueDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const { app, queue } = createGatewayApp({
    signingSecret: "signing-secret",
    slackBotToken: "xoxb-test",
    runnerUrl: "http://runner.test",
    fetchImpl,
    queueDir,
    disableQueueInterval: true,
    slackBatchDelayMs: 0,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine server address");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`, queue);
  } finally {
    queue.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(queueDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway", () => {
  it("returns a placeholder response for the configured redirect URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/slack/redirect?code=test-code&state=test-state`);

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: "Slack OAuth redirect is configured but not implemented yet.",
        code: "test-code",
        state: "test-state",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("responds to Slack URL verification", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({ type: "url_verification", challenge: "challenge-token" });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;
      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "challenge-token" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("acknowledges subscribed non-app_mention events without triggering runner calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvReaction",
        team_id: "T123",
        event: {
          type: "reaction_added",
          user: "U123",
          reaction: "eyes",
          item: {
            type: "message",
            channel: "C123",
            ts: "1710000000.001",
          },
          event_ts: "1710000000.010",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        eventType: "reaction_added",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("accepts a signed app mention, forwards it to runner, and posts a threaded reply", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1st: reactions.add (fire-and-forget ack)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // 2nd: runner trigger
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "session-123",
            correlationKey: "slack:thread:1710000000.001",
            resumed: false,
            response: "Investigation complete.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      // 3rd: Slack chat.postMessage
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "1710000000.002" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev123",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@U999> investigate checkout errors",
          ts: "1710000000.001",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Reaction added immediately
      expect(fetchImpl.mock.calls[0][0]).toBe("https://slack.com/api/reactions.add");
      expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
        channel: "C123",
        timestamp: "1710000000.001",
        name: "eyes",
      });

      // Runner trigger
      expect(fetchImpl.mock.calls[1][0]).toBe("http://runner.test/trigger");
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        prompt: "investigate checkout errors",
        correlationKey: "slack:thread:1710000000.001",
      });

      // Slack reply
      expect(fetchImpl.mock.calls[2][0]).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
        channel: "C123",
        thread_ts: "1710000000.001",
        text: "Investigation complete.",
      });
    });
  });

  it("forwards thread replies when runner has an existing session", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1st call: GET /sessions?correlationKey=... → 200 (session exists)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            correlationKey: "slack:thread:1710000000.001",
            sessionId: "session-123",
            createdAt: "2026-03-10T00:00:00.000Z",
            lastUsedAt: "2026-03-10T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // 2nd call: POST /trigger → runner response
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "session-123",
            correlationKey: "slack:thread:1710000000.001",
            resumed: true,
            response: "Checked staging too.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // 3rd call: Slack chat.postMessage
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "1710000000.003" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev456",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "can you also check staging?",
          ts: "1710000000.002",
          thread_ts: "1710000000.001",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      // Wait for async session check + enqueue, then flush
      for (let attempt = 0; attempt < 20 && fetchImpl.mock.calls.length < 1; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Session lookup
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "http://runner.test/sessions?correlationKey=slack%3Athread%3A1710000000.001",
      );

      // Trigger
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        prompt: "can you also check staging?",
        correlationKey: "slack:thread:1710000000.001",
      });

      // Slack reply
      expect(fetchImpl.mock.calls[2][0]).toBe("https://slack.com/api/chat.postMessage");
    });
  });

  it("ignores thread replies when no runner session exists", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // GET /sessions?correlationKey=... → 404 (no session)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "No session for this correlation key" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev789",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "random thread reply",
          ts: "1710000000.005",
          thread_ts: "1710000000.004",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      // Wait for async session check
      for (let attempt = 0; attempt < 20 && fetchImpl.mock.calls.length < 1; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await queue.flush();

      // Only the session lookup call — no trigger, no Slack reply
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "http://runner.test/sessions?correlationKey=slack%3Athread%3A1710000000.004",
      );
    });
  });

  it("ignores thread messages from bots", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev101",
        team_id: "T123",
        event: {
          type: "message",
          user: "U999",
          text: "bot reply",
          ts: "1710000000.003",
          thread_ts: "1710000000.001",
          channel: "C123",
          bot_id: "B123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true, eventType: "message" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("batches 3 rapid app_mention events into a single runner trigger with combined prompt", async () => {
    const slackOk = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const fetchImpl = vi
      .fn<typeof fetch>()
      // 3x reactions.add (one per mention)
      .mockResolvedValueOnce(slackOk())
      .mockResolvedValueOnce(slackOk())
      .mockResolvedValueOnce(slackOk())
      // Single runner trigger (combined prompt)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "session-123",
            correlationKey: "slack:thread:1710000000.001",
            resumed: false,
            response: "Handled all messages.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Single Slack reply
      .mockResolvedValueOnce(slackOk());

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      // Fire 3 mentions in quick succession (same thread)
      for (const [i, text] of ["message 1", "message 2", "message 3"].entries()) {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: `Ev${i + 1}`,
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: `<@U999> ${text}`,
            ts: "1710000000.001",
            channel: "C123",
          },
        });

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });
        expect(response.status).toBe(200);
      }

      await queue.flush();

      // 3 reactions + 1 runner trigger + 1 Slack reply = 5
      expect(fetchImpl).toHaveBeenCalledTimes(5);

      // First 3 calls are reactions
      for (let i = 0; i < 3; i++) {
        expect(fetchImpl.mock.calls[i][0]).toBe("https://slack.com/api/reactions.add");
      }

      // Runner was called with all 3 prompts combined
      expect(fetchImpl.mock.calls[3][0]).toBe("http://runner.test/trigger");
      expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({
        prompt: "message 1\nmessage 2\nmessage 3",
        correlationKey: "slack:thread:1710000000.001",
      });

      // Single Slack reply
      expect(fetchImpl.mock.calls[4][0]).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(fetchImpl.mock.calls[4][1]?.body))).toMatchObject({
        channel: "C123",
        thread_ts: "1710000000.001",
      });
    });
  });

  it("processes a second message after the first finishes — both trigger runner separately", async () => {
    let resolveFirstTrigger: ((value: Response) => void) | null = null;

    let triggerCount = 0;

    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "http://runner.test/trigger") {
        triggerCount++;
        if (triggerCount === 1) {
          // First trigger — block until we're ready
          return new Promise<Response>((resolve) => {
            resolveFirstTrigger = resolve;
          });
        }
        // Second trigger
        return new Response(
          JSON.stringify({
            sessionId: "session-123",
            correlationKey: "slack:thread:1710000000.001",
            resumed: true,
            response: "Handled message 2.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Slack reactions.add / chat.postMessage
      return new Response(JSON.stringify({ ok: true, ts: "1710000000.099" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      function makeBody(eventId: string, text: string) {
        return JSON.stringify({
          type: "event_callback",
          event_id: eventId,
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: `<@U999> ${text}`,
            ts: "1710000000.001",
            channel: "C123",
          },
        });
      }

      // Send message 1
      const body1 = makeBody("Ev1", "message 1");
      await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body1, "signing-secret", timestamp),
        },
        body: body1,
      });

      // Start processing — runner trigger is now in-flight (blocked)
      const flushPromise = queue.flush();
      await new Promise((r) => setTimeout(r, 50));

      // Send message 2 while message 1 is still processing
      const body2 = makeBody("Ev2", "message 2");
      await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body2, "signing-secret", timestamp),
        },
        body: body2,
      });

      // Unblock the first trigger
      resolveFirstTrigger!(
        new Response(
          JSON.stringify({
            sessionId: "session-123",
            correlationKey: "slack:thread:1710000000.001",
            resumed: false,
            response: "Handled message 1.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await flushPromise;

      // Both messages should have triggered the runner
      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls).toHaveLength(2);

      expect(JSON.parse(String(triggerCalls[0][1]?.body))).toMatchObject({
        prompt: "message 1",
      });
      expect(JSON.parse(String(triggerCalls[1][1]?.body))).toMatchObject({
        prompt: "message 2",
      });

      // Both should have posted Slack replies
      const slackCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "https://slack.com/api/chat.postMessage",
      );
      expect(slackCalls).toHaveLength(2);
    });
  });

  it("accepts signed Slack interactivity payloads on the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const payload = encodeURIComponent(
        JSON.stringify({
          type: "block_actions",
          user: { id: "U123" },
          actions: [{ action_id: "approve" }],
        }),
      );
      const body = `payload=${payload}`;
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/interactivity`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        interactionType: "block_actions",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
