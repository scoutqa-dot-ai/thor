// Isolated fake Google discovery/OAuth/API server. Credentials are generated
// inside the disposable remote-cli container and have no access to Google.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { appendAlias, appendSessionEvent } from "/app/packages/common/src/index.ts";
import {
  createRemoteCliApp,
  GwsOAuthService,
  GwsService,
} from "/app/packages/remote-cli/dist/index.js";

const configDir = "/var/lib/remote-cli/gws";
const oauthStorageDir = "/var/lib/remote-cli/google-workspace-oauth-fixture";
await mkdir(`${configDir}/cache`, { recursive: true, mode: 0o700 });
process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = configDir;
process.env.GOOGLE_WORKSPACE_PROJECT_ID = "thor-fixture";
process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID = "fixture-client-id";
process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "fixture-client-secret";
process.env.GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL = "https://thor.fixture.invalid";
process.env.GOOGLE_WORKSPACE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
].join(",");
process.env.GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR = oauthStorageDir;
process.env.SLACK_TEAM_ID = "T123FIXTURE";
process.env.SLACK_BOT_TOKEN = "xoxb-fixture";
process.env.THOR_INTERNAL_SECRET = "fixture-internal-secret";
process.env.WORKLOG_DIR = "/tmp/thor-gws-worklogs";
Object.assign(process.env, {
  DRATA_OAUTH_TOKEN_URL: "http://127.0.0.1:3100/drata-token",
  DRATA_CLIENT_ID: "fixture-drata-id",
  DRATA_CLIENT_SECRET: "fixture-drata-secret",
  DRATA_AUDIENCE: "fixture-drata-api",
  DRATA_SCOPES: "fixture:access",
  DRATA_API_BASE_URL: "http://127.0.0.1:3100",
});

// Model an agent-controlled shared workspace on the server side too. Running
// gws there instead of in private storage would load this hostile dotenv.
await writeFile("/workspace/.env", "GOOGLE_WORKSPACE_CLI_TOKEN=attacker-token\n");

const pathParam = { type: "string", location: "path", required: true };
const queryParam = { type: "string", location: "query" };
const method = (id, path, parameters, extra = {}) => ({
  id,
  path,
  httpMethod: "GET",
  parameters,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  ...extra,
});
const sheetParams = { spreadsheetId: pathParam };
const descriptions = {
  drive: {
    version: "v3",
    resources: {
      files: {
        methods: {
          list: method("drive.files.list", "drive/v3/files", {
            pageToken: queryParam,
            pageSize: { ...queryParam, type: "integer" },
            fields: queryParam,
            q: queryParam,
          }),
          get: method("drive.files.get", "drive/v3/files/{fileId}", {
            fileId: pathParam,
            fields: queryParam,
          }),
        },
      },
    },
  },
  docs: {
    version: "v1",
    schemas: { Document: { type: "object", properties: { title: { type: "string" } } } },
    resources: {
      documents: {
        methods: {
          create: method(
            "docs.documents.create",
            "v1/documents",
            {},
            {
              httpMethod: "POST",
              request: { $ref: "Document" },
              scopes: ["https://www.googleapis.com/auth/documents"],
            },
          ),
          get: method("docs.documents.get", "v1/documents/{documentId}", {
            documentId: pathParam,
            includeTabsContent: { ...queryParam, type: "boolean" },
          }),
        },
      },
    },
  },
  sheets: {
    version: "v4",
    schemas: {
      ReadFilter: { type: "object", properties: { includeGridData: { type: "boolean" } } },
    },
    resources: {
      spreadsheets: {
        methods: {
          get: method("sheets.spreadsheets.get", "v4/spreadsheets/{spreadsheetId}", sheetParams),
          getByDataFilter: method(
            "sheets.spreadsheets.getByDataFilter",
            "v4/spreadsheets/{spreadsheetId}:getByDataFilter",
            sheetParams,
            { httpMethod: "POST", request: { $ref: "ReadFilter" } },
          ),
        },
        resources: {
          values: {
            methods: {
              get: method(
                "sheets.spreadsheets.values.get",
                "v4/spreadsheets/{spreadsheetId}/values/{range}",
                { ...sheetParams, range: pathParam },
              ),
              batchGet: method(
                "sheets.spreadsheets.values.batchGet",
                "v4/spreadsheets/{spreadsheetId}/values:batchGet",
                { ...sheetParams, ranges: { ...queryParam, repeated: true } },
              ),
            },
          },
        },
      },
    },
  },
};
for (const [name, description] of Object.entries(descriptions)) {
  await writeFile(
    `${configDir}/cache/${name}_${description.version}.json`,
    JSON.stringify({
      name,
      title: `Fixture ${name}`,
      rootUrl: "http://127.0.0.1:3100/",
      ...description,
    }),
  );
}

