// Isolated fake Google discovery/OAuth/API server. Credentials are generated
// inside the disposable remote-cli container and have no access to Google.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRemoteCliApp } from "/app/packages/remote-cli/dist/index.js";

const configDir = "/var/lib/remote-cli/gws";
await mkdir(`${configDir}/cache`, { recursive: true, mode: 0o700 });
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const credentialsFile = `${configDir}/fixture-credentials.json`;
await writeFile(
  credentialsFile,
  JSON.stringify({
    type: "service_account",
    project_id: "thor-fixture",
    private_key_id: "fixture",
    private_key: privateKey,
    client_email: "fixture@example.invalid",
    client_id: "1",
    token_uri: "http://127.0.0.1:3100/token",
  }),
  { mode: 0o600 },
);
process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialsFile;
process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = configDir;
process.env.GOOGLE_WORKSPACE_PROJECT_ID = "thor-fixture";

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
    resources: {
      documents: {
        methods: {
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
let tokenRequests = 0;
const upstream = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url, "http://fixture");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/token") {
      assert.equal(req.method, "POST");
      assert.equal(
        new URLSearchParams(body).get("grant_type"),
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
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
const remoteCli = createRemoteCliApp();
remoteCli.app.get("/fixture-state", (_req, res) => res.json({ requests, tokenRequests }));
createServer(remoteCli.app).listen(3004, "0.0.0.0");
