import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPiExecutorService } from "@thor/pi-executor/service";
import { piExecutionRequestSchema, type PiExecutionRequest } from "@thor/pi-executor/protocol";
import {
  type ProgressEvent,
  ExecResultSchema,
  findActiveSlackTriggerActor,
  findTriggerActor,
  readTriggerSlice,
  resolveAlias,
} from "@thor/common";
import { createPiRunnerApp } from "./pi-runner.js";
import { createRemoteCliApp } from "../../remote-cli/src/index.js";
import { GWS_OAUTH_BROWSER_COOKIE, GwsOAuthService } from "../../remote-cli/src/gws-oauth.js";

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

function respond(
  res: ServerResponse,
  content:
    | { text: string }
    | { command: string }
    | { profile: "balanced" | "strong"; reason: string },
  id: number,
) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const emit = (event: object) =>
    res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  emit({ type: "response.created", response: { id: `resp_${id}` } });
  if ("command" in content || "profile" in content) {
    const item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_gws_${id}`,
      name: "command" in content ? "bash" : "escalate_model",
      arguments: JSON.stringify(
        "command" in content ? { command: content.command, timeout: 10 } : content,
      ),
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

it.each([true, false])(
  "automatically continues after private OAuth only with confirmed DM delivery (%s)",
  async (dmConfirmed) => {
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
            channel: message.channel.startsWith("U") && dmConfirmed ? "D123" : "C123",
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
        const payload = piExecutionRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        executorRequests.push(structuredClone(payload));
        // Only the executor's filesystem namespace is translated; identity remains /workspace/....
        payload.cwd = root;
        if (
          payload.operation.type === "exec" &&
          payload.operation.options?.cwd === triggerDirectory
        )
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
    let resumedOperation = false;
    const blockedArgs = ["drive", "files", "list"];
    const modelUrl = await listen(
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString());
        modelRequests.push(payload);
        if (modelRequests.length <= 2) {
          respond(
            res,
            {
              profile: modelRequests.length === 1 ? "balanced" : "strong",
              reason: "Need deeper Google task reasoning",
            },
            modelRequests.length,
          );
          return;
        }
        let requestedCommand = nextCommand;
        if (
          !resumedOperation &&
          JSON.stringify(payload).includes("Google authorization continuation:")
        ) {
          resumedOperation = true;
          requestedCommand = command("gws", blockedArgs);
        }
        nextCommand = undefined;
        respond(
          res,
          requestedCommand ? { command: requestedCommand } : { text: "fixture settled" },
          modelRequests.length,
        );
      }),
    );
    const progressEvents: ProgressEvent[] = [];
    const opened = await createPiRunnerApp(
      {
        internalSecret,
        slackTeamId: "T123",
        executorUrl: proxyUrl,
        modelBaseUrl: `${modelUrl}/v1`,
        modelId: "fixture-model",
        modelApiKey: "fixture-only",
        modelContextWindow: 65536,
        modelSupportsImages: true,
        storagePath: join(root, "pi.sqlite"),
        skillsDir: join(root, "skills"),
        memoryDir: join(root, "memory"),
      },
      {
        remoteCliUrl: remoteUrl,
        configLoader: () => ({
          pi: {
            modelRouting: {
              profiles: {
                fast: { modelId: "fixture-fast" },
                balanced: { modelId: "fixture-balanced" },
                strong: { modelId: "fixture-strong" },
              },
            },
          },
        }),
        progressEventSink: (event) => progressEvents.push(event),
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
      expect(frames.at(-1)).toMatchObject({
        type: "done",
        status: frames.at(-1)?.authWait ? "error" : "completed",
      });
      return frames;
    };
    // A real Pi GWS tool call with no Google pin must initiate private OAuth onboarding.
    nextCommand = `printf 'once\\n' >> compound-marker; ${command("gws", ["drive", "files", "list"])}`;
    const initialFrames = await stream({
      prompt: "warmup",
      routingTask: "Create a Google document",
      requestId: "warmup",
      triggerSlackId: owner,
    });
    expect(initialFrames.at(-1)?.authWait).toBe(dmConfirmed ? "google" : undefined);
    expect(JSON.stringify(modelRequests[0]?.input)).toContain("no stored connection was found");
    expect(modelRequests[0]).toMatchObject({ model: "fixture-fast", reasoning: { effort: "low" } });
    expect(modelRequests[1]).toMatchObject({
      model: "fixture-balanced",
      reasoning: { effort: "medium" },
    });
    expect(modelRequests[2]).toMatchObject({
      model: "fixture-strong",
      reasoning: { effort: "high" },
    });
    const receipt = await (
      await trigger({
        prompt: "warmup",
        routingTask: "Create a Google document",
        requestId: "warmup",
        triggerSlackId: owner,
      })
    ).json();
    for (const aliasType of ["opencode.session", "pi.conversation"]) {
      expect(resolveAlias({ aliasType, aliasValue: receipt.sessionId })).toBe(receipt.anchorId);
    }
    const waitHtml = await (
      await fetch(`${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`)
    ).text();
    expect(waitHtml.includes("Waiting for Google authorization")).toBe(dmConfirmed);
    if (dmConfirmed) expect(waitHtml).toContain("Google operation not completed");
    const privateDm = slackRequests
      .map((body) => JSON.parse(body))
      .find((body) => body.channel === owner && body.text.includes("Connect Google Workspace"));
    expect(privateDm).toBeDefined();
    expect(privateDm.text).toContain("account to Neo");
    expect(privateDm.text).not.toContain("account to Thor");
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
    if (!dmConfirmed) {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(executions).toHaveLength(0);
      expect(resumedOperation).toBe(false);
      expect(progressEvents.filter((event) => event.type === "done")).toHaveLength(1);
      return;
    }

    await vi.waitFor(
      () => expect(executions).toEqual([{ args: blockedArgs, token: "dummy-command-token" }]),
      { timeout: 5000 },
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(modelRequests.at(-1))).toContain("private-gws-output"),
    );
    await vi.waitFor(() =>
      expect(progressEvents.filter((event) => event.type === "done")).toHaveLength(2),
    );
    const resumeInput = JSON.stringify(
      modelRequests.find((input) =>
        JSON.stringify(input).includes("Google authorization continuation:"),
      ),
    );
    expect(
      modelRequests.find((input) =>
        JSON.stringify(input).includes("Google authorization continuation:"),
      ),
    ).toMatchObject({ model: "fixture-strong", reasoning: { effort: "high" } });
    expect(resumeInput).toContain("Current model profile strong");
    expect(resumeInput).toContain("warmup");
    expect(resumeInput).toContain("Continue only that original task");
    expect(resumeInput).toContain("never replay the compound bash command");
    expect(resumeInput).not.toContain(internalSecret);
    expect(JSON.stringify(modelRequests)).not.toContain("dummy-command-token");
    expect(slackRequests.join("\n")).not.toContain("approval_required");
    expect(findTriggerActor(receipt.sessionId)).toEqual({ slack: owner });
    expect(progressEvents.filter((event) => event.type === "start").at(-1)).toMatchObject({
      sessionId: receipt.sessionId,
      correlationKey,
      resumed: true,
    });
    expect(
      await (
        await fetch(`${remoteUrl}/internal/google-workspace/continuations`, {
          headers: browserHeaders,
        })
      ).json(),
    ).toEqual({ continuations: [] });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(executions).toHaveLength(1);
    expect(await readFile(join(root, "compound-marker"), "utf8")).toBe("once\n");
    const resumedHtml = await (
      await fetch(`${runnerUrl}/runner/v/${receipt.anchorId}/${receipt.triggerId}`)
    ).text();
    expect(resumedHtml).toContain("Google authorization continued");
    expect(resumedHtml).not.toContain("Waiting for Google authorization");
  },
  30_000,
);
