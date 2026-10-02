import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAlias, appendSessionEvent, type UserRecord } from "@thor/common";
import { GwsSlackIdentityService } from "./gws-slack-identity.js";

const anchorId = "019d0000-0000-7000-8000-000000000001";
const triggerId = "019d0000-0000-7000-8000-000000000002";
let root: string;
let users: UserRecord[];
let identity: GwsSlackIdentityService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thor-gws-slack-requester-"));
  vi.stubEnv("WORKLOG_DIR", join(root, "worklog"));
  users = [];
  identity = new GwsSlackIdentityService(() => ({ users }));
  appendAlias({ aliasType: "opencode.session", aliasValue: "identity-session", anchorId });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function startTurn(slackUserId = "U123") {
  appendSessionEvent("identity-session", {
    type: "trigger_start",
    triggerId,
    triggerSlackId: slackUserId,
    correlationKey: "slack:thread:C123/1710000000.001",
  });
}

it("admits the trusted requester without a directory entry, Google pin, Slack token or profile email", () => {
  startTurn();
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: true,
    slackUserId: "U123",
    triggerId,
    anchorId,
  });
  users = [{ slack: "U123", email: "jira-only@example.com", name: "Person" }];
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: true,
    googleEmailPin: undefined,
  });
});
it("selects the latest human requester rather than a previous thread participant", () => {
  startTurn();
  appendSessionEvent("identity-session", {
    type: "trigger_end",
    triggerId,
    status: "completed",
    durationMs: 1,
  });
  startTurn("U999");
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: true,
    slackUserId: "U999",
  });
});
it("rejects missing or completed turns", () => {
  expect(identity.resolveActiveRequester(undefined)).toMatchObject({
    ok: false,
    reason: "missing_session",
  });
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({ ok: false });
  startTurn();
  appendSessionEvent("identity-session", {
    type: "trigger_end",
    triggerId,
    status: "completed",
    durationMs: 1,
  });
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: false,
    reason: "no_active_slack_trigger",
  });
});
it("retains explicit pins and rejects ambiguous restrictions", () => {
  startTurn();
  users = [
    {
      slack: "U123",
      email: "jira@example.com",
      name: "Person",
      google_workspace_email: "pinned@example.com",
    },
  ];
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: true,
    googleEmailPin: "pinned@example.com",
  });
  users.push({
    slack: "U999",
    email: "other@example.com",
    name: "Other",
    google_workspace_email: "pinned@example.com",
  });
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: false,
    reason: "google_email_ambiguous",
  });
  users = [
    { slack: "U123", email: "first@example.com", name: "First" },
    { slack: "U123", email: "second@example.com", name: "Second" },
  ];
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: false,
    reason: "user_ambiguous",
  });
});
it("fails closed when operator restrictions cannot be loaded", () => {
  startTurn();
  identity = new GwsSlackIdentityService(() => {
    throw new Error("fixture config failure");
  });
  expect(identity.resolveActiveRequester("identity-session")).toMatchObject({
    ok: false,
    reason: "config_unavailable",
  });
});