const requests = [];
let authorizationTokenRequests = 0;
let tokenRequests = 0;
let drataTokenRequests = 0;
const drataRequests = [];
const upstream = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url, "http://fixture");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/drata-token") {
      assert.equal(req.method, "POST");
      assert.equal(JSON.parse(body).client_secret, "fixture-drata-secret");
      drataTokenRequests++;
      res.end(JSON.stringify({ access_token: "fixture-drata-token", expires_in: 3600 }));
      return;
    }
    if (url.pathname.startsWith("/drata-fixture/")) {
      assert.equal(req.headers.authorization, "Bearer fixture-drata-token");
      drataRequests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname.endsWith("/denied")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Drata fixture permission denied" }));
      } else if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
      } else {
        res.end(JSON.stringify({ method: req.method, data: body ? JSON.parse(body) : null }));
      }
      return;
    }
    if (url.pathname === "/token") {
      assert.equal(req.method, "POST");
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "fixture-client-id");
      assert.equal(form.get("client_secret"), "fixture-client-secret");
      if (form.get("grant_type") === "authorization_code") {
        authorizationTokenRequests++;
        assert.equal(form.get("code"), "fixture-authorization-code");
        assert.ok(form.get("code_verifier"));
        res.end(
          JSON.stringify({
            access_token: "fixture-authorization-access-token",
            refresh_token: "fixture-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return;
      }
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fixture-refresh-token");
      tokenRequests++;
      res.end(
        JSON.stringify({
          access_token: "fixture-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }
    if (url.pathname === "/userinfo") {
      assert.ok(
        ["Bearer fixture-authorization-access-token", "Bearer fixture-access-token"].includes(
          req.headers.authorization,
        ),
      );
      res.end(
        JSON.stringify({
          sub: "fixture-google-subject",
          email: "person@example.com",
          email_verified: true,
        }),
      );
      return;
    }
    assert.equal(req.headers.authorization, "Bearer fixture-access-token");
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    if (url.pathname === "/drive/v3/files/missing") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 404, message: "Fixture file not found" } }));
    } else if (url.pathname === "/drive/v3/files") {
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      res.end(
        JSON.stringify({
          files: [{ id: `file-${page}`, name: "Fixture report" }],
          nextPageToken: String(page + 1),
        }),
      );
    } else if (url.pathname === "/v1/documents") {
      assert.equal(req.method, "POST");
      const document = JSON.parse(body);
      if (document.title === "Denied") {
        res.statusCode = 403;
        res.end(
          JSON.stringify({ error: { code: 403, message: "Fixture write permission denied" } }),
        );
      } else {
        res.end(JSON.stringify({ documentId: "created-document", title: document.title }));
      }
    } else if (url.pathname.startsWith("/v1/documents/")) {
      res.end(
        JSON.stringify({
          documentId: "doc-id",
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    {
                      paragraph: {
                        elements: [{ textRun: { content: "Fixture document text\n" } }],
                      },
                    },
                  ],
                },
              },
            },
          ],
        }),
      );
    } else if (url.pathname.endsWith("/values:batchGet")) {
      res.end(
        JSON.stringify({
          spreadsheetId: "sheet-id",
          valueRanges: url.searchParams
            .getAll("ranges")
            .map((range) => ({ range, values: [["Fixture", 42]] })),
        }),
      );
    } else if (url.pathname.includes("/values/")) {
      res.end(JSON.stringify({ range: "Sheet1!A1:B2", values: [["Fixture", 42]] }));
    } else if (url.pathname.endsWith(":getByDataFilter")) {
      assert.equal(req.method, "POST");
      assert.deepEqual(JSON.parse(body), { includeGridData: true });
      res.end(JSON.stringify({ spreadsheetId: "sheet-id", sheets: [] }));
    } else {
      throw new Error(`Unexpected fixture request: ${req.method} ${url.pathname}`);
    }
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { code: 500, message: error.message } }));
  }
});
upstream.listen(3100, "127.0.0.1");
await once(upstream, "listening");

