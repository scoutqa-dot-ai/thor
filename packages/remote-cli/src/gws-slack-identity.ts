import { findActiveSlackTriggerActor, type ConfigLoader } from "@thor/common";
import { z } from "zod";

const SlackProfileSchema = z.object({
  ok: z.literal(true),
  user: z.object({
    id: z.string().min(1),
    team_id: z.string().min(1),
    deleted: z.literal(false),
    is_bot: z.literal(false),
    is_app_user: z.boolean().optional(),
    is_stranger: z.boolean().optional(),
    profile: z.object({ email: z.email() }),
  }),
});

type IdentityFailure = {
  readonly ok: false;
  readonly reason:
    | "missing_session"
    | "no_active_slack_trigger"
    | "config_unavailable"
    | "user_ambiguous"
    | "google_email_ambiguous"
    | "slack_identity_unavailable";
};
/** Google account identity comes from an explicit operator pin or trusted Slack profile, never Jira email. */
export type GwsGoogleEmailResult =
  | { readonly ok: true; readonly googleWorkspaceEmail: string }
  | IdentityFailure;
/** Active turn evidence is rechecked after network lookup before creating an OAuth request or approval. */
export type GwsActiveSlackIdentity =
  | {
      readonly ok: true;
      readonly slackUserId: string;
      readonly sessionId: string;
      readonly anchorId: string;
      readonly triggerId: string;
      readonly googleWorkspaceEmail: string;
    }
  | IdentityFailure;

/** Owns Google identity selection for active Slack turns and consumed approval revalidation. */
export interface IGwsSlackIdentityService {
  resolveActiveUser(sessionId: string | undefined): Promise<GwsActiveSlackIdentity>;
  resolveGoogleEmail(slackUserId: string): Promise<GwsGoogleEmailResult>;
}

/** Resolves optional Google pins before falling back to same-workspace bot-authenticated Slack profiles. */
export class GwsSlackIdentityService implements IGwsSlackIdentityService {
  readonly #getConfig: ConfigLoader;
  readonly #teamId: string | undefined;
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(input: {
    configLoader: ConfigLoader;
    slackTeamId?: string;
    botToken?: string;
    apiBaseUrl?: string;
    fetch?: typeof fetch;
  }) {
    this.#getConfig = input.configLoader;
    this.#teamId = input.slackTeamId;
    this.#token = input.botToken;
    this.#baseUrl = input.apiBaseUrl ?? "https://slack.com/api";
    this.#fetch = input.fetch ?? fetch;
  }

  async resolveGoogleEmail(slackUserId: string): Promise<GwsGoogleEmailResult> {
    let config: ReturnType<ConfigLoader>;
    try {
      config = this.#getConfig();
    } catch {
      return { ok: false, reason: "config_unavailable" };
    }
    const users =
      config.users?.filter((user) => user.slack?.toUpperCase() === slackUserId.toUpperCase()) ?? [];
    if (users.length > 1) return { ok: false, reason: "user_ambiguous" };
    let email = users[0]?.google_workspace_email?.toLowerCase();
    if (!email) {
      if (!this.#token || !this.#teamId) return { ok: false, reason: "slack_identity_unavailable" };
      try {
        const url = new URL(`${this.#baseUrl.replace(/\/+$/, "")}/users.info`);
        url.searchParams.set("user", slackUserId);
        const response = await this.#fetch(url, {
          headers: { Authorization: `Bearer ${this.#token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok || response.status !== 200)
          return { ok: false, reason: "slack_identity_unavailable" };
        const profile = SlackProfileSchema.safeParse(await response.json());
        if (
          !profile.success ||
          profile.data.user.id !== slackUserId ||
          profile.data.user.team_id !== this.#teamId ||
          profile.data.user.is_app_user ||
          profile.data.user.is_stranger
        )
          return { ok: false, reason: "slack_identity_unavailable" };
        email = profile.data.user.profile.email.toLowerCase();
      } catch {
        return { ok: false, reason: "slack_identity_unavailable" };
      }
    }
    // An implicit Slack address cannot claim an account explicitly pinned to another user.
    const pinned =
      config.users?.filter((user) => user.google_workspace_email?.toLowerCase() === email) ?? [];
    if (
      pinned.length > 1 ||
      pinned.some((user) => user.slack?.toUpperCase() !== slackUserId.toUpperCase())
    )
      return { ok: false, reason: "google_email_ambiguous" };
    return { ok: true, googleWorkspaceEmail: email };
  }

  async resolveActiveUser(sessionId: string | undefined): Promise<GwsActiveSlackIdentity> {
    if (!sessionId) return { ok: false, reason: "missing_session" };
    const active = findActiveSlackTriggerActor(sessionId);
    if (!active.ok) return { ok: false, reason: "no_active_slack_trigger" };
    const email = await this.resolveGoogleEmail(active.slackUserId);
    if (!email.ok) return email;
    const current = findActiveSlackTriggerActor(sessionId);
    if (
      !current.ok ||
      current.triggerId !== active.triggerId ||
      current.slackUserId !== active.slackUserId ||
      current.anchorId !== active.anchorId
    )
      return { ok: false, reason: "no_active_slack_trigger" };
    return {
      ok: true,
      slackUserId: active.slackUserId,
      sessionId: active.sessionId,
      anchorId: active.anchorId,
      triggerId: active.triggerId,
      googleWorkspaceEmail: email.googleWorkspaceEmail,
    };
  }
}
