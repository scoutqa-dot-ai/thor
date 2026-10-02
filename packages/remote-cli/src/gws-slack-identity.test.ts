import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAlias, appendSessionEvent, type UserRecord } from "@thor/common";
import { GwsSlackIdentityService } from "./gws-slack-identity.js";

const slackUserId = "U123";
const googleEmail = "person@example.com";
const anchorId = "019d0000-0000-7000-8000-000000000001";
const triggerId = "019d0000-0000-7000-8000-000000000002";
const member = {
  id: slackUserId,
  team_id: "T123",
  deleted: false,
  is_bot: false,
  profile: { email: googleEmail },
};
let root: string;
let server: Server;
let identity: GwsSlackIdentityService;
let users: UserRecord[];
let responseBody: unknown;
let status: number;
let lookups: number;
let endDuringLookup: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thor-gws-slack-identity-"));
  vi.stubEnv("WORKLOG_DIR", join(root, "worklog"));
  users = [];
  responseBody = { ok: true, user: member };
  status = 200;
  lookups = 0;
  endDuringLookup = false;
  server = createServer((req, res) => {
    lookups++;
    expect(new URL(req.url ?? "", "http://fixture").searchParams.get("user")).toBe(slackUserId);
    expect(req.headers.authorization).toBe("Bearer fixture-bot-token");
    if (endDuringLookup)
      appendSessionEvent("identity-session", {
        type: "trigger_end",
        triggerId,
        status: "completed",
        durationMs: 1,
      });
    res.writeHead(status, {
      "content-type": "application/json",
      ...(status === 302 ? { location: "http://127.0.0.1:1/must-not-follow" } : {}),
    });
    res.end(JSON.stringify(responseBody));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("GWS identity fixture listener missing");
  identity = new GwsSlackIdentityService({
    configLoader: () => ({ users }),
    slackTeamId: "T123",
    botToken: "fixture-bot-token",
    apiBaseUrl: `http://127.0.0.1:${address.port}/`,
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function startTurn() {
  appendAlias({ aliasType: "opencode.session", aliasValue: "identity-session", anchorId });
  appendSessionEvent("identity-session", {
    type: "trigger_start",
    triggerId,
    triggerSlackId: slackUserId,
    correlationKey: "slack:thread:C123/1710000000.001",
  });
}

describe("Google identity from trusted Slack member profiles", () => {
  it("onboards a member without a directory entry and never uses a Jira email", async () => {
    startTurn();
    expect(await identity.resolveActiveUser("identity-session")).toMatchObject({
      ok: true,
      slackUserId,
      triggerId,
      googleWorkspaceEmail: googleEmail,
    });
    users = [{ slack: slackUserId, email: "jira-only@example.com", name: "Person" }];
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: true,
      googleWorkspaceEmail: googleEmail,
    });
    expect(lookups).toBe(2);
    expect(JSON.stringify(identity)).not.toContain("fixture-bot-token");
  });

  it("keeps an explicit Google pin authoritative without a Slack lookup", async () => {
    users = [
      {
        slack: slackUserId,
        email: "jira@example.com",
        name: "Person",
        google_workspace_email: "pinned@example.com",
      },
    ];
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: true,
      googleWorkspaceEmail: "pinned@example.com",
    });
    expect(lookups).toBe(0);
  });

  it.each([
    ["missing scope", { ok: false, error: "missing_scope" }],
    ["missing email", { ok: true, user: { ...member, profile: {} } }],
    ["different user", { ok: true, user: { ...member, id: "UOTHER" } }],
    ["different workspace", { ok: true, user: { ...member, team_id: "TOTHER" } }],
    ["deleted member", { ok: true, user: { ...member, deleted: true } }],
    ["bot", { ok: true, user: { ...member, is_bot: true } }],
    ["app user", { ok: true, user: { ...member, is_app_user: true } }],
    ["external stranger", { ok: true, user: { ...member, is_stranger: true } }],
  ])("rejects %s instead of inferring or accepting another identity", async (_label, body) => {
    responseBody = body;
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: false,
      reason: "slack_identity_unavailable",
    });
  });

  it("never follows a redirect with the bot credential", async () => {
    status = 302;
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: false,
      reason: "slack_identity_unavailable",
    });
    expect(lookups).toBe(1);
  });

  it("rejects ambiguous config and an implicit email pinned to another member", async () => {
    users = [
      { slack: slackUserId, email: "first@example.com", name: "First" },
      { slack: slackUserId, email: "second@example.com", name: "Second" },
    ];
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: false,
      reason: "user_ambiguous",
    });
    expect(lookups).toBe(0);
    users = [
      { slack: "UOTHER", email: googleEmail, name: "Other", google_workspace_email: googleEmail },
    ];
    expect(await identity.resolveGoogleEmail(slackUserId)).toEqual({
      ok: false,
      reason: "google_email_ambiguous",
    });
  });

  it("does not authorize a turn that ends while Slack identity lookup is in flight", async () => {
    startTurn();
    endDuringLookup = true;
    expect(await identity.resolveActiveUser("identity-session")).toEqual({
      ok: false,
      reason: "no_active_slack_trigger",
    });
  });
});
