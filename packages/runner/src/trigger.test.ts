import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TextPart } from "@opencode-ai/sdk";
import {
  createRunnerApp,
  resetModelContextLimitCacheForTests,
  type RunnerAppOptions,
} from "./index.ts";
import {
  appendAlias,
  appendCorrelationAliasForAnchor,
  appendSessionEvent,
  mintAnchor,
  resolveAnchorForCorrelationKey,
  sessionLogPath,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import type { WorkspaceConfig } from "@thor/common";

const worklogDir = "/tmp/thor-runner-trigger-test/worklog";
const originalEnv = vi.hoisted(() => {
  const sessionErrorGraceMs = process.env.SESSION_ERROR_GRACE_MS;
  process.env.WORKLOG_DIR = "/tmp/thor-runner-trigger-test/worklog";
  process.env.SESSION_ERROR_GRACE_MS = "20";
  return { sessionErrorGraceMs };
});
const sessionDir = "/workspace/repos/runner-trigger-test";
const memoryDir = "/tmp/thor-runner-trigger-test/memory";

class FakeSubscription implements AsyncIterable<Event> {
  private queue: Event[] = [];
  private waiters: Array<(value: IteratorResult<Event>) => void> = [];
  private closed = false;

  addSessionId(): void {}

  push(event: Event): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Event>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeEventBuses {
  subscriptions: FakeSubscription[] = [];

  async subscribe(): Promise<FakeSubscription> {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }

  latest(): FakeSubscription {
    const sub = this.subscriptions.at(-1);
    if (!sub) throw new Error("no subscription");
    return sub;
  }
}

function textEvent(sessionId: string, text: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        text,
      } as TextPart,
    },
  } as Event;
}

function messageUpdatedEvent(
  sessionId: string,
  opts: { providerID: string; modelID: string; tokens: unknown; role?: string } = {
    providerID: "openai",
    modelID: "gpt-5.5",
    tokens: { input: 100_000, output: 20_000, reasoning: 6_000 },
    role: "assistant",
  },
): Event {
  return {
    type: "message.updated",
    properties: {
      info: {
        sessionID: sessionId,
        role: opts.role ?? "assistant",
        providerID: opts.providerID,
        modelID: opts.modelID,
        tokens: opts.tokens,
      },
    },
  } as unknown as Event;
}

function idleEvent(sessionId: string): Event {
  return { type: "session.idle", properties: { sessionID: sessionId } } as Event;
}

function taskRunningEvent(sessionId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        callID: "call-task",
        tool: "task",
        state: { status: "running", input: { subagent_type: "general" } },
      },
    },
  } as unknown as Event;
}

function taskRunningWithoutInputEvent(sessionId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        callID: "call-task-no-input",
        tool: "task",
        state: { status: "running" },
      },
    },
  } as unknown as Event;
}

function toolEvent(
  sessionId: string,
  tool: string,
  status: string,
  input: Record<string, unknown>,
  time: { start: number; end: number } = { start: 1000, end: 2500 },
  output?: string,
): Event {
  const state = { status, input, time, ...(output !== undefined ? { output } : {}) };
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        callID: `call-${tool}`,
        tool,
        state,
      },
    },
  } as unknown as Event;
}

function stepFinishEvent(sessionId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        reason: "stop",
        cost: 0.0123,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
    },
  } as unknown as Event;
}

function stepFinishPartRecord(
  sessionId: string,
  opts: { cost?: number; tokens?: unknown } = {},
): Record<string, unknown> {
  return {
    type: "opencode_event",
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: sessionId,
          messageID: `m-${sessionId}`,
          reason: "stop",
          ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
          tokens: opts.tokens ?? {
            input: 1000,
            output: 2000,
            reasoning: 300,
            cache: { read: 400 },
          },
        },
      },
    },
  };
}

function statusEvent(sessionId: string): Event {
  return { type: "session.status", properties: { sessionID: sessionId, status: "busy" } } as Event;
}

function sessionErrorEvent(sessionId: string, message: string): Event {
  return {
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: { name: "ProviderError", data: { message } },
    },
  } as Event;
}

