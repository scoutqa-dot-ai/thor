// Deterministic Responses, policy-wrapper and SSO fixtures; no provider credentials or external I/O.
import { createServer } from "node:http";

let heldOnce = false;
let calls = 0;
let wrapperCalls = 0;
let slackPosts = 0;
let lastWrapper;

function respond(res, content, toolName = "bash", callId = "call_fixture") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let sequence_number = 0;
  const emit = (event) =>
    res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence_number++ })}\n\n`);
  emit({ type: "response.created", response: { id: `resp_${calls}` } });
  if (typeof content === "string") {
    const item = {
      type: "message",
      id: `msg_${calls}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: content });
    emit({ type: "response.output_item.done", output_index: 0, item });
  } else {
    const item = {
      type: "function_call",
      id: `fc_${callId}`,
      call_id: callId,
      name: toolName,
      status: "completed",
      arguments: JSON.stringify(content),
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    emit({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: item.arguments,
    });
    emit({ type: "response.output_item.done", output_index: 0, item });
  }
  emit({
    type: "response.completed",
    response: {
      id: `resp_${calls}`,
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  });
  res.end();
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
async function handle(req, res) {
  if (req.url === "/vouch/validate") {
    if (!(req.headers.cookie ?? "").includes("fixture-auth=1")) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "x-vouch-user": "fixture@example.com" });
    res.end();
    return;
  }
  if (req.url === "/health") {
    json(res, { ok: true });
    return;
  }
  if (req.url === "/probe") {
    json(res, { calls, wrapperCalls, slackPosts, lastWrapper });
    return;
  }
  if (req.url === "/dashboard") {
    res.end("fixture dashboard");
    return;
  }
  if (req.url?.startsWith("/slack/")) {
    for await (const _chunk of req) {
      /* Consume the Slack form payload without recording it. */
    }
    if (req.url.includes("chat.postMessage")) slackPosts++;
    json(res, { ok: true, ts: "1710000000.001" });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url === "/exec/gh") {
    wrapperCalls++;
    lastWrapper = {
      sessionId: req.headers["x-thor-session-id"],
      callId: req.headers["x-thor-call-id"],
      directory: payload.directory,
    };
    json(res, { stdout: "controlled-wrapper\n", stderr: "", exitCode: 0 });
    return;
  }
  if (req.url !== "/v1/responses" || req.method !== "POST") {
    json(res, { error: "fixture route not found" }, 404);
    return;
  }
  calls++;
  const input = JSON.stringify(payload.input);
  if (input.includes("fixture-hold") && !heldOnce) {
    heldOnce = true;
    return;
  }
  const toolOutput = payload.input?.findLast(
    (item) => item.type === "function_call_output" && item.call_id === "call_fixture",
  );
  if (input.includes("fixture-tool") && !toolOutput) {
    respond(res, {
      command:
        'test ! -e /var/lib/runner/runner-only && test -z "${SLACK_BOT_TOKEN-}" && test -z "${THOR_INTERNAL_SECRET-}" && gh --version && printf \'executor-only\\n\' > /workspace/worktrees/pi-proof.txt',
      timeout: 10,
    });
    return;
  }
  if (toolOutput && !String(toolOutput.output).includes("controlled-wrapper")) {
    respond(res, "fixture tool failed");
    return;
  }
  if (
    toolOutput &&
    !payload.input.some(
      (item) => item.type === "function_call_output" && item.call_id === "call_read",
    )
  ) {
    respond(res, { path: "/workspace/worktrees/pi-proof.txt" }, "read", "call_read");
    return;
  }
  if (
    toolOutput &&
    !payload.input.some(
      (item) => item.type === "function_call_output" && item.call_id === "call_extra",
    )
  ) {
    respond(res, { command: "printf checked", timeout: 10 }, "bash", "call_extra");
    return;
  }
  respond(res, input.includes("fixture-hold") ? "fixture recovered" : "fixture completed");
}
for (const port of [8000, 9090, 2455, 3002]) {
  createServer((req, res) => {
    void handle(req, res).catch(() => json(res, { error: "invalid fixture request" }, 400));
  }).listen(port, "0.0.0.0");
}
