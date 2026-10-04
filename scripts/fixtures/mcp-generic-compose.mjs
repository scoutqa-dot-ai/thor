// Real broker container, real HTTP MCP/Slack, only dummy fixture authority/state.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendAlias,
  appendSessionEvent,
  sessionLogPath,
  McpNativeAuthoritySchema,
  mintAnchor,
} from "../../packages/common/src/index.ts";
const anchorId = mintAnchor();
const context = McpNativeAuthoritySchema.parse({
  sessionId: `pi-${anchorId}`,
  anchorId,
  triggerId: mintAnchor(),
  requestId: "dummy-generic-compose-request",
  directory: "/workspace/repos/catalog-fixture",
  repositoryDirectory: "/workspace/repos/catalog-fixture",
  requester: { source: "slack", id: "UFIXTURE" },
  teamId: "TFIXTURE",
  sourceKey: "slack:thread:CFIXTURE/1710000000.001",
  taskId: "dummy-call-task",
  callId: "dummy-call",
});
for (const aliasType of ["pi.conversation", "opencode.session"])
  appendAlias({ aliasType, aliasValue: context.sessionId, anchorId });
const { sessionId, triggerId, taskId, callId, anchorId: _anchor, ...projection } = context;
appendSessionEvent(sessionId, {
  type: "trigger_start",
  triggerId,
  correlationKey: context.sourceKey,
  triggerSlackId: "UFIXTURE",
  nativeMcp: projection,
});
const search = McpNativeAuthoritySchema.parse({
  ...context,
  callId: "dummy-search",
  taskId: "dummy-search-task",
});
for (const [authority, tool] of [
  [search, "mcp_search"],
  [context, "mcp_call"],
])
  appendSessionEvent(sessionId, {
    type: "tool_call",
    callId: authority.callId,
    tool,
    payload: { nativeMcp: authority, state: "started" },
  });
async function post(path, body) {
  const response = await fetch("http://localhost:3004" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-thor-internal-secret": "dummy-internal-secret",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const found = await post("/internal/mcp/search", {
  context: search,
  input: { server: "localdocs", exactName: "write_doc" },
});
assert.equal(found.status, "ok");
assert.equal(found.value.tools[0].policy, "approve");
const input = {
  toolRef: found.value.tools[0].toolRef,
  arguments: { text: "dummy-private-approved-business" },
};
const pending = await post("/internal/mcp/call", { context, input });
assert.equal(pending.status, "pending_approval");
const state = await (await fetch("http://fixture:8000/health")).json();
assert.equal(state.effects, 1);
assert.equal(state.cards.length, 1);
assert.equal(state.cards[0].channel, "DFIXTURE");
assert.ok(JSON.stringify(state.cards[0]).includes(input.arguments.text));
const click = {
  actionId: pending.actionId,
  decision: "approved",
  userId: "UFIXTURE",
  teamId: "TFIXTURE",
  channel: "DFIXTURE",
  messageTs: "1710000000.123",
};
const reader = {
  requester: context.requester,
  teamId: context.teamId,
  repositoryDirectory: context.repositoryDirectory,
  sourceKey: context.sourceKey,
  requestId: context.requestId,
  sessionId,
};
const wrong = await post("/internal/mcp/approvals/resolve", { ...click, userId: "UOTHER" });
assert.equal(wrong.status, "denied");
const confirmed = await post("/internal/mcp/approvals/resolve", click);
assert.equal(confirmed.value.disposition, "completed");
assert.ok(!JSON.stringify(confirmed).includes(input.arguments.text));
assert.ok(!JSON.stringify(confirmed).includes("dummy-private-vendor-result"));
await post("/internal/mcp/approvals/resolve", click);
assert.equal((await (await fetch("http://fixture:8000/health")).json()).effects, 2);
assert.equal(
  (await post("/internal/mcp/approvals/read", { actionId: pending.actionId, reader })).value
    .disposition,
  "completed",
);
assert.equal((await post("/exec/approval", { args: ["status", pending.actionId] })).exitCode, 1);
const root = "/var/lib/remote-cli/mcp-approvals";
const date = fs.readdirSync(root).find((path) => /^\d{4}-\d{2}-\d{2}$/.test(path));
const record = root + "/" + date + "/" + pending.actionId + ".json";
assert.equal(fs.statSync(record).mode & 0o7777, 0o600);
assert.equal(JSON.parse(fs.readFileSync(record)).dispatch.status, "confirmed");
// Each case starts a fresh admitted request. Restore only this dummy fixture's appended tail.
for (const [log, tail] of [
  ["session", '{"type":"trigger_start","triggerId":"'],
  ["session", '{"type":"trigger_start"\n'],
  ["session", '{"schemaVersion":1,"ts":"fixture","type":"tool_call","tool":"other","payload":{}}'],
  ["aliases", '{"aliasType":"pi.conversation","aliasValue":"'],
  ["aliases", '{"aliasType":"pi.conversation"\n'],
  [
    "aliases",
    '{"ts":"fixture","aliasType":"git.branch","aliasValue":"other","anchorId":"00000000-0000-7000-8000-000000000201"}',
  ],
]) {
  const next = McpNativeAuthoritySchema.parse({
    ...context,
    triggerId: mintAnchor(),
    requestId: mintAnchor(),
    callId: mintAnchor(),
  });
  const { sessionId, anchorId: _anchor, triggerId, taskId: _task, callId, ...nativeMcp } = next;
  appendSessionEvent(sessionId, {
    type: "trigger_start",
    triggerId,
    correlationKey: next.sourceKey,
    triggerSlackId: "UFIXTURE",
    nativeMcp,
  });
  appendSessionEvent(sessionId, {
    type: "tool_call",
    callId,
    tool: "mcp_call",
    payload: { nativeMcp: next, state: "started" },
  });
  const pending = await post("/internal/mcp/call", { context: next, input });
  assert.equal(pending.status, "pending_approval");
  const path = log === "session" ? sessionLogPath(sessionId) : "/workspace/worklog/aliases.jsonl";
  const size = fs.statSync(path).size;
  fs.appendFileSync(path, tail);
  try {
    const rejected = await post("/internal/mcp/approvals/resolve", {
      ...click,
      actionId: pending.actionId,
    });
    assert.equal(rejected.value.disposition, "rejected");
    assert.equal((await post("/internal/mcp/call", { context: next, input })).status, "denied");
    await post("/internal/mcp/approvals/resolve", { ...click, actionId: pending.actionId });
    assert.equal((await (await fetch("http://fixture:8000/health")).json()).effects, 2);
  } finally {
    fs.truncateSync(path, size);
  }
}
console.log(
  "real container incomplete/malformed session and alias evidence rejects clicks/calls with zero added effects",
);
console.log("real container private generic review/claim/result and reader/CLI gates passed");
