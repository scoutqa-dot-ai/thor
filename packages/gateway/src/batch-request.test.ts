import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventQueue, type QueuedEvent } from "./queue.js";
import { persistBatchRunnerRequest, queuedBatchRequestId } from "./batch-request.js";
import { executeBatchDispatchPlan } from "./service.js";

async function serverUrl(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  return `http://127.0.0.1:${address.port}`;
}
function event(id: string): QueuedEvent {
  return {
    id,
    source: "cron",
    correlationKey: "cron:batch-fixture",
    payload: {},
    receivedAt: new Date().toISOString(),
    sourceTs: id === "first" ? 1 : 2,
    readyAt: 0,
  };
}

describe("gateway durable batch delivery over real HTTP", () => {
  it.each(["delivery", "delivery:resolved"])(
    "keeps %s identity through persisted reroutes and redelivery",
    async (sourceEventId) => {
      const directory = await mkdtemp(join(tmpdir(), "thor-reroute-fixture-"));
      const received: Record<string, unknown>[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ accepted: true }));
      });
      const url = await serverUrl(server);
      const queue = new EventQueue({
        dir: directory,
        disableInterval: true,
        handler: async (events, ack) => {
          const options = persistBatchRunnerRequest(directory, {
            requestId: queuedBatchRequestId(events),
            prompt: `render-${events[0].id}`,
            correlationKey: "cron:batch-fixture",
            directory: "/workspace/repos/fixture",
            deps: { runnerUrl: url },
            onAccepted: ack,
          });
          await executeBatchDispatchPlan({ kind: "dispatch", logPrefix: "cron", options });
        },
      });
      try {
        await queue.enqueue({ ...event(`${sourceEventId}:resolved:resolved`), sourceEventId });
        await queue.flush();
        await queue.enqueue(event(sourceEventId));
        await queue.flush();
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(received[0]);
        expect(queue.snapshotPending().pendingCount).toBe(0);
      } finally {
        queue.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("retains accepted-but-lost identity and exact payload across restart and new arrivals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thor-batch-fixture-"));
    const received: Record<string, unknown>[] = [];
    const accepted = new Set<string>();
    const internalSecret = "gateway-transport-secret";
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (req.headers["x-thor-internal-secret"] !== internalSecret) {
        res.writeHead(401);
        res.end();
        return;
      }
      received.push(payload);
      accepted.add(payload.requestId);
      if (received.length === 1) {
        res.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: true }));
    });
    const url = await serverUrl(server);
    let attempt = 0;
    const createQueue = () =>
      new EventQueue({
        dir: directory,
        disableInterval: true,
        handler: async (events, ack, reject, defer) => {
          const requestId = queuedBatchRequestId(events);
          const options = persistBatchRunnerRequest(directory, {
            requestId,
            prompt: `render-${++attempt}-${events.map((item) => item.id).join(",")}`,
            messageTs: `1710000000.00${attempt}`,
            triggerSlackId: "U_CURRENT",
            correlationKey: "cron:batch-fixture",
            directory: "/workspace/repos/fixture",
            deps: { runnerUrl: url, internalSecret },
            onAccepted: ack,
            onRejected: reject,
          });
          const result = await executeBatchDispatchPlan({
            kind: "dispatch",
            logPrefix: "cron",
            options,
          });
          if (result.busy) defer();
        },
      });
    let queue = createQueue();
    try {
      await queue.enqueue(event("first"));
      await queue.flush();
      expect(queue.snapshotPending().pendingCount).toBe(1);
      queue.close();
      queue = createQueue();
      await queue.enqueue(event("second"));
      await queue.flush();
      expect(received).toHaveLength(3);
      expect(received[1]).toEqual(received[0]);
      expect(received[2]?.requestId).not.toBe(received[0]?.requestId);
      expect(received[0]?.messageTs).toBe("1710000000.001");
      expect(received[1]?.messageTs).toBe("1710000000.001");
      expect(received[2]?.messageTs).toBe("1710000000.003");
      expect(accepted.size).toBe(2);
      for (const file of await readdir(join(directory, ".runner-requests"))) {
        expect(await readFile(join(directory, ".runner-requests", file), "utf8")).not.toContain(
          internalSecret,
        );
      }
      expect(queue.snapshotPending().pendingCount).toBe(0);
    } finally {
      queue.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not ACK HTTP 200 without explicit accepted:true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thor-ack-fixture-"));
    let acknowledged = 0;
    let accepts = false;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Drain request. */
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(accepts ? { accepted: true } : { ok: true }));
    });
    const url = await serverUrl(server);
    const queue = new EventQueue({
      dir: directory,
      disableInterval: true,
      handler: async (events, ack) => {
        await executeBatchDispatchPlan({
          kind: "dispatch",
          logPrefix: "cron",
          options: {
            prompt: "test",
            requestId: queuedBatchRequestId(events),
            correlationKey: "cron:batch-fixture",
            directory: "/workspace/repos/fixture",
            deps: { runnerUrl: url },
            onAccepted: () => {
              acknowledged++;
              ack();
            },
          },
        });
      },
    });
    try {
      await queue.enqueue(event("first"));
      await queue.flush();
      expect(acknowledged).toBe(0);
      expect(queue.snapshotPending().pendingCount).toBe(1);
      accepts = true;
      await queue.flush();
      expect(acknowledged).toBe(1);
      expect(queue.snapshotPending().pendingCount).toBe(0);
    } finally {
      queue.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.each([{ modelProfile: "strong" as const }, { modelId: "configured-id" }])(
  "keeps absent legacy frozen selectors/actor/interrupt absent on real HTTP retry: %j",
  async (selector) => {
    const directory = await mkdtemp(join(tmpdir(), "neo-legacy-routing-"));
    const received: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: true }));
    });
    const runnerUrl = await serverUrl(server);
    let retryAcknowledged = 0;
    try {
      const original = {
        requestId: "legacy-before-routing",
        prompt: "legacy task",
        correlationKey: "cron:legacy",
        directory: "/workspace/repos/fixture",
        deps: { runnerUrl },
      };
      const frozen = persistBatchRunnerRequest(directory, original);
      await executeBatchDispatchPlan({ kind: "dispatch", logPrefix: "cron", options: frozen });
      // Same representation as a pre-routing record: the optional keys do not exist.
      const file = (await readdir(join(directory, ".runner-requests")))[0];
      const saved = JSON.parse(await readFile(join(directory, ".runner-requests", file), "utf8"));
      expect(Object.keys(saved).sort()).toEqual(["correlationKey", "directory", "prompt"]);
      const retry = persistBatchRunnerRequest(directory, {
        ...original,
        prompt: "fresh rendering",
        slackReplyAdmission: {
          version: 1,
          teamId: "T123",
          channel: "G_PRIVATE",
          threadTs: "1710000000.001",
        },
        ...selector,
        thinkingLevel: "high",
        routingTask: "new evidence must not leak",
        triggerSlackId: "U_FRESH",
        messageTs: "1710000000.999",
        triggerGithubLogin: "fresh-login",
        interrupt: true,
        onAccepted: () => retryAcknowledged++,
      });
      await executeBatchDispatchPlan({ kind: "dispatch", logPrefix: "cron", options: retry });
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(received[0]);
      for (const key of [
        "modelProfile",
        "modelId",
        "thinkingLevel",
        "routingTask",
        "triggerSlackId",
        "messageTs",
        "slackReplyAdmission",
        "triggerGithubLogin",
        "interrupt",
      ]) {
        expect(received[1]).not.toHaveProperty(key);
        expect(retry).not.toHaveProperty(key);
      }
      expect(retryAcknowledged).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects conflicting API routing options before real delivery or queue persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neo-invalid-routing-"));
  let rejected = "";
  const options = {
    requestId: "conflict",
    prompt: "task",
    correlationKey: "cron:invalid",
    directory: "/workspace/repos/fixture",
    deps: { runnerUrl: "http://127.0.0.1:1" },
    modelProfile: "fast" as const,
    modelId: "configured-id",
    onRejected: (reason: string) => {
      rejected = reason;
    },
  };
  try {
    expect(() => persistBatchRunnerRequest(directory, options)).toThrow(
      "cannot combine modelProfile and modelId",
    );
    const result = await executeBatchDispatchPlan({ kind: "dispatch", logPrefix: "cron", options });
    expect(result).toMatchObject({ rejected: true, reason: "Neo model routing overrides invalid" });
    expect(rejected).toBe("Neo model routing overrides invalid");
    expect(await readdir(join(directory, ".runner-requests"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