function createHarness(
  opts: {
    existingSessions?: Set<string>;
    busySessions?: Set<string>;
    children?: Array<{ id: string }>;
    onGet?: (sessionId: string) => Promise<void>;
    onProviderList?: () => void;
    promptEvents?: (sessionId: string, sub: FakeSubscription) => Event[] | void;
    throwInSubscribe?: boolean;
    workspaceConfig?: WorkspaceConfig;
    providerList?: unknown;
    opencodeUrl?: string;
  } = {},
) {
  const buses = new FakeEventBuses();
  const existingSessions = opts.existingSessions ?? new Set<string>();
  const busySessions = opts.busySessions ?? new Set<string>();
  const prompts: string[] = [];
  const aborts: string[] = [];
  const progressEvents: unknown[] = [];
  const abortedPending = new Set<string>();
  let counter = 0;

  const client = {
    session: {
      create: async () => {
        const id = `session-${++counter}`;
        existingSessions.add(id);
        return { data: { id } };
      },
      get: async ({ path }: { path: { id: string } }) => {
        await opts.onGet?.(path.id);
        if (!existingSessions.has(path.id)) throw new Error("missing");
        return { data: { id: path.id } };
      },
      status: async () => ({
        data: Object.fromEntries([...busySessions].map((id) => [id, { type: "busy" }])),
      }),
      abort: async ({ path }: { path: { id: string } }) => {
        aborts.push(path.id);
        busySessions.delete(path.id);
        abortedPending.add(path.id);
        return { data: {} };
      },
      promptAsync: async ({
        path,
        body,
      }: {
        path: { id: string };
        body: { parts: Array<{ text: string }> };
      }) => {
        prompts.push(body.parts[0]?.text ?? "");
        const sub = buses.latest();
        queueMicrotask(() => {
          const events = opts.promptEvents
            ? opts.promptEvents(path.id, sub)
            : [textEvent(path.id, `ok ${path.id}`), idleEvent(path.id)];
          if (!events) return;
          for (const event of events) sub.push(event);
        });
        return { data: {} };
      },
      children: async () => ({ data: opts.children ?? [] }),
    },
    provider: {
      list: async () => {
        opts.onProviderList?.();
        return { data: opts.providerList ?? { all: [], default: {}, connected: [] } };
      },
    },
  };

  const app = createRunnerApp({
    opencodeUrl: opts.opencodeUrl ?? `http://opencode.test/${Math.random().toString(16).slice(2)}`,
    eventBuses: opts.throwInSubscribe
      ? ({
          subscribe: async () => {
            throw new Error("subscribe failed");
          },
        } as unknown as RunnerAppOptions["eventBuses"])
      : ({
          subscribe: async () => {
            const sub = await buses.subscribe();
            for (const id of abortedPending) {
              queueMicrotask(() => sub.push(idleEvent(id)));
              abortedPending.delete(id);
            }
            return sub;
          },
        } as unknown as RunnerAppOptions["eventBuses"]),
    memoryDir,
    createClient: () =>
      client as unknown as ReturnType<NonNullable<RunnerAppOptions["createClient"]>>,
    ensureOpencodeAvailable: async () => {},
    isOpencodeReachable: async () => true,
    workspaceConfigLoader: opts.workspaceConfig ? () => opts.workspaceConfig! : () => ({}),
    progressEventSink: (event) => progressEvents.push(event),
  });

  latestProgressEvents = progressEvents;
  return { app, prompts, aborts, existingSessions, busySessions, progressEvents };
}

let latestProgressEvents: unknown[] = [];

