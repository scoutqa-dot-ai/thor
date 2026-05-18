import {
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
