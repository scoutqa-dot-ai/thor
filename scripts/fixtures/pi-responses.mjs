// Deterministic Responses, policy-wrapper and SSO fixtures; no provider credentials or external I/O.
import { createServer } from "node:http";
import assert from "node:assert/strict";

let heldOnce = false;
let calls = 0;
let wrapperCalls = 0;
let slackPosts = 0;
let lastProgressTarget;
let lastWrapper;
let slackReplies = 0;
let lastReply;
let hostReplies = 0;
let lastHostReply;
let imageInputs = 0;
const modelSelections = [];
const slackDeliveries = [];
const catalogRounds = [];
let catalogRef;
let recoveredMcpActor = false;
const imageFixtureBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8AAQVDqPwMDAEHSBfsl0XwmAAAAAElFTkSuQmCC";

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
    json(res, {
      calls,
      wrapperCalls,
      slackPosts,
      lastProgressTarget,
      lastWrapper,
      slackReplies,
      lastReply,
      hostReplies,
      lastHostReply,
      imageInputs,
      modelSelections,
      slackDeliveries,
      catalogRounds,
      recoveredMcpActor,
    });
    return;
  }
  if (
    req.url === "/internal/google-workspace/waits" ||
    req.url === "/internal/google-workspace/continuations"
  ) {
    if (req.headers["x-thor-internal-secret"] !== "runner-internal-sentinel") {
      json(res, { error: "unauthorized" }, 401);
      return;
    }
    json(res, req.url.endsWith("/waits") ? { waits: [] } : { continuations: [] });
    return;
  }
  if (req.url === "/dashboard") {
    res.end("fixture dashboard");
    return;
  }
  if (req.url?.startsWith("/slack/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    slackDeliveries.push({
      method: req.url,
      channel: form.get("channel") ?? form.get("channel_id"),
      threadTs: form.get("thread_ts"),
      status: form.get("status"),
      timestamp: form.get("timestamp"),
      name: form.get("name"),
      ts: form.get("ts"),
      text: form.get("text"),
      blocks: JSON.parse(form.get("blocks") || "[]"),
    });
    if (slackDeliveries.length > 200) slackDeliveries.shift();
    if (req.url.includes("chat.postMessage")) {
      slackPosts++;
      lastProgressTarget = { channel: form.get("channel"), threadTs: form.get("thread_ts") };
      if (form.get("blocks")?.includes('"section"')) {
        hostReplies++;
        lastHostReply = {
          channel: form.get("channel"),
          threadTs: form.get("thread_ts"),
          text: form.get("text"),
          blocks: JSON.parse(form.get("blocks")),
        };
      }
    }
    json(res, {
      ok: true,
      ts: "1710000000.001",
      agent_status: form.get("status"),
      status: form.get("status"),
      channel: { id: "C_SIGNED", is_private: false, is_shared: false },
    });
    return;
  }
  if (req.url?.startsWith("/google-workspace/")) {
    json(res, {
      trustedInternalHeader: req.headers["x-thor-internal-secret"] === "runner-internal-sentinel",
      vouchUser: req.headers["x-vouch-user"] ?? null,
    });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url === "/exec/slack-post-message") {
    slackReplies++;
    lastReply = {
      args: payload.args,
      text: payload.stdin,
      sessionId: req.headers["x-thor-session-id"],
    };
    json(res, { stdout: "fixture reply posted", stderr: "", exitCode: 0 });
    return;
  }
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
  const effort = payload.reasoning?.effort;
  if (
    !["fixture-model", "fixture-fast", "fixture-balanced", "fixture-strong"].includes(
      payload.model,
    ) ||
    !["minimal", "low", "medium", "high"].includes(effort) ||
    !payload.tools.some((tool) => tool.name === "escalate_model")
  ) {
    json(res, { error: "unsupported fixture model, reasoning or routing tool contract" }, 400);
    return;
  }
  modelSelections.push({ model: payload.model, effort });
  const input = JSON.stringify(payload.input);
  if (input.includes("fixture-escalation")) {
    if (payload.model === "fixture-fast")
      respond(
        res,
        { profile: "balanced", reason: "Need more reasoning" },
        "escalate_model",
        "call_escalate_balanced",
      );
    else if (payload.model === "fixture-balanced")
      respond(
        res,
        { profile: "strong", reason: "Need deeper reasoning" },
        "escalate_model",
        "call_escalate_strong",
      );
    else respond(res, "fixture promoted twice");
    return;
  }
  if (input.includes("fixture-progress-delay")) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    respond(res, "fixture zero-tool answer");
    return;
  }
  if (input.includes("fixture-hold") && !heldOnce) {
    heldOnce = true;
    return;
  }
  if (input.includes("fixture-slack-intake")) {
    if (input.includes("final assistant text will be published")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      respond(res, "fixture signed completed");
      return;
    }
    const latestUser = payload.input.findLastIndex((item) => item.role === "user");
    const replied = payload.input
      .slice(latestUser + 1)
      .some(
        (item) =>
          item.type === "function_call_output" && item.call_id.startsWith("call_signed_reply_"),
      );
    if (!replied) {
      respond(
        res,
        {
          command:
            "printf 'fixture signed reply\\n' | slack-post-message --channel C_SIGNED --thread-ts 1710000000.010",
          timeout: 10,
        },
        "bash",
        `call_signed_reply_${calls}`,
      );
    } else respond(res, "fixture signed completed");
    return;
  }
  if (input.includes("fixture-catalog-lifecycle")) {
    const operation = input.match(
      /fixture-catalog-lifecycle (absent|add|remove|disable|readd|replace-token|rotate)/,
    )?.[1];
    assert(operation, "Catalog lifecycle operation missing");
    assert.deepEqual(
      payload.tools
        .filter((tool) => tool.name.startsWith("mcp_"))
        .map((tool) => tool.name)
        .sort(),
      ["mcp_call", "mcp_search"],
    );
    const output = (suffix) =>
      payload.input.findLast(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === `call_lifecycle_${operation}_${suffix}`,
      );
    const stale = output("stale"),
      search = output("search"),
      invoked = output("invoke");
    if (catalogRef && !["add", "replace-token", "absent"].includes(operation) && !stale) {
      respond(
        res,
        { toolRef: catalogRef, arguments: { text: `must-not-dispatch-${operation}` } },
        "mcp_call",
        `call_lifecycle_${operation}_stale`,
      );
      return;
    }
    if (stale)
      assert.notEqual(
        stale.output,
        `must-not-dispatch-${operation}`,
        "Stale catalog authority executed",
      );
    const visible = !["absent", "remove", "disable"].includes(operation);
    if (!search) {
      respond(
        res,
        visible ? { server: "rotatingdocs", exactName: "echo" } : { query: "" },
        "mcp_search",
        `call_lifecycle_${operation}_search`,
      );
      return;
    }
    const page = JSON.parse(search.output);
    const descriptor = page.tools.find((tool) => tool.server === "rotatingdocs");
    if (visible) {
      assert(descriptor, "Activated alias absent from native discovery");
      assert.deepEqual(descriptor.inputSchema.required, ["text"]);
      assert.equal(descriptor.inputSchema.additionalProperties, false);
      assert(!JSON.stringify(page).includes("dummy-private"));
      if (catalogRef)
        assert.equal(
          descriptor.toolRef === catalogRef,
          operation === "replace-token",
          "Catalog revision did not match activation",
        );
      if (!invoked) {
        respond(
          res,
          { toolRef: descriptor.toolRef, arguments: { text: `lifecycle-${operation}` } },
          "mcp_call",
          `call_lifecycle_${operation}_invoke`,
        );
        return;
      }
      assert.equal(invoked.output, `lifecycle-${operation}`);
      catalogRef = descriptor.toolRef;
    } else
      assert(
        !page.servers.some((server) => server.server === "rotatingdocs"),
        "Removed/disabled alias still visible",
      );
    catalogRounds.push({ operation, visible, nativeTools: ["mcp_call", "mcp_search"] });
    respond(res, `fixture lifecycle verified ${operation}`);
    return;
  }
  if (input.includes("fixture-native-mcp-crash")) {
    const search = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_crash_search",
    );
    const invoked = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_crash_invoke",
    );
    if (!search)
      respond(res, { server: "localdocs", exactName: "echo" }, "mcp_search", "call_crash_search");
    else if (!invoked)
      respond(
        res,
        {
          toolRef: JSON.parse(search.output).tools[0].toolRef,
          arguments: { text: "native-crash" },
        },
        "mcp_call",
        "call_crash_invoke",
      );
    else {
      assert(String(invoked.output).includes("was interrupted and may have partially run"));
      assert(input.includes("Run triggered by slack: U_FIXTURE"));
      assert.equal(payload.model, "fixture-strong");
      assert.equal(effort, "high");
      recoveredMcpActor = true;
      respond(res, "fixture MCP recovered without replay");
    }
    return;
  }
  if (input.includes("Authorized MCP approval result: completed")) {
    respond(res, "fixture approved disposition");
    return;
  }
  if (input.includes("fixture-native-mcp-approval")) {
    const search = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_native_search",
    );
    const invoked = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_native_invoke",
    );
    if (!search)
      respond(
        res,
        { server: "localdocs", exactName: "write_doc" },
        "mcp_search",
        "call_native_search",
      );
    else if (!invoked)
      respond(
        res,
        {
          toolRef: JSON.parse(search.output).tools[0].toolRef,
          arguments: { text: "dummy-private-approved-native" },
        },
        "mcp_call",
        "call_native_invoke",
      );
    else if (
      input.includes("fixture-sibling-review") &&
      !payload.input.some(
        (item) => item.type === "function_call_output" && item.call_id === "call_native_sibling",
      )
    )
      respond(
        res,
        {
          toolRef: JSON.parse(search.output).tools[0].toolRef,
          arguments: { text: "must-not-dispatch-sibling" },
        },
        "mcp_call",
        "call_native_sibling",
      );
    else if (input.includes("fixture-unsupported-review")) {
      assert(String(invoked.output).includes("private DM"));
      respond(res, "fixture unsupported review denied");
    } else respond(res, "fixture native approval pending");
    return;
  }
  if (input.includes("fixture-native-mcp")) {
    const search = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_native_search",
    );
    const invoked = payload.input.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_native_invoke",
    );
    if (!search)
      respond(res, { server: "localdocs", exactName: "echo" }, "mcp_search", "call_native_search");
    else if (!invoked) {
      const page = JSON.parse(search.output);
      const mode = input.includes("native-image")
        ? "native-image"
        : input.includes("native-error")
          ? "native-error"
          : "native-structured";
      respond(
        res,
        { toolRef: page.tools[0].toolRef, arguments: { text: mode } },
        "mcp_call",
        "call_native_invoke",
      );
    } else {
      if (input.includes("native-image")) {
        if (
          !invoked.output?.some(
            (block) =>
              block.type === "input_image" &&
              block.image_url === `data:image/png;base64,${imageFixtureBase64}`,
          )
        )
          throw new Error("Native MCP image absent");
      } else if (input.includes("native-error")) {
        if (!JSON.stringify(invoked.output).includes("Confirmed fixture error"))
          throw new Error("Native MCP isError lost");
      } else if (JSON.parse(invoked.output).echoed !== "native-structured")
        throw new Error("Native structured result lost");
      respond(res, "fixture native MCP verified");
    }
    return;
  }
  if (input.includes("fixture-image")) {
    const output = payload.input?.findLast(
      (item) => item.type === "function_call_output" && item.call_id === "call_image",
    );
    if (!output) {
      respond(res, { path: "/tmp/pi-proof.png" }, "read_image", "call_image");
    } else {
      const image = output.output?.find((block) => block.type === "input_image");
      if (image?.image_url === `data:image/png;base64,${imageFixtureBase64}`) {
        imageInputs++;
        respond(res, "fixture image inspected");
      } else respond(res, "fixture image missing");
    }
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
    respond(
      res,
      {
        command:
          "slack-post-message --channel C_FIXTURE --thread-ts 1710000000.001 <<'REPLY'\nfixture thread reply\nREPLY",
        timeout: 10,
      },
      "bash",
      "call_extra",
    );
    return;
  }
  respond(res, input.includes("fixture-hold") ? "fixture recovered" : "fixture completed");
}
for (const port of [8000, 9090, 2455, 3002, 3004]) {
  createServer((req, res) => {
    void handle(req, res).catch(() => json(res, { error: "invalid fixture request" }, 400));
  }).listen(port, "0.0.0.0");
}
