import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp, type GatewayAppConfig } from "./app.js";
import type { EventQueue } from "./queue.js";

function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

async function withServer<T>(
  fetchImpl: typeof fetch,
  run: (baseUrl: string, queue: EventQueue) => Promise<T>,
  extraConfig?: Partial<GatewayAppConfig>,
): Promise<T> {
  const queueDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const { app, queue } = createGatewayApp({
    signingSecret: "signing-secret",
    slackMcpUrl: "http://slack-mcp.test",
    slackBotUserId: "U0BOTEXAMPLE",
    runnerUrl: "http://runner.test",
    fetchImpl,
    queueDir,
    disableQueueInterval: true,
    interruptDelayMs: 0,
    unaddressedDelayMs: 0,
    ...extraConfig,
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
    const fetchImpl = vi.fn<typeof fetch>();

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

  it("accepts a signed app mention and fires a trigger to the runner (fire-and-forget)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1st call: POST /reaction to slack-mcp
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      // 2nd call: POST /trigger to runner
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

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

      // Reaction via slack-mcp
      const reactionCall = fetchImpl.mock.calls.find(
        (c) => c[0] === "http://slack-mcp.test/reaction",
      );
      expect(reactionCall).toBeDefined();
      const reactionBody = JSON.parse(String(reactionCall![1]?.body));
      expect(reactionBody).toEqual({
        channel: "C123",
        timestamp: "1710000000.001",
        reaction: "eyes",
      });

      // Runner trigger via fetchImpl
      const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
      expect(triggerCall).toBeDefined();
      const triggerBody = JSON.parse(String(triggerCall![1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      const promptJson = triggerBody.prompt.split("\n\n").slice(1).join("\n\n");
      const promptPayload = JSON.parse(promptJson);
      expect(promptPayload.type).toBe("app_mention");
      expect(promptPayload.channel).toBe("C123");
      expect(promptPayload.text).toContain("investigate checkout errors");
    });
  });

  it("enqueues thread replies without interrupt flag (never interrupts running session)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200 (fire-and-forget)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

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

      await queue.flush();

      // No session lookup — just trigger
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      const promptJson = triggerBody.prompt.split("\n\n").slice(1).join("\n\n");
      const promptPayload = JSON.parse(promptJson);
      expect(promptPayload.type).toBe("message");
      expect(promptPayload.text).toBe("can you also check staging?");
    });
  });

  it("enqueues thread replies with long delay (no session lookup)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

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

      await queue.flush();

      // No session lookup — just trigger
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
    });
  });

  it("enqueues new channel messages (not in a thread) with long delay", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvNew",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "anyone know why staging is down?",
          ts: "1710000000.010",
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

      // Wait for async enqueue
      for (let attempt = 0; attempt < 20 && fetchImpl.mock.calls.length < 1; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await queue.flush();

      // No session lookup (not a thread reply), trigger fired
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.prompt).toContain("anyone know why staging is down?");
    });
  });

  it("ignores messages sent by our own bot user", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvSelf",
        team_id: "T123",
        event: {
          type: "message",
          user: "U0BOTEXAMPLE",
          text: "I am the bot",
          ts: "1710000000.020",
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
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores app_mention from our own bot user", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvSelfMention",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U0BOTEXAMPLE",
          text: "<@U0BOTEXAMPLE> hello myself",
          ts: "1710000000.030",
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
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("handles other bot messages like normal messages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvBot",
        team_id: "T123",
        event: {
          type: "message",
          user: "U999",
          text: "deploy completed",
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
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      // No session lookup — just trigger
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.prompt).toContain("deploy completed");
      expect(triggerBody.prompt).toContain("B123");
    });
  });

  it("batches 3 rapid app_mention events into a single runner trigger with combined prompt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // Reaction calls to slack-mcp (3x)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

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

      // 3 reaction calls to slack-mcp
      const reactionCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://slack-mcp.test/reaction",
      );
      expect(reactionCalls).toHaveLength(3);

      // 1 runner trigger via fetchImpl — combined prompt with Slack context
      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls).toHaveLength(1);
      const triggerBody = JSON.parse(String(triggerCalls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      const promptJson = triggerBody.prompt.split("\n\n").slice(1).join("\n\n");
      const promptPayloads = JSON.parse(promptJson);
      expect(promptPayloads).toHaveLength(3);
      expect(promptPayloads[0].text).toContain("message 1");
      expect(promptPayloads[2].text).toContain("message 3");
    });
  });

  it("processes two messages sent at different times as separate triggers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

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

      // Send message 1 and flush
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
      await queue.flush();

      // Send message 2 and flush
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
      await queue.flush();

      // Both messages should have triggered the runner
      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls).toHaveLength(2);

      expect(JSON.parse(String(triggerCalls[0][1]?.body))).toMatchObject({
        prompt: expect.stringContaining("message 1"),
      });
      expect(JSON.parse(String(triggerCalls[1][1]?.body))).toMatchObject({
        prompt: expect.stringContaining("message 2"),
      });
    });
  });

  it("ignores message events that duplicate an app_mention (contains bot mention)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDup",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "<@U0BOTEXAMPLE> check staging",
          ts: "1710000000.040",
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
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores events from channels not in the allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvBlocked",
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U999> hello",
            ts: "1710000000.050",
            channel: "C_NOT_ALLOWED",
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
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      { allowedChannelIds: ["C_ALLOWED"] },
    );
  });

  it("accepts events from channels in the allowlist", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(
      fetchImpl,
      async (baseUrl, queue) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvAllowed",
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U999> hello",
            ts: "1710000000.060",
            channel: "C_ALLOWED",
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

        const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
        expect(triggerCall).toBeDefined();
      },
      { allowedChannelIds: ["C_ALLOWED"] },
    );
  });

  it("ignores messages from channels not in the allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvMsgBlocked",
          team_id: "T123",
          event: {
            type: "message",
            user: "U123",
            text: "hello from blocked channel",
            ts: "1710000000.070",
            channel: "C_BLOCKED",
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
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      { allowedChannelIds: ["C_ALLOWED"] },
    );
  });

  it("ignores direct messages (DM channels starting with D)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDM",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "hey bot",
          ts: "1710000000.080",
          channel: "D0ABC123",
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
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores app_mention in DM channels", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDMMention",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@U999> help me",
          ts: "1710000000.090",
          channel: "D0XYZ789",
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
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
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
