import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SlackThreadEvent } from "./slack.js";
import { createSlackClient } from "./slack-api.js";
import { extractSlackModelRouting, selectSlackRequestSource } from "./slack-model-routing.js";
import { executeBatchDispatchPlan, planBatchDispatch } from "./service.js";
import { persistBatchRunnerRequest } from "./batch-request.js";

function event(user: string, text: string, ts = "2"): SlackThreadEvent {
  return { type: "app_mention", channel: "C123", thread_ts: "1", ts, user, text };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  return `http://127.0.0.1:${address.port}`;
}

describe("trusted current Slack model routing", () => {
  it("selects the current human source timestamp independently of thread roots, history and bystanders", async () => {
    const current = {
      ...event("U_CURRENT", "current request", "1710000000.002"),
      thread_ts: "1710000000.001",
      history: [{ user: "U_CURRENT", ts: "1710000000.999", text: "not current" }],
    };
    const events = [
      event("U_CURRENT", "older", "1710000000.001"),
      current,
      event("U_OTHER", "bystander", "1710000000.003"),
      { ...event("U_CURRENT", "bot", "1710000000.004"), bot_id: "B123" },
      { ...event("U_CURRENT", "bot subtype", "1710000000.005"), subtype: "bot_message" },
    ];
    expect(selectSlackRequestSource(events, "U_CURRENT")).toBe(current);
    expect(selectSlackRequestSource(events, undefined)).toBeUndefined();
    const plan = await planBatchDispatch({
      slackEvents: events,
      cronEvents: [],
      githubEvents: [],
      approvalOutcomes: [],
      correlationKey: "slack:thread:C123/1710000000.001",
      triggerSlackId: "U_CURRENT",
      deps: { runnerUrl: "http://runner.invalid" },
      slackDirectoryForChannel: () => ({ directory: "/workspace/repos/fixture" }),
    });
    expect(plan).toMatchObject({ kind: "dispatch", options: { messageTs: "1710000000.002" } });
  });
  it("selects only the newest event for the trusted actor, ignores thread fields, bystanders and older directives", () => {
    const current = {
      ...event("U1", "<@UBOT> [profile:fast thinking:low] List Jira issues\nwith status"),
      history: [{ user: "U1", text: "[profile:strong] security" }],
    };
    const result = extractSlackModelRouting({
      triggerSlackId: "U1",
      events: [
        event("U1", "[profile:strong] old architecture", "1"),
        current,
        event("U2", "[profile:strong] bystander", "3"),
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        modelProfile: "fast",
        thinkingLevel: "low",
        routingTask: "List Jira issues\nwith status",
      },
    });
    expect(
      extractSlackModelRouting({
        triggerSlackId: "U1",
        events: [current, event("U1", "hello [profile:strong] is quoted", "4")],
      }),
    ).toEqual({ ok: true, value: { routingTask: "hello [profile:strong] is quoted" } });
    expect(extractSlackModelRouting({ events: [current] })).toEqual({ ok: true, value: {} });
    expect(extractSlackModelRouting({ triggerSlackId: "U3", events: [current] })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("preserves body newlines and indentation instead of routing on stripped/normalized code", () => {
    expect(
      extractSlackModelRouting({
        triggerSlackId: "U1",
        events: [event("U1", "<@UBOT> [thinking:high]\n  original body\n    indented code")],
      }),
    ).toEqual({
      ok: true,
      value: { thinkingLevel: "high", routingTask: "\n  original body\n    indented code" },
    });
  });

  it.each([
    "[profile:unknown] task",
    "[profile:strong model:configured-id] task",
    "[profile:fast profile:strong] task",
    "[thinking:high thinking:low] task",
    "[thinking:max] task",
    "[profile strong] task",
    "[model:] task",
    "[profile:strong] [thinking:high] task",
    "[profile:strong unknown:field] task",
    "[profile:strong task",
    "[PROFILE:strong] task",
    "[profiles:strong] task",
  ])(
    "visibly rejects malformed/conflicting directives without runner delivery: %s",
    async (text) => {
      const received: { path: string | undefined; body: URLSearchParams }[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push({
          path: req.url,
          body: new URLSearchParams(Buffer.concat(chunks).toString()),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, channel: "C123", ts: "notice" }));
      });
      const baseUrl = await listen(server);
      try {
        const plan = await planBatchDispatch({
          slackEvents: [event("U1", `<@UBOT> ${text}`)],
          cronEvents: [],
          githubEvents: [],
          approvalOutcomes: [],
          correlationKey: "slack:C123:1",
          triggerSlackId: "U1",
          deps: { runnerUrl: baseUrl },
          slackDirectoryForChannel: () => ({ directory: "/workspace/repos/fixture" }),
          slackDeps: { client: createSlackClient("dummy-slack-token", `${baseUrl}/`) },
        });
        expect(plan).toMatchObject({
          kind: "drop",
          reason: expect.stringContaining("Neo model directive invalid"),
        });
        expect(received).toHaveLength(1);
        expect(received[0].path).toBe("/chat.postMessage");
        expect(received[0].body.get("channel")).toBe("C123");
        expect(received[0].body.get("thread_ts")).toBe("1");
        expect(received[0].body.get("text")).toContain("profile and model cannot be combined");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each([
    ["[profile:strong thinking:high]", { modelProfile: "strong", thinkingLevel: "high" }],
    ["[model:configured-id thinking:low]", { modelId: "configured-id", thinkingLevel: "low" }],
    ["[thinking:high]", { thinkingLevel: "high" }],
  ])(
    "roundtrips %s from current Slack event through frozen real HTTP",
    async (directive, overrides) => {
      const directory = await mkdtemp(join(tmpdir(), "neo-model-routing-"));
      const received: Record<string, unknown>[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ accepted: true }));
      });
      const runnerUrl = await listen(server);
      let accepted = 0;
      try {
        const current = event("U1", `<@UBOT> ${directive} Implement exactly\n  this body`);
        const plan = await planBatchDispatch({
          requestId: "model-roundtrip",
          slackEvents: [
            event("U1", "[profile:fast] history", "1"),
            current,
            event("U2", "[profile:fast] other actor", "3"),
          ],
          cronEvents: [],
          githubEvents: [],
          approvalOutcomes: [],
          correlationKey: "slack:C123:1",
          triggerSlackId: "U1",
          deps: { runnerUrl },
          slackDirectoryForChannel: () => ({ directory: "/workspace/repos/fixture" }),
        });
        if (plan.kind !== "dispatch") throw new Error("Expected dispatch");
        const options = persistBatchRunnerRequest(directory, {
          ...plan.options,
          requestId: "model-roundtrip",
        });
        await executeBatchDispatchPlan({ ...plan, options });
        const retry = persistBatchRunnerRequest(directory, {
          requestId: "model-roundtrip",
          prompt: "different rendered history",
          correlationKey: "changed",
          directory: "/workspace/repos/changed",
          deps: { runnerUrl },
          modelProfile: "fast",
          thinkingLevel: "minimal",
          routingTask: "different current request",
          triggerSlackId: "U2",
          onAccepted: () => accepted++,
        });
        await executeBatchDispatchPlan({ ...plan, options: retry });
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(received[0]);
        expect(received[0]).toMatchObject({
          ...overrides,
          routingTask: "Implement exactly\n  this body",
          triggerSlackId: "U1",
          requestId: "model-roundtrip",
        });
        expect(received[0].prompt).toContain(JSON.stringify(current.text));
        expect(accepted).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