async function withServer<T>(
  app: ReturnType<typeof createRunnerApp>,
  fn: (url: string) => Promise<T>,
) {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function trigger(url: string, body: Record<string, unknown>) {
  const progressOffset = latestProgressEvents.length;
  const response = await fetch(`${url}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: sessionDir, ...body }),
  });
  const text = await response.text();
  const json = text.trim() ? JSON.parse(text) : undefined;
  let events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (events.length === 1 && events[0]?.accepted === true) {
    const deadline = Date.now() + 100;
    do {
      events = latestProgressEvents.slice(progressOffset);
      if (events.some((event) => (event as { type?: string }).type === "done")) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    } while (Date.now() < deadline);
  }
  return { response, json, events };
}

beforeEach(() => {
  process.env.WORKLOG_DIR = worklogDir;
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
  resetModelContextLimitCacheForTests();
});

afterEach(() => {
  if (originalEnv.sessionErrorGraceMs === undefined) delete process.env.SESSION_ERROR_GRACE_MS;
  else process.env.SESSION_ERROR_GRACE_MS = originalEnv.sessionErrorGraceMs;
  vi.unstubAllEnvs();
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
});

function bindSessionToAnchor(sessionId: string, anchorId: string): void {
  appendAlias({ aliasType: "opencode.session", aliasValue: sessionId, anchorId });
}

function jsonLineWithSplitUtf8Text(buildRecord: (text: string) => Record<string, unknown>): {
  line: string;
  markerText: string;
} {
  const marker = "\u{1f680}";
  const markerText = `${marker} split ok`;
  const baseLine = JSON.stringify(buildRecord(markerText));
  const markerIndex = baseLine.indexOf(marker);
  if (markerIndex === -1) throw new Error("marker missing from JSON fixture");
  const bytesBeforeMarker = Buffer.byteLength(baseLine.slice(0, markerIndex), "utf8");
  const fillerLength = 64 * 1024 - 1 - bytesBeforeMarker;
  if (fillerLength <= 0) throw new Error("JSON fixture prefix is too large");

  const line = JSON.stringify(buildRecord(`${"a".repeat(fillerLength)}${markerText}`));
  const finalMarkerIndex = line.indexOf(marker);
  expect(Buffer.byteLength(line.slice(0, finalMarkerIndex), "utf8")).toBe(64 * 1024 - 1);
  return { line, markerText };
}

function readAliases(): Array<{ aliasType: string; aliasValue: string; anchorId: string }> {
  try {
    return readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Mint a busy-session fixture: anchor + opencode.session + slack.thread alias. */
function setupBusySession(slackThreadTs: string): string {
  const anchorId = mintAnchor();
  bindSessionToAnchor("busy-session", anchorId);
  appendAlias({
    aliasType: "slack.thread",
    aliasValue: `C123/${slackThreadTs}`,
    anchorId,
  });
  return anchorId;
}

describe("runner /trigger orchestration", () => {
  it("serves the trigger viewer with 404 and rendered status", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000301";
    const anchorId = mintAnchor();
    bindSessionToAnchor("viewer-session", anchorId);
    appendSessionEvent("viewer-session", { type: "trigger_start", triggerId });
    appendSessionEvent("viewer-session", { type: "trigger_end", triggerId, status: "completed" });

    await withServer(h.app, async (url) => {
      const missing = await fetch(
        `${url}/runner/v/${anchorId}/00000000-0000-7000-8000-000000000399`,
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Trigger not found");

      // Malformed (non-UUIDv7) anchor id is rejected without disk I/O.
      const invalidAnchor = await fetch(`${url}/runner/v/not-a-uuid/${triggerId}`);
      expect(invalidAnchor.status).toBe(404);
      expect(await invalidAnchor.text()).toContain("Trigger not found");

      const unknownAnchor = await fetch(`${url}/runner/v/00000000-0000-7000-8000-000000000398`);
      expect(unknownAnchor.status).toBe(404);
      expect(await unknownAnchor.text()).toContain("Anchor not found");

      const ok = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`);
      const html = await ok.text();
      expect(ok.status).toBe(200);
      expect(html).toContain("completed");
      expect(html).toContain("direct trigger");
      // No /raw escape hatch — the single-endpoint contract.
      expect(html).not.toContain("/raw");
    });
  });

  it("renders single-agent cost from persisted step-finish cost", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000514";
    const anchorId = mintAnchor();
    bindSessionToAnchor("cost-session", anchorId);
    appendSessionEvent("cost-session", { type: "trigger_start", triggerId });
    appendSessionEvent("cost-session", stepFinishPartRecord("cost-session", { cost: 0.0123 }));
    appendSessionEvent("cost-session", { type: "trigger_end", triggerId, status: "completed" });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Cost: $0.012");
      expect(html).toContain("Tokens:");
      expect(html).not.toContain("Est cost");
      expect(html).not.toContain("~$");
      expect(html).not.toContain("Model: gpt-5.4");
    });
  });

  it("does not estimate cost when step-finish has tokens but no persisted cost", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000515";
    const anchorId = mintAnchor();
    bindSessionToAnchor("missing-cost-session", anchorId);
    appendSessionEvent("missing-cost-session", { type: "trigger_start", triggerId });
    appendSessionEvent("missing-cost-session", stepFinishPartRecord("missing-cost-session"));
    appendSessionEvent("missing-cost-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Tokens:");
      expect(html).not.toContain("Cost:");
      expect(html).not.toContain("Est cost");
      expect(html).not.toContain("~$");
    });
  });

  it("renders subagent totals using persisted step-finish costs", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000516";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-cost-session", anchorId);
    const subSessionId = "ses_subagent_cost_test_001";
    const taskStart = 1_700_000_000_000;
    const taskEnd = taskStart + 10_000;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    writeFileSync(
      `${worklogDir}/sessions/${subSessionId}.jsonl`,
      `${JSON.stringify({
        schemaVersion: 1,
        ts: new Date(taskStart + 100).toISOString(),
        ...stepFinishPartRecord(subSessionId, { cost: 0.0456 }),
      })}\n`,
    );

    appendSessionEvent("parent-cost-session", { type: "trigger_start", triggerId });
    appendSessionEvent(
      "parent-cost-session",
      stepFinishPartRecord("parent-cost-session", { cost: 0.0123 }),
    );
    appendSessionEvent("parent-cost-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              metadata: { sessionId: subSessionId, model: { modelID: "expensive-model" } },
              time: { start: taskStart, end: taskEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-cost-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("$0.012");
      expect(html).toContain("$0.046");
      expect(html).toContain("$0.058");
      expect(html).not.toContain("expensive-model");
      expect(html).not.toContain("~$");
    });
  });

  it("inlines the subagent session activity inside the task card", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000508";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-session", anchorId);
    const subSessionId = "ses_subagent_inline_test_001";
    const taskStart = 1_700_000_000_000;
    const taskEnd = taskStart + 10_000;
    // Pre-seed the subagent's own session file with three events inside the
    // task's time window plus one stale event outside it (a later resume).
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    writeFileSync(
      `${worklogDir}/sessions/${subSessionId}.jsonl`,
      [
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 100).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                tool: "read",
                state: { status: "completed", input: { filePath: "/x" } },
              },
            },
          },
        }),
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 200).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.future.delta",
            properties: {
              sessionID: subSessionId,
              metadata: { _omitted: true, bytes: 4096 },
            },
          },
        }),
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 300).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: { type: "text", text: "Subagent finished the read." },
            },
          },
        }),
        // Event after taskEnd — belongs to a later resume of the same subagent
        // session, must NOT bleed into this task card.
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskEnd + 5_000).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: { type: "text", text: "STALE FOLLOW-UP — should not render" },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    appendSessionEvent("parent-session", { type: "trigger_start", triggerId });
    appendSessionEvent("parent-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              output: `task_id: ${subSessionId}\nAll done.`,
              metadata: { sessionId: subSessionId },
              time: { start: taskStart, end: taskEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("subagent activity (3 rows)");
      expect(html).toContain('class="events sub-events"');
      expect(html).toContain("Subagent finished the read.");
      expect(html).toContain("tool</b> <span>read</span>");
      expect(html).toContain("message.future.delta");
      // Stale follow-up after taskEnd is filtered out.
      expect(html).not.toContain("STALE FOLLOW-UP");
    });
  });

  it("preserves UTF-8 text split across subagent JSONL read chunks", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000512";
    const anchorId = mintAnchor();
    bindSessionToAnchor("utf8-parent-session", anchorId);
    const subSessionId = "ses_subagent_utf8_split_test_001";
    const taskStart = 1_700_000_000_000;
    const taskEnd = taskStart + 10_000;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });

    const { line, markerText } = jsonLineWithSplitUtf8Text((text) => ({
      schemaVersion: 1,
      ts: new Date(taskStart + 100).toISOString(),
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "prt_utf8_split", type: "text", text },
        },
      },
    }));
    writeFileSync(`${worklogDir}/sessions/${subSessionId}.jsonl`, `${line}\n`);

    appendSessionEvent("utf8-parent-session", { type: "trigger_start", triggerId });
    appendSessionEvent("utf8-parent-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              output: `task_id: ${subSessionId}\nAll done.`,
              metadata: { sessionId: subSessionId },
              time: { start: taskStart, end: taskEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("utf8-parent-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(markerText);
      expect(html).not.toContain("\ufffd split ok");
    });
  });

  it("renders omitted-marker tool inputs as a muted note instead of raw JSON", async () => {
    // When capRecord projects an oversized opencode_event, the tool part's
    // `state.input` becomes `{ _omitted: true, bytes: N }`. The viewer must
    // recognize that shape and render a "(input omitted, N KB)" badge —
    // otherwise the page would dump the marker JSON literally where the
    // tool input HTML normally goes.
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000511";
    const anchorId = mintAnchor();
    bindSessionToAnchor("omitted-session", anchorId);
    appendSessionEvent("omitted-session", { type: "trigger_start", triggerId });
    appendSessionEvent("omitted-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_omitted_read",
            type: "tool",
            tool: "read",
            callID: "call_om",
            state: {
              status: "completed",
              title: "Reads /etc/passwd",
              input: { _omitted: true, bytes: 38_912 },
            },
          },
        },
      },
    });
    appendSessionEvent("omitted-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("tool</b> <span>read</span>");
      expect(html).toContain('class="omitted"');
      expect(html).toMatch(/\(input omitted, 38\.0 KB\)/);
      // The marker JSON itself must not leak into the page.
      expect(html).not.toContain("_omitted");
    });
  });

  it("preserves apply_patch context-line breaks in the rendered diff", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000513";
    const anchorId = mintAnchor();
    bindSessionToAnchor("patch-session", anchorId);
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      " const keepOne = 1;",
      " const keepTwo = 2;",
      "-const oldValue = keepOne + keepTwo;",
      "+const newValue = keepOne + keepTwo;",
      "*** End Patch",
    ].join("\n");
    appendSessionEvent("patch-session", { type: "trigger_start", triggerId });
    appendSessionEvent("patch-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_patch",
            type: "tool",
            tool: "apply_patch",
            callID: "call_patch",
            state: {
              status: "completed",
              title: "Updates src/example.ts",
              input: { patchText },
            },
          },
        },
      },
    });
    appendSessionEvent("patch-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("apply_patch");
      expect(html).toContain('<span class="diff-del">-const oldValue = keepOne + keepTwo;</span>');
      expect(html).toContain('<span class="diff-add">+const newValue = keepOne + keepTwo;</span>');
      expect(html).toContain("<span> const keepOne = 1;</span>\n<span> const keepTwo = 2;</span>");
      expect(html).not.toContain(
        "<span> const keepOne = 1;</span><span> const keepTwo = 2;</span>",
      );
    });
  });

  it("renders unknown opencode events through the fallback row", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000512";
    const anchorId = mintAnchor();
    bindSessionToAnchor("unknown-event-session", anchorId);
    appendSessionEvent("unknown-event-session", { type: "trigger_start", triggerId });
    appendSessionEvent("unknown-event-session", {
      type: "opencode_event",
      event: {
        type: "message.future.delta",
        properties: {
          sessionID: "unknown-event-session",
          part: {
            type: "future-part",
            tool: "future-tool",
            state: {
              status: "completed",
              output: { _omitted: true, bytes: 8192 },
            },
          },
        },
      },
    });
    appendSessionEvent("unknown-event-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("unknown event");
      expect(html).toContain("message.future.delta");
      expect(html).toContain('class="row unknown" data-status="completed"');
      expect(html).not.toContain("No meaningful events recorded");
    });
  });

  it("breaks subagent recursion on cycles without infinite expansion", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000510";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-cycle", anchorId);
    const subSelf = "ses_subagent_cycle";
    const parentStart = 1_700_000_000_000;
    const parentEnd = parentStart + 10_000;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    // subSelf has a task tool that points to itself — must not infinite-loop.
    writeFileSync(
      `${worklogDir}/sessions/${subSelf}.jsonl`,
      `${JSON.stringify({
        schemaVersion: 1,
        ts: new Date(parentStart + 100).toISOString(),
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { subagent_type: "thinker", prompt: "self" },
                metadata: { sessionId: subSelf },
                time: { start: parentStart + 100, end: parentStart + 200 },
              },
            },
          },
        },
      })}\n`,
    );
    appendSessionEvent("parent-cycle", { type: "trigger_start", triggerId });
    appendSessionEvent("parent-cycle", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              metadata: { sessionId: subSelf },
              time: { start: parentStart, end: parentEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-cycle", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      const subMatches = html.match(/class="events sub-events"/g) ?? [];
      // Only one expansion — the second self-reference is blocked by the
      // visited set, so the nested task card has no sub-activity block.
      expect(subMatches.length).toBe(1);
    });
  });

  it("creates a correlation-key session, records JSONL events, and resumes the same session", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:C123/1710000000.001";

    await withServer(h.app, async (url) => {
      const first = await trigger(url, {
        prompt: "first",
        correlationKey,
        triggerSlackId: "UABCDEF1",
      });
      const firstStart = first.events.find((e) => e.type === "start");
      const firstDone = first.events.find((e) => e.type === "done");
      expect(firstStart).toMatchObject({ sessionId: "session-1", resumed: false });
      expect(firstDone).toMatchObject({
        sessionId: "session-1",
        resumed: false,
        status: "completed",
      });
      const logText = readFileSync(`${worklogDir}/sessions/session-1.jsonl`, "utf8");
      expect(logText).toContain('"type":"trigger_start"');
      expect(logText).toContain('"triggerSlackId":"UABCDEF1"');
      expect(logText).toContain('"type":"trigger_end"');
      const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const slackAlias = aliases.find(
        (a) => a.aliasType === "slack.thread" && a.aliasValue === "C123/1710000000.001",
      );
      const sessionAlias = aliases.find(
        (a) => a.aliasType === "opencode.session" && a.aliasValue === "session-1",
      );
      const repoAlias = aliases.find(
        (a) => a.aliasType === "repo" && a.aliasValue === "runner-trigger-test",
      );
      expect(slackAlias).toBeDefined();
      expect(sessionAlias).toBeDefined();
      expect(repoAlias).toBeDefined();
      expect(slackAlias.anchorId).toBe(sessionAlias.anchorId);
      expect(repoAlias.anchorId).toBe(sessionAlias.anchorId);
      expect(aliases).not.toContainEqual(expect.objectContaining({ aliasValue: correlationKey }));

      const second = await trigger(url, { prompt: "second", correlationKey });
      const secondStart = second.events.find((e) => e.type === "start");
      const secondDone = second.events.find((e) => e.type === "done");
      expect(secondStart).toMatchObject({ sessionId: "session-1", resumed: true });
      expect(secondDone).toMatchObject({
        sessionId: "session-1",
        resumed: true,
        status: "completed",
      });
      // The repo alias is stamped once at anchor creation; resuming must not add a second.
      const repoAliasesAfterResume = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((a) => a.aliasType === "repo");
      expect(repoAliasesAfterResume).toHaveLength(1);
    });
  });

  it("injects resolved triggering user context only for a new session", async () => {
    const h = createHarness({
      workspaceConfig: {
        users: [
          {
            name: "Alice Example",
            email: "alice@example.com",
            slack: "UABCDEF1",
            github: "alice",
          },
        ],
      },
    });
    const correlationKey = "slack:thread:C123/1710000000.091";

    await withServer(h.app, async (url) => {
      await trigger(url, {
        prompt: "first",
        correlationKey,
        triggerSlackId: "UABCDEF1",
      });
      await trigger(url, {
        prompt: "second",
        correlationKey,
        triggerSlackId: "UABCDEF1",
      });
    });

    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[0]).toContain("[Triggering user]");
    expect(h.prompts[0]).toContain("Run triggered by Alice Example <alice@example.com>");
    expect(h.prompts[0]).toContain("slack: UABCDEF1");
    expect(h.prompts[0]).toContain("github: alice");
    expect(h.prompts[0]).toContain(`${WORKSPACE_CONFIG_PATH} users[]`);
    expect(h.prompts[1]).not.toContain("[Triggering user]");
    expect(h.prompts[1]).not.toContain("Alice Example");
    expect(h.prompts[1]).toContain("second");
  });

  it("serializes direct no-session triggers for the same fresh known correlation key", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:C123/1710000000.050";

    await withServer(h.app, async (url) => {
      const [first, second] = await Promise.all([
        trigger(url, { prompt: "first", correlationKey }),
        trigger(url, { prompt: "second", correlationKey }),
      ]);

      expect([first.json?.sessionId, second.json?.sessionId]).toEqual(["session-1", "session-1"]);
      expect([first.json?.resumed, second.json?.resumed].sort()).toEqual([false, true]);
    });

    expect(h.existingSessions).toEqual(new Set(["session-1"]));
    const aliases = readAliases();
    const slackAliases = aliases.filter(
      (alias) => alias.aliasType === "slack.thread" && alias.aliasValue === "C123/1710000000.050",
    );
    const sessionAliases = aliases.filter(
      (alias) => alias.aliasType === "opencode.session" && alias.aliasValue === "session-1",
    );
    expect(slackAliases).toHaveLength(1);
    expect(sessionAliases).toHaveLength(1);
    expect(slackAliases[0].anchorId).toBe(sessionAliases[0].anchorId);
  });

  it("keeps unsupported direct trigger correlation keys on the raw fallback path", async () => {
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const result = await trigger(url, { prompt: "raw", correlationKey: "cron:direct" });
      expect(result.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "session-1",
        resumed: false,
      });
    });

    const aliases = readAliases();
    expect(aliases).toContainEqual(
      expect.objectContaining({ aliasType: "opencode.session", aliasValue: "session-1" }),
    );
    expect(aliases).not.toContainEqual(expect.objectContaining({ aliasValue: "cron:direct" }));
  });

  it("binds explicit-session direct trigger correlation keys to the session anchor", async () => {
    const h = createHarness({ existingSessions: new Set(["requested-session"]) });
    const anchorId = mintAnchor();
    bindSessionToAnchor("requested-session", anchorId);
    const correlationKey = "slack:thread:C123/1710000000.060";

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "explicit",
        sessionId: "requested-session",
        correlationKey,
      });
      expect(result.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "requested-session",
        resumed: true,
      });
    });

    expect(resolveAnchorForCorrelationKey(correlationKey)).toBe(anchorId);
  });

  it("serializes session resolution for different aliases of the same session", async () => {
    const slackKey = "slack:thread:C123/1710000000.010";
    const gitKey = "git:branch:runner-trigger-test:feature/shared";
    const sharedAnchor = mintAnchor();
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "shared-session",
      anchorId: sharedAnchor,
    });
    appendCorrelationAliasForAnchor(sharedAnchor, slackKey);
    appendCorrelationAliasForAnchor(sharedAnchor, gitKey);

    let activeGets = 0;
    let maxActiveGets = 0;
    let delayedFirstGet = false;
    let resolveFirstGetStarted!: () => void;
    let releaseFirstGet!: () => void;
    const firstGetStarted = new Promise<void>((resolve) => {
      resolveFirstGetStarted = resolve;
    });
    const releaseFirstGetPromise = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const h = createHarness({
      existingSessions: new Set(["shared-session"]),
      onGet: async () => {
        activeGets++;
        maxActiveGets = Math.max(maxActiveGets, activeGets);
        try {
          if (!delayedFirstGet) {
            delayedFirstGet = true;
            resolveFirstGetStarted();
            await releaseFirstGetPromise;
          }
        } finally {
          activeGets--;
        }
      },
    });

    await withServer(h.app, async (url) => {
      const postTrigger = (correlationKey: string, prompt: string) =>
        fetch(`${url}/trigger`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            correlationKey,
            directory: "/workspace/repos/runner-trigger-test",
          }),
        });

      const first = postTrigger(slackKey, "from slack");
      await firstGetStarted;
      const second = postTrigger(gitKey, "from github");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maxActiveGets).toBe(1);
      releaseFirstGet();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      await Promise.all([firstResponse.body?.cancel?.(), secondResponse.body?.cancel?.()]);
    });

    expect(maxActiveGets).toBe(1);
  });

  it("falls back from stale stored session without markdown-notes continuity", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:C123/1710000000.002";

    await withServer(h.app, async (url) => {
      await trigger(url, { prompt: "old", correlationKey });
      h.existingSessions.delete("session-1");

      const next = await trigger(url, { prompt: "new", correlationKey });
      expect(next.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "session-2",
        resumed: false,
      });
      expect(h.prompts.at(-1)).not.toContain("Previous session was lost");
      expect(h.prompts.at(-1)).not.toContain("Your notes from the prior session are at:");
    });
  });

  it("returns busy without prompting when a resumed session is busy and interrupt is absent", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.003");

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "later",
          correlationKey: "slack:thread:C123/1710000000.003",
          directory: sessionDir,
        }),
      });
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(h.aborts).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it("aborts then prompts when a resumed session is busy and interrupt is true", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.004");

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "now",
        correlationKey: "slack:thread:C123/1710000000.004",
        interrupt: true,
      });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        sessionId: "busy-session",
        resumed: true,
        status: "completed",
      });
    });

    expect(h.aborts).toEqual(["busy-session"]);
    expect(h.prompts).toHaveLength(1);
  });

  it("keeps observing a resumed interrupted session after stale idle until later tool output", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
      promptEvents: (sessionId) => [
        idleEvent(sessionId),
        toolEvent(
          sessionId,
          "bash",
          "completed",
          { command: "git status" },
          { start: 1000, end: 1200 },
          "{}",
        ),
        idleEvent(sessionId),
      ],
    });
    setupBusySession("1710000000.012");

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "now",
        correlationKey: "slack:thread:C123/1710000000.012",
        interrupt: true,
      });

      expect(result.events.find((e) => e.type === "tool")).toMatchObject({
        type: "tool",
        tool: "git status",
        status: "completed",
      });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        sessionId: "busy-session",
        resumed: true,
        status: "completed",
      });
    });

    expect(h.aborts).toEqual(["busy-session"]);
    expect(h.prompts).toHaveLength(1);
  });

  it("labels python3 bash wrappers with one segment only", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [
        toolEvent(
          sessionId,
          "bash",
          "completed",
          { command: "python3 - <<'PY'\nprint('hi')\nPY" },
          { start: 1000, end: 1200 },
          "ok",
        ),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "now",
        correlationKey: "slack:thread:C123/1710000000.013",
      });

      expect(result.events.find((e) => e.type === "tool")).toMatchObject({
        type: "tool",
        tool: "python3",
        status: "completed",
      });
    });
  });

  it("returns busy without prompting when a resumed session is busy and interrupt is false", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.011");

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "later",
          correlationKey: "slack:thread:C123/1710000000.011",
          directory: sessionDir,
          interrupt: false,
        }),
      });
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(h.prompts).toHaveLength(0);
  });

  it("injects memory/tool bootstrap instructions only on new sessions", async () => {
    mkdirSync(`${memoryDir}/runner-trigger-test`, { recursive: true });
    writeFileSync(`${memoryDir}/README.md`, "root memory text");
    writeFileSync(`${memoryDir}/runner-trigger-test/README.md`, "repo memory text");
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const first = await trigger(url, {
        prompt: "first",
        correlationKey: "slack:thread:C123/1710000000.005",
      });
      expect(first.events.filter((e) => e.type === "memory")).toHaveLength(2);
      expect(h.prompts[0]).toContain("root memory text");
      expect(h.prompts[0]).toContain("repo memory text");
      const firstLogRecords = readFileSync(sessionLogPath("session-1"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const firstTriggerStart = firstLogRecords.find((record) => record.type === "trigger_start");
      // trigger_start no longer carries a promptPreview field — the prompt
      // body lives in the opencode_event stream as a `[correlation-key:]`
      // text part.
      expect(firstTriggerStart).toMatchObject({
        correlationKey: "slack:thread:C123/1710000000.005",
      });
      expect(firstTriggerStart).not.toHaveProperty("promptPreview");
      expect(JSON.stringify(firstTriggerStart)).not.toContain("root memory text");
      expect(JSON.stringify(firstTriggerStart)).not.toContain("repo memory text");

      await trigger(url, {
        prompt: "second",
        correlationKey: "slack:thread:C123/1710000000.005",
      });
      expect(h.prompts[1]).not.toContain("root memory text");
      expect(h.prompts[1]).not.toContain("repo memory text");
    });
  });

  it("emits context progress from assistant message updates using configured model limits", async () => {
    const h = createHarness({
      providerList: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { limit: { context: 200_000 } },
            },
          },
        ],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C0/1710000000.090",
      });

      expect(result.events.find((e) => e.type === "context")).toMatchObject({
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 126_000,
        limit: 200_000,
        usagePercent: 63,
      });
      expect(result.events.filter((e) => e.type === "tool")).toHaveLength(0);
    });
  });

  it("keys context limits by provider and model to avoid same-model collisions", async () => {
    const h = createHarness({
      providerList: {
        all: [
          { id: "openai", models: { "gpt-5.4": { limit: { context: 200_000 } } } },
          { id: "anthropic", models: { "gpt-5.4": { limit: { context: 1_000_000 } } } },
        ],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId, {
          providerID: "openai",
          modelID: "gpt-5.4",
          tokens: { input: 100_000, output: 20_000, reasoning: 6_000 },
          role: "assistant",
        }),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C0/1710000000.099",
      });

      expect(result.events.find((e) => e.type === "context")).toMatchObject({
        providerID: "openai",
        modelID: "gpt-5.4",
        tokens: 126_000,
        limit: 200_000,
        usagePercent: 63,
      });
    });
  });

  it("extracts context totals only from displayed token usage fields", async () => {
    const h = createHarness({
      providerList: {
        all: [{ id: "openai", models: { "gpt-5.5": { limit: { context: 200_000 } } } }],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId, {
          providerID: "openai",
          modelID: "gpt-5.5",
          tokens: {
            input: 100_000,
            output: 20_000,
            reasoning: 6_000,
            cache: { read: 4_000, write: 99_000 },
            metadata: { nested: 999_000 },
          },
          role: "assistant",
        }),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C0/1710000000.100",
      });

      expect(result.events.find((e) => e.type === "context")).toMatchObject({
        tokens: 130_000,
        limit: 200_000,
        usagePercent: 65,
      });
    });
  });

  it("suppresses zero-token assistant message context updates", async () => {
    const h = createHarness({
      providerList: {
        all: [{ id: "openai", models: { "gpt-5.5": { limit: { context: 200_000 } } } }],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId, {
          providerID: "openai",
          modelID: "gpt-5.5",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0 } },
          role: "assistant",
        }),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "fresh assistant",
        correlationKey: "slack:thread:C0/1710000000.101",
      });

      expect(result.events.find((e) => e.type === "context")).toBeUndefined();
    });
  });

  it("normalizes context usage percent to an integer before emitting", async () => {
    const h = createHarness({
      providerList: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { limit: { context: 200_000 } },
            },
          },
        ],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId, {
          providerID: "openai",
          modelID: "gpt-5.5",
          tokens: { input: 99_999 },
          role: "assistant",
        }),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C0/1710000000.092",
      });

      expect(result.events.find((e) => e.type === "context")).toMatchObject({
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 99_999,
        limit: 200_000,
        usagePercent: 50,
      });
    });
  });

  it("caches resolved model context limits in memory across triggers", async () => {
    let providerLists = 0;
    const h = createHarness({
      onProviderList: () => {
        providerLists++;
      },
      providerList: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { limit: { context: 200_000 } },
            },
          },
        ],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      await trigger(url, {
        prompt: "large search one",
        correlationKey: "slack:thread:C0/1710000000.093",
      });
      await trigger(url, {
        prompt: "large search two",
        correlationKey: "slack:thread:C0/1710000000.094",
      });
    });

    expect(providerLists).toBe(1);
  });

  it("shares the global model-limit cache across opencode urls", async () => {
    let providerListsA = 0;
    let providerListsB = 0;
    const promptEvents = (sessionId: string) => [
      messageUpdatedEvent(sessionId),
      textEvent(sessionId, "done"),
      idleEvent(sessionId),
    ];

    const a = createHarness({
      opencodeUrl: "http://opencode-a.test:4096",
      onProviderList: () => {
        providerListsA++;
      },
      providerList: {
        all: [{ id: "openai", models: { "gpt-5.5": { limit: { context: 200_000 } } } }],
        default: {},
        connected: [],
      },
      promptEvents,
    });
    const b = createHarness({
      opencodeUrl: "http://opencode-b.test:4096",
      onProviderList: () => {
        providerListsB++;
      },
      providerList: {
        all: [{ id: "openai", models: { "gpt-5.5": { limit: { context: 200_000 } } } }],
        default: {},
        connected: [],
      },
      promptEvents,
    });

    await withServer(a.app, async (urlA) => {
      await withServer(b.app, async (urlB) => {
        await Promise.all([
          trigger(urlA, {
            prompt: "large search a",
            correlationKey: "slack:thread:C0/1710000000.095",
          }),
          trigger(urlB, {
            prompt: "large search b",
            correlationKey: "slack:thread:C0/1710000000.096",
          }),
        ]);
      });
    });

    expect(providerListsA + providerListsB).toBe(1);
  });

  it("warms model limits best-effort even when a resumed session returns busy", async () => {
    let providerLists = 0;
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
      onProviderList: () => {
        providerLists++;
      },
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "hello",
          sessionId: "busy-session",
          correlationKey: "slack:thread:C0/1710000000.097",
          directory: "/workspace/repos/runner-trigger-test",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(providerLists).toBe(1);
  });

  it("skips context progress when no positive configured model limit is known", async () => {
    const h = createHarness({
      providerList: {
        all: [{ id: "openai", models: { "gpt-5.5": { limit: { context: 0 } } } }],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C0/1710000000.091",
      });

      expect(result.events.find((e) => e.type === "context")).toBeUndefined();
    });
  });

  it("warms model limits best-effort even for tokenless message.updated events", async () => {
    let providerLists = 0;
    const h = createHarness({
      onProviderList: () => {
        providerLists++;
      },
      providerList: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { limit: { context: 200_000 } },
            },
          },
        ],
        default: {},
        connected: [],
      },
      promptEvents: (sessionId) => [
        messageUpdatedEvent(sessionId, {
          providerID: "openai",
          modelID: "gpt-5.5",
          tokens: undefined,
          role: "assistant",
        }),
        textEvent(sessionId, "done"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "tokenless update",
        correlationKey: "slack:thread:C0/1710000000.098",
      });

      expect(result.events.find((e) => e.type === "context")).toBeUndefined();
    });

    expect(providerLists).toBe(1);
  });

  it("emits opencode.subsession aliases for discovered child sessions", async () => {
    const h = createHarness({
      children: [{ id: "child-session" }],
      promptEvents: (sessionId) => [taskRunningEvent(sessionId), idleEvent(sessionId)],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "delegate",
        correlationKey: "slack:thread:C123/1710000000.006",
      });
      expect(result.events.find((e) => e.type === "delegate")).toMatchObject({ agent: "general" });
    });

    const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const parentAlias = aliases.find(
      (a) => a.aliasType === "opencode.session" && a.aliasValue === "session-1",
    );
    const childAlias = aliases.find(
      (a) => a.aliasType === "opencode.subsession" && a.aliasValue === "child-session",
    );
    expect(parentAlias).toBeDefined();
    expect(childAlias).toBeDefined();
    // Both bind to the same anchor so findActiveTrigger walks from child → parent.
    expect(childAlias.anchorId).toBe(parentAlias.anchorId);
  });

  it("skips task delegate progress when task input is missing", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [
        taskRunningWithoutInputEvent(sessionId),
        textEvent(sessionId, "continued"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "delegate without input",
        correlationKey: "slack:thread:C123/1710000000.061",
      });
      expect(result.events.find((e) => e.type === "delegate")).toBeUndefined();
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "completed",
        response: "continued",
      });
    });
  });

  it("emits session errors as tool progress and continues when later activity arrives", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [
        sessionErrorEvent(sessionId, "Input exceeds context window of this model"),
        textEvent(sessionId, "continued after compaction"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:C123/1710000000.007",
      });
      expect(result.events).toContainEqual({ type: "tool", tool: "error", status: "error" });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "completed",
        response: "continued after compaction",
      });
    });
  });

  it("uses the latest session error as terminal failure when no later activity arrives", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [sessionErrorEvent(sessionId, "provider unavailable")],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "fail",
        correlationKey: "slack:thread:C123/1710000000.008",
      });
      expect(result.events).toContainEqual({ type: "tool", tool: "error", status: "error" });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
  });

  it("returns 500 and writes no orphan trigger_start when subscribe throws before startTrigger", async () => {
    const h = createHarness({ throwInSubscribe: true });
    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "go",
          correlationKey: "slack:thread:C123/1710000200.001",
          directory: sessionDir,
        }),
      });
      expect(response.status).toBe(500);
    });
    // No trigger_start should be on disk because subscribe threw before startTrigger ran.
    let logged = "";
    try {
      logged = readFileSync(sessionLogPath("session-1"), "utf8");
    } catch {
      // File may not exist at all — that also satisfies the invariant.
    }
    expect(logged).not.toContain('"type":"trigger_start"');
  });

  it("renders a previously orphaned trigger as 'crashed' when a newer trigger_start lands in the same session", async () => {
    const olderTriggerId = "00000000-0000-7000-8000-000000000602";
    const newerTriggerId = "00000000-0000-7000-8000-000000000603";
    const crashAnchor = mintAnchor();
    bindSessionToAnchor("crash-session", crashAnchor);
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: olderTriggerId });
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: newerTriggerId });

    const h = createHarness();
    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${crashAnchor}/${olderTriggerId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("crashed");
      expect(html).toContain(`superseded by ${newerTriggerId}`);
    });
  });

  it("/internal/e2e/trigger-context rejects wrong secret and writes trigger_start on success", async () => {
    process.env.THOR_E2E_TEST_HELPERS = "1";
    process.env.THOR_INTERNAL_SECRET = "fixed-test-secret-1234567890123456";

    try {
      const h = createHarness();
      await withServer(h.app, async (url) => {
        const wrong = await fetch(`${url}/internal/e2e/trigger-context`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-thor-internal-secret": "wrong-secret-with-correct-length123",
          },
          body: JSON.stringify({}),
        });
        expect(wrong.status).toBe(401);

        const okResp = await fetch(`${url}/internal/e2e/trigger-context`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-thor-internal-secret": process.env.THOR_INTERNAL_SECRET!,
          },
          body: JSON.stringify({
            correlationKey: "slack:thread:C123/1710000200.002",
            triggerSlackId: "UABCDEF1",
            triggerGithubLogin: "alice",
          }),
        });
        expect(okResp.status).toBe(200);
        const data = (await okResp.json()) as {
          sessionId: string;
          triggerId: string;
          anchorId: string;
        };
        expect(data.sessionId).toMatch(/^e2e-/);
        expect(data.triggerId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(data.anchorId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const text = readFileSync(sessionLogPath(data.sessionId), "utf8");
        expect(text).toContain(`"triggerId":"${data.triggerId}"`);
        expect(text).toContain('"triggerSlackId":"UABCDEF1"');
        expect(text).toContain('"triggerGithubLogin":"alice"');
      });
    } finally {
      delete process.env.THOR_E2E_TEST_HELPERS;
      delete process.env.THOR_INTERNAL_SECRET;
    }
  });

  it("does not let status events extend the session error grace period", async () => {
    const h = createHarness({
      promptEvents: (sessionId, sub) => {
        sub.push(sessionErrorEvent(sessionId, "provider unavailable"));
        setTimeout(() => sub.push(statusEvent(sessionId)), 5);
        setTimeout(() => sub.push(statusEvent(sessionId)), 15);
      },
    });

    await withServer(h.app, async (url) => {
      const startedAt = Date.now();
      const result = await trigger(url, {
        prompt: "fail",
        correlationKey: "slack:thread:C123/1710000000.009",
      });
      expect(Date.now() - startedAt).toBeLessThan(100);
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
  });
});
