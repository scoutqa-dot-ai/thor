import {
  findActiveSlackTriggerActor,
  findTriggerActor,
  findUserByGithub,
  findUserBySlack,
  type ConfigLoader,
  type UserRecord,
} from "@thor/common";

export interface ResolvedTriggerUser {
  actor?: { slack?: string; github?: string };
  user?: UserRecord;
  reason?: string;
}

/** Active Slack user authorized to select a personal Google Workspace grant. */
export type ResolvedActiveSlackUser =
  | {
      readonly ok: true;
      readonly slackUserId: string;
      readonly anchorId: string;
      readonly triggerId: string;
      readonly sessionId: string;
      readonly googleWorkspaceEmail: string;
      readonly user: UserRecord;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "missing_session"
        | "no_active_slack_trigger"
        | "config_unavailable"
        | "user_unmapped"
        | "user_ambiguous"
        | "google_email_unconfigured"
        | "google_email_ambiguous";
    };

/** Resolve the active Slack turn and its explicitly configured Google account. */
export function resolveActiveSlackUser(
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): ResolvedActiveSlackUser {
  if (!sessionId) return { ok: false, reason: "missing_session" };
  const active = findActiveSlackTriggerActor(sessionId);
  if (!active.ok) return { ok: false, reason: "no_active_slack_trigger" };

  let config: ReturnType<ConfigLoader>;
  try {
    config = getConfig();
  } catch {
    return { ok: false, reason: "config_unavailable" };
  }
  const slackUsers =
    config.users?.filter(
      (candidate) => candidate.slack?.toUpperCase() === active.slackUserId.toUpperCase(),
    ) ?? [];
  if (slackUsers.length === 0) return { ok: false, reason: "user_unmapped" };
  if (slackUsers.length !== 1) return { ok: false, reason: "user_ambiguous" };
  const user = slackUsers[0];
  if (!user?.google_workspace_email) {
    return { ok: false, reason: "google_email_unconfigured" };
  }
  const googleEmail = user.google_workspace_email.toLowerCase();
  const googleUsers =
    config.users?.filter(
      (candidate) => candidate.google_workspace_email?.toLowerCase() === googleEmail,
    ) ?? [];
  if (googleUsers.length !== 1) return { ok: false, reason: "google_email_ambiguous" };
  return {
    ok: true,
    slackUserId: active.slackUserId,
    anchorId: active.anchorId,
    triggerId: active.triggerId,
    sessionId: active.sessionId,
    googleWorkspaceEmail: googleEmail,
    user,
  };
}

export function resolveTriggerUser(
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): ResolvedTriggerUser {
  if (!sessionId) return { reason: "skipped_no_trigger" };
  const actor = findTriggerActor(sessionId);
  if (!actor) return { reason: "skipped_no_trigger" };

  let config: ReturnType<ConfigLoader>;
  try {
    config = getConfig();
  } catch {
    return { actor, reason: "skipped_config_unavailable" };
  }
  const user =
    (actor.slack ? findUserBySlack(config, actor.slack) : undefined) ??
    (actor.github ? findUserByGithub(config, actor.github) : undefined);
  if (!user) return { actor, reason: "skipped_no_user_record" };
  return { actor, user };
}

export function attributionFields(
  actor?: { slack?: string; github?: string },
  user?: UserRecord,
): Record<string, string> {
  return {
    ...(actor?.slack ? { slack: actor.slack } : {}),
    ...(actor?.github ? { github: actor.github } : {}),
    ...(user?.email ? { email: user.email } : {}),
  };
}