const gwsOAuth = new GwsOAuthService(process.env, {
  authorizationEndpoint: "http://127.0.0.1:3100/authorize",
  tokenEndpoint: "http://127.0.0.1:3100/token",
  userInfoEndpoint: "http://127.0.0.1:3100/userinfo",
});
const owner = {
  slackUserId: "U123FIXTURE",
  expectedGoogleEmail: "person@example.com",
  sessionId: "fixture-session",
  anchorId: "019d0000-0000-7000-8000-000000000001",
  triggerId: "019d0000-0000-7000-8000-000000000002",
};
const connectionRequest = gwsOAuth.createConnectionRequest(owner);
assert.equal(connectionRequest.ok, true);
const authorization = gwsOAuth.beginAuthorization(
  connectionRequest.value.requestId,
  owner.expectedGoogleEmail,
);
assert.equal(authorization.ok, true);
const state = new URL(authorization.value.authorizationUrl).searchParams.get("state");
assert.ok(state);
const connection = await gwsOAuth.completeAuthorization({
  state,
  code: "fixture-authorization-code",
  browserNonce: authorization.value.browserNonce,
});
assert.equal(connection.ok, true);

appendAlias({
  aliasType: "opencode.session",
  aliasValue: owner.sessionId,
  anchorId: owner.anchorId,
});
appendAlias({
  aliasType: "slack.thread",
  aliasValue: "C123FIXTURE/1710000000.001",
  anchorId: owner.anchorId,
});
appendSessionEvent(owner.sessionId, {
  type: "trigger_start",
  triggerId: owner.triggerId,
  triggerSlackId: owner.slackUserId,
  correlationKey: "slack:thread:C123FIXTURE/1710000000.001",
});

const slackFetch = async (input, init) => {
  if (String(input).includes("/users.info")) {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xoxb-fixture");
    return Response.json({
      ok: true,
      user: {
        id: owner.slackUserId,
        team_id: "T123FIXTURE",
        deleted: false,
        is_bot: false,
        profile: { email: owner.expectedGoogleEmail },
      },
    });
  }
  return Response.json({ ok: true, channel: "C123FIXTURE", ts: "1710000000.100" });
};
const workspaceConfig = {
  users: [
    {
      email: "jira-only@example.com",
      name: "Fixture Person",
      slack: owner.slackUserId,
    },
  ],
};
const remoteCli = createRemoteCliApp({
  env: {
    port: 3004,
    nodeEnv: "test",
    slackBotToken: "xoxb-fixture",
    slackApiBaseUrl: "http://slack.fixture.invalid/api",
    thorInternalSecret: "fixture-internal-secret",
  },
  configLoader: () => workspaceConfig,
  gws: new GwsService(process.env, { discoveryCacheSeedDir: `${configDir}/cache` }),
  gwsOAuth,
  mcp: {
    approvalsDir: "/tmp/thor-gws-approvals",
    fetchImpl: slackFetch,
    writeToolCallLogFn: () => {},
  },
});
remoteCli.app.get("/fixture-state", (_req, res) =>
  res.json({
    requests,
    authorizationTokenRequests,
    tokenRequests,
    drataRequests,
    drataTokenRequests,
  }),
);
remoteCli.app.post("/fixture-approve", async (req, res) => {
  const actionId = req.body?.actionId;
  assert.equal(typeof actionId, "string");
  const resolution = await fetch("http://127.0.0.1:3004/exec/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-thor-internal-secret": "fixture-internal-secret",
    },
    body: JSON.stringify({ args: ["resolve", actionId, "approved", owner.slackUserId] }),
  });
  const resolutionResult = await resolution.json();
  let summary;
  try {
    summary = JSON.parse(resolutionResult.stdout);
  } catch {
    summary = undefined;
  }
  if (summary?.result_available === true) {
    assert.equal(typeof summary.result_capability, "string");
    const status = await fetch("http://127.0.0.1:3004/exec/approval", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-thor-session-id": owner.sessionId,
      },
      body: JSON.stringify({
        args: ["result", actionId, summary.result_capability],
      }),
    });
    res.status(status.status).send(await status.text());
    return;
  }
  res.status(resolution.status).json(resolutionResult);
});
createServer(remoteCli.app).listen(3004, "0.0.0.0");
