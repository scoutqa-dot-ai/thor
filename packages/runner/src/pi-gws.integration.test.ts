import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPiExecutorService } from "@thor/pi-executor/service";
import { piExecutionRequestSchema, type PiExecutionRequest } from "@thor/pi-executor/protocol";
import {
  ApprovalRequiredEventPayloadSchema,
  ExecResultSchema,
  findActiveSlackTriggerActor,
  findTriggerActor,
  readTriggerSlice,
  resolveAlias,
} from "@thor/common";
import { createPiRunnerApp } from "./pi-runner.js";
import { createRemoteCliApp } from "../../remote-cli/src/index.js";
import { GWS_OAUTH_BROWSER_COOKIE, GwsOAuthService } from "../../remote-cli/src/gws-oauth.js";
import {
  executeBatchDispatchPlan,
  planBatchDispatch,
  resolveApproval,
} from "../../gateway/src/service.js";

const owner = "UOWNER";
const other = "UOTHER";
const email = "owner@example.test";
const internalSecret = "pi-gws-local-fixture-secret";
const triggerDirectory = "/workspace/repos/pi-gws-fixture";
const correlationKey = "slack:thread:C123/1710000000.001";
const wrapper = fileURLToPath(new URL("../../opencode-cli/src/remote-cli.ts", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pi GWS fixture listener missing");
  return `http://127.0.0.1:${address.port}`;
}

function respond(res: ServerResponse, content: { text: string } | { command: string }, id: number) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const emit = (event: object) =>
    res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  emit({ type: "response.created", response: { id: `resp_${id}` } });
  if ("command" in content) {
    const item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_gws_${id}`,
      name: "bash",
      arguments: JSON.stringify({ command: content.command, timeout: 10 }),
      status: "completed",
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    emit({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: item.arguments,
    });
    emit({ type: "response.output_item.done", output_index: 0, item });
  } else {
    const item = {
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content.text, annotations: [] }],
    };
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    emit({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: content.text,
    });
    emit({ type: "response.output_item.done", output_index: 0, item });
  }
  emit({
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}

// Run the real wrapper source in the HTTP executor; fresh checkouts need no ignored dist artifact.
function command(endpoint: string, args: string[]): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [process.execPath, "--import", tsxLoader, wrapper, endpoint, ...args].map(quote).join(" ");
}

it("binds actual Pi tool calls to per-user GWS, owner approval and a single-use result on reviewer reentry", async () => {
  const root = await mkdtemp(join(tmpdir(), "thor-pi-gws-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("WORKLOG_DIR", join(root, "worklog"));
  vi.stubEnv("THOR_INTERNAL_SECRET", internalSecret);
  const slackRequests: string[] = [];
  const slackUrl = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(req.url).toBe("/chat.postMessage");
      expect(req.headers.authorization).toBe("Bearer xoxb-fixture");
      slackRequests.push(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      const message = JSON.parse(Buffer.concat(chunks).toString());
      res.end(
        JSON.stringify({
          ok: true,
          channel: message.channel.startsWith("U") ? "D123" : "C123",
          ts: "1710000000.100",
        }),
      );
    }),
  );
  const providerRequests: string[] = [];
  const providerUrl = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      providerRequests.push(`${req.url}:${body.get("grant_type") ?? ""}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/userinfo") {
        res.end(JSON.stringify({ sub: "local-google-owner", email, email_verified: true }));
      } else if (req.url === "/token") {
        res.end(
          JSON.stringify(
            body.get("grant_type") === "authorization_code"
              ? {
                  access_token: "dummy-connect-token",
                  refresh_token: "dummy-refresh-token",
                  expires_in: 3600,
                }
              : { access_token: "dummy-command-token", expires_in: 3600 },
          ),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }),
  );
  const oauth = new GwsOAuthService(
    {
      GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "local-client",
      GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "local-client-secret",
      GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://thor.example.test",
      GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
      GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
      GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
      SLACK_TEAM_ID: "T123",
    },
    {
      authorizationEndpoint: `${providerUrl}/auth`,
      tokenEndpoint: `${providerUrl}/token`,
      userInfoEndpoint: `${providerUrl}/userinfo`,
    },
  );
  const executions: Array<{ args: string[]; token: string }> = [];
  const remote = createRemoteCliApp({
    env: {
      port: 3004,
      nodeEnv: "test",
      slackBotToken: "xoxb-fixture",
      slackApiBaseUrl: `${slackUrl}/`,
      thorInternalSecret: internalSecret,
      githubAppId: "fixture",
      githubAppSlug: "fixture",
      githubAppBotId: "12345",
      githubAppPrivateKeyFile: join(root, "unused.pem"),
      gitIdentityName: "thor",
      gitIdentityEmail: "thor@example.test",
    },
    configLoader: () => ({
      users: [
        { email: "jira-only@example.test", name: "Owner", slack: owner },
        {
          email: "other@example.test",
          name: "Other",
          slack: other,
          google_workspace_email: "other@example.test",
        },
      ],
    }),
    gwsOAuth: oauth,
    gws: {
      execute: async (args, token) => {
        executions.push({ args: [...args], token: token.reveal() });
        return { status: 200, result: { stdout: "private-gws-output", stderr: "", exitCode: 0 } };
      },
    },
    mcp: { approvalsDir: join(root, "approvals"), writeToolCallLogFn: () => {} },
  });
  cleanup.push(remote.close);
  const remoteRequests: Array<{
    session?: string;
    call?: string;
    actor: ReturnType<typeof findActiveSlackTriggerActor>;
  }> = [];
  // Record attribution at the HTTP boundary without replacing application behavior.
  const remoteUrl = await listen(
    createServer((req, res) => {
      if (req.url === "/exec/gws" || req.url === "/exec/approval") {
        const session =
          typeof req.headers["x-thor-session-id"] === "string"
            ? req.headers["x-thor-session-id"]
            : undefined;
        const call =
          typeof req.headers["x-thor-call-id"] === "string"
            ? req.headers["x-thor-call-id"]
            : undefined;
        remoteRequests.push({ session, call, actor: findActiveSlackTriggerActor(session ?? "") });
      }
      remote.app(req, res);
    }),
  );
  const executor = createPiExecutorService({
    shellEnvironment: {
      PATH: process.env.PATH,
      HOME: root,
      THOR_REMOTE_CLI_URL: remoteUrl,
    },
  });
  cleanup.push(executor.dispose);
  const executorUrl = await listen(executor.server);
  const executorRequests: PiExecutionRequest[] = [];
  const proxyUrl = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = piExecutionRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      executorRequests.push(structuredClone(payload));
      // Only the executor's filesystem namespace is translated; identity remains /workspace/....
      payload.cwd = root;
      if (payload.operation.type === "exec" && payload.operation.options?.cwd === triggerDirectory)
        payload.operation.options.cwd = root;
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      try {
        const response = await fetch(`${executorUrl}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        res.writeHead(response.status, {
          "content-type": response.headers.get("content-type") ?? "application/json",
        });
        if (response.body) for await (const chunk of response.body) res.write(chunk);
        res.end();
      } catch {
        res.destroy();
      }
    }),
  );
  const modelRequests: Array<Record<string, unknown>> = [];
  let nextCommand: string | undefined;
  let retrieveOnReentry = false;
  const modelUrl = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString());
      modelRequests.push(payload);
      let requestedCommand = nextCommand;
      if (retrieveOnReentry) {
        retrieveOnReentry = false;
        // The provider chooses its tool arguments from the newly delivered approval prompt.
        const latestUser = Array.isArray(payload.input)
          ? payload.input.findLast((item) => item.role === "user")
          : undefined;
        const prompt = JSON.stringify(latestUser);
        expect(prompt).toContain(`Reviewer: <@${owner}>`);
        const retrieval = prompt.match(/approval result ([A-Za-z0-9-]+) ([A-Za-z0-9_-]+)/);
        if (!retrieval?.[1] || !retrieval[2])
          throw new Error("Pi GWS fixture reentry result capability missing");
        const resultArgs = ["result", retrieval[1], retrieval[2]];
        requestedCommand = `${command("approval", ["result", retrieval[1], "wrong-capability-that-is-long-enough"])}; ${command("approval", resultArgs)}; ${command("approval", resultArgs)}`;
      }
      nextCommand = undefined;
      respond(
        res,
        requestedCommand ? { command: requestedCommand } : { text: "fixture settled" },
        modelRequests.length,
      );
    }),
  );
  const opened = await createPiRunnerApp(
    {
      internalSecret,
      executorUrl: proxyUrl,
      modelBaseUrl: `${modelUrl}/v1`,
      modelId: "fixture-model",
      modelApiKey: "fixture-only",
      modelContextWindow: 65536,
      storagePath: join(root, "pi.sqlite"),
      skillsDir: join(root, "skills"),
      memoryDir: join(root, "memory"),
    },
    {
      remoteCliUrl: remoteUrl,
      progressTransport: {
        async post() {
          return { ts: "1710000000.200" };
        },
        async update() {},
        async delete() {},
        async addReaction() {},
      },
    },
  );
  if (!opened.ok) throw new Error(opened.error);
  cleanup.push(opened.close);
  const runnerUrl = await listen(createServer(opened.app));
  const trigger = async (body: object) => {
    const response = await fetch(`${runnerUrl}/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thor-internal-secret": internalSecret },
      body: JSON.stringify({ directory: triggerDirectory, correlationKey, ...body }),
    });
    expect(response.status).toBe(200);
    return response;
  };
  const stream = async (body: object) => {
    const response = await trigger({ ...body, stream: true });
    const frames: Array<Record<string, unknown>> = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "completed" });
    return frames;
  };
  // A real Pi GWS tool call with no Google pin must initiate private OAuth onboarding.
  nextCommand = command("gws", ["drive", "files", "list"]);
  await stream({ prompt: "warmup", requestId: "warmup", triggerSlackId: owner });
  expect(JSON.stringify(modelRequests[0]?.input)).toContain("no stored connection was found");
  const receipt = await (
    await trigger({ prompt: "warmup", requestId: "warmup", triggerSlackId: owner })
  ).json();
  for (const aliasType of ["opencode.session", "pi.conversation"]) {
    expect(resolveAlias({ aliasType, aliasValue: receipt.sessionId })).toBe(receipt.anchorId);
  }
  const privateDm = slackRequests
    .map((body) => JSON.parse(body))
    .find((body) => body.channel === owner && body.text.includes("Connect Google Workspace"));
  expect(privateDm).toBeDefined();
  expect(privateDm.thread_ts).toBeUndefined();
  const privateLink = /<(https:\/\/[^|]+)\|Connect Google Workspace>/.exec(privateDm.text)?.[1];
  if (!privateLink) throw new Error("Pi GWS fixture DM link missing");
  expect(JSON.stringify(modelRequests)).not.toContain(privateLink);
  expect(executions).toHaveLength(0);
  const browserHeaders = { "x-thor-internal-secret": internalSecret };
  const staged = await fetch(privateLink.replace("https://thor.example.test", remoteUrl), {
    redirect: "manual",
    headers: browserHeaders,
  });
  expect(staged.status).toBe(302);
  const requestCookie = staged.headers.get("set-cookie")?.split(";")[0];
  if (!requestCookie) throw new Error("Pi GWS fixture connect cookie missing");
  const preview = await fetch(`${remoteUrl}/google-workspace/connect/authorize`, {
    redirect: "manual",
    headers: { ...browserHeaders, cookie: requestCookie, "x-vouch-user": email },
  });
  expect(preview.status).toBe(200);
  const confirmation = await preview.text();
  expect(confirmation).toContain(owner);
  expect(confirmation).toContain(email);
  const csrf = /name="csrf" value="([^"]+)"/.exec(confirmation)?.[1];
  if (!csrf) throw new Error("Pi GWS fixture confirmation proof missing");
  const wrongBrowser = await fetch(`${remoteUrl}/google-workspace/connect/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { ...browserHeaders, cookie: requestCookie, "x-vouch-user": "another@example.test" },
    body: new URLSearchParams({ csrf }),
  });
  expect(wrongBrowser.status).toBe(400);
  const authorized = await fetch(`${remoteUrl}/google-workspace/connect/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { ...browserHeaders, cookie: requestCookie, "x-vouch-user": email },
    body: new URLSearchParams({ csrf }),
  });
  expect(authorized.status).toBe(302);
  expect(new URL(authorized.headers.get("location") ?? "").searchParams.get("login_hint")).toBe(
    email,
  );
  const state = new URL(authorized.headers.get("location") ?? "").searchParams.get("state");
  const browserCookie = authorized.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${GWS_OAUTH_BROWSER_COOKIE}=`))
    ?.split(";")[0];
  if (!state || !browserCookie) throw new Error("Pi GWS fixture authorization evidence missing");
  const connected = await fetch(
    `${remoteUrl}/google-workspace/oauth/callback?state=${state}&code=dummy-code`,
    { headers: { ...browserHeaders, cookie: browserCookie } },
  );
  expect(connected.status).toBe(200);
  expect(oauth.findConnectedIdentity(owner, email).ok).toBe(true);

  const args = ["drive", "files", "update", "--json", '{"name":"private title"}'];
  nextCommand = command("gws", args);
  await stream({ prompt: "request GWS change", requestId: "gws", triggerSlackId: owner });
  expect(JSON.stringify(modelRequests.at(-1)?.input)).toContain(
    "a stored connection is present, freshly checked for this turn",
  );
  expect(JSON.stringify(modelRequests)).not.toContain(internalSecret);
  const gwsReceipt = await (
    await trigger({ prompt: "request GWS change", requestId: "gws", triggerSlackId: owner })
  ).json();
  // The actual model tool result contains the public approval event, not a manufactured action.
  const lastInput = modelRequests.at(-1)?.input;
  if (!Array.isArray(lastInput)) throw new Error("Pi GWS fixture Responses input missing");
  const toolOutput = lastInput.find(
    (item) =>
      item.type === "function_call_output" && String(item.output).includes("approval_required"),
  );
  if (!toolOutput) throw new Error("Pi GWS fixture approval tool output missing");
  const event = ApprovalRequiredEventPayloadSchema.parse(JSON.parse(String(toolOutput.output)));
  expect(event).toMatchObject({
    tool: "google_workspace_command",
    args: { slack_user_id: owner, google_workspace_email: email },
  });
  expect(executions).toHaveLength(0);
  expect(slackRequests.join("\n")).not.toContain("private title");
  const approvalCard = slackRequests.find((body) => body.includes(event.actionId));
  if (!approvalCard) throw new Error("Pi GWS fixture Slack approval card missing");
  expect(JSON.parse(approvalCard)).toMatchObject({ channel: "C123", thread_ts: "1710000000.001" });
  expect(
    remoteRequests.find(
      (request) => request.actor.ok && request.actor.triggerId === gwsReceipt.triggerId,
    ),
  ).toMatchObject({
    session: receipt.sessionId,
    call: expect.stringContaining("call_gws_"),
    actor: { ok: true, slackUserId: owner, triggerId: gwsReceipt.triggerId },
  });
  expect(
    executorRequests.find((request) => request.operation.type === "exec")?.operation,
  ).toMatchObject({
    options: {
      inheritEnv: true,
      env: {
        THOR_OPENCODE_SESSION_ID: receipt.sessionId,
        THOR_OPENCODE_DIRECTORY: triggerDirectory,
        THOR_OPENCODE_CALL_ID: expect.stringContaining("call_gws_"),
      },
    },
  });
  expect(
    await resolveApproval(event.actionId, "approved", other, remoteUrl, internalSecret),
  ).toBeUndefined();
  expect(executions).toHaveLength(0);
  const approved = await resolveApproval(
    event.actionId,
    "approved",
    owner,
    remoteUrl,
    internalSecret,
  );
  expect(approved?.exitCode).toBe(0);
  if (!approved) throw new Error("Pi GWS fixture owner resolution missing");
  const resolution: { result_capability: string; status: string } = JSON.parse(approved.stdout);
  expect(resolution.status).toBe("completed");
  expect(executions).toEqual([{ args, token: "dummy-command-token" }]);
  expect(providerRequests).toContain("/token:refresh_token");
  const resultArgs = ["result", event.actionId, resolution.result_capability];
  nextCommand = `${command("approval", resultArgs)}; ${command("gws", args)}`;
  await stream({
    prompt: "other user cannot read owner output or reuse owner grant",
    requestId: "other",
    triggerSlackId: other,
  });
  const otherOutput = JSON.stringify(modelRequests.at(-1));
  expect(otherOutput).toContain(
    `Current Google Workspace status for Slack requester ${other}: no stored connection was found`,
  );
  expect(otherOutput).not.toContain("private-gws-output");
  expect(otherOutput).toContain("unavailable for this active Slack turn");
  expect(otherOutput).toContain("connection is required");
  expect(executions).toHaveLength(1);

  // Same dispatch service used by gateway's queued block-action handler, over real runner HTTP.
  const plan = await planBatchDispatch({
    requestId: "approval-reentry",
    slackEvents: [],
    cronEvents: [],
    githubEvents: [],
    approvalOutcomes: [
      {
        actionId: event.actionId,
        decision: "approved",
        reviewer: owner,
        channel: "C123",
        threadTs: "1710000000.001",
        upstreamName: "gws",
        tool: "google_workspace_command",
        resolutionStatus: resolution.status,
        resolutionExitCode: 0,
        resultCapability: resolution.result_capability,
      },
    ],
    correlationKey,
    triggerSlackId: owner,
    deps: { runnerUrl, internalSecret },
    slackDirectoryForChannel: () => ({ directory: triggerDirectory }),
  });
  if (plan.kind !== "dispatch") throw new Error(`Pi GWS fixture dispatch failed: ${plan.kind}`);
  expect(plan.options.prompt).toContain(
    `approval result ${event.actionId} ${resolution.result_capability}`,
  );
  retrieveOnReentry = true;
  expect(await executeBatchDispatchPlan(plan)).toEqual({ busy: false });
  const reentry = await stream({
    prompt: plan.options.prompt,
    requestId: "approval-reentry",
    triggerSlackId: owner,
  });
  expect(reentry[0]).toMatchObject({ sessionId: receipt.sessionId, resumed: true });
  const resultOutput = JSON.stringify(modelRequests.at(-1));
  expect(resultOutput).toContain("private-gws-output");
  expect(resultOutput.match(/private-gws-output/g)).toHaveLength(1);
  expect(resultOutput.match(/unavailable for this approval capability/g)).toHaveLength(2);
  expect(findTriggerActor(receipt.sessionId)).toEqual({ slack: owner });
  const reentryReceipt = await (
    await trigger({
      prompt: plan.options.prompt,
      requestId: "approval-reentry",
      triggerSlackId: owner,
    })
  ).json();
  expect(reentryReceipt.triggerId).not.toBe(gwsReceipt.triggerId);
  const reentrySlice = readTriggerSlice(receipt.sessionId, reentryReceipt.triggerId);
  expect(reentrySlice).toMatchObject({ status: "completed" });
  if (!("notFound" in reentrySlice))
    expect(reentrySlice.records[0]).toMatchObject({ type: "trigger_start", triggerSlackId: owner });
  expect(
    remoteRequests.filter((request) => request.actor.ok && request.actor.slackUserId === owner)
      .length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    (await resolveApproval(event.actionId, "approved", owner, remoteUrl, internalSecret))?.exitCode,
  ).toBe(0);
  expect(executions).toHaveLength(1);

  const stale = await fetch(`${remoteUrl}/exec/gws`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-thor-session-id": receipt.sessionId,
    },
    body: JSON.stringify({ args }),
  });
  expect(stale.status).toBe(403);
  expect(ExecResultSchema.parse(await stale.json()).exitCode).toBe(1);
  nextCommand = command("gws", args);
  await stream({
    prompt: "cron must not inherit the previous Slack actor",
    requestId: "cron",
    correlationKey: "cron:gws-fixture",
    sessionId: receipt.sessionId,
  });
  expect(JSON.stringify(modelRequests.at(-1))).toContain("requires an active Slack-requested turn");
  expect(remoteRequests.at(-1)?.actor.ok).toBe(false);
  expect(executions).toHaveLength(1);
  expect(JSON.stringify(modelRequests)).not.toContain("dummy-command-token");
  expect(JSON.stringify(executorRequests)).not.toContain(internalSecret);
}, 30_000);
