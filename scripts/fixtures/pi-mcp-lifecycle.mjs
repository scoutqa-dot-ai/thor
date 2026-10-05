// Run inside the unchanged Pi runner after each broker-only catalog activation.
// Real native tasks prove live discovery, stale reference denial and pinned TLS bearer identity.
import assert from "node:assert/strict";
const operation = process.argv[2];
const before = await (await fetch("http://mcp-fixture:8000/health")).json();
const response = await fetch("http://127.0.0.1:3000/trigger", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-thor-internal-secret": process.env.THOR_INTERNAL_SECRET,
  },
  body: JSON.stringify({
    directory: "/workspace/repos/pi-fixture",
    prompt: `fixture-catalog-lifecycle ${operation}`,
    requestId: `catalog-lifecycle-${operation}`,
    correlationKey: `cron:catalog-lifecycle-${operation}`,
    stream: true,
  }),
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const frames = (await response.text()).trim().split("\n").map(JSON.parse);
assert.equal(frames.at(-1).status, "completed", JSON.stringify(frames.at(-1)));
assert.equal(frames.at(-1).response, `fixture lifecycle verified ${operation}`);
assert(
  frames.some(
    (frame) => frame.type === "tool" && frame.tool === "mcp_search" && frame.status === "completed",
  ),
);
if (["remove", "disable", "readd", "rotate"].includes(operation))
  assert(
    frames.some(
      (frame) => frame.type === "tool" && frame.tool === "mcp_call" && frame.status === "error",
    ),
    "Old activation reference must deny natively",
  );
const visible = !["absent", "remove", "disable"].includes(operation);
const after = await (await fetch("http://mcp-fixture:8000/health")).json();
assert.equal(after.effects, before.effects + (visible ? 1 : 0));
assert.equal(after.cards.length, before.cards.length);
if (visible) {
  assert.deepEqual(after.calls.at(-1), {
    name: "echo",
    arguments: { text: `lifecycle-${operation}` },
    principal: operation === "rotate" ? "replacement" : "first",
  });
}
assert(!after.calls.some((call) => call.arguments.text.startsWith("must-not-dispatch-")));
const model = await (await fetch("http://model-fixture:8000/probe")).json();
assert.deepEqual(model.catalogRounds.at(-1), {
  operation,
  visible,
  nativeTools: ["mcp_call", "mcp_search"],
});
assert.equal(model.wrapperCalls, 1, "Native onboarding cannot use shell wrapper");
console.log(`PASS: native catalog ${operation}, stable two tools, exact effects and TLS principal`);
