import { findActiveSlackTriggerActor, type ConfigLoader } from "@thor/common";

type GwsSlackIdentityFailure = {
  readonly ok: false;
  readonly reason:
    | "missing_session"
    | "no_active_slack_trigger"
    | "config_unavailable"
    | "user_ambiguous"
    | "google_email_ambiguous";
};

type GwsGoogleEmailPin =
  | { readonly ok: true; readonly googleEmailPin?: string }
  | GwsSlackIdentityFailure;

/** Trusted Slack requester from runner evidence; an optional Google email pin restricts account choice, not DM admission. */
export type GwsSlackRequester =
  | {
      readonly ok: true;
      readonly slackUserId: string;
      readonly sessionId: string;
      readonly anchorId: string;
      readonly triggerId: string;
      readonly googleEmailPin?: string;
    }
  | GwsSlackIdentityFailure;

/** Resolve only trusted active Slack attribution and operator pins; never use agent input, Jira email or Slack profile email. */
export interface IGwsSlackIdentityService {
  resolveActiveRequester(sessionId: string | undefined): GwsSlackRequester;
  resolveGooglePin(slackUserId: string): GwsGoogleEmailPin;
}

/** Owns Slack requester identity and optional Google-account restrictions without a directory or email-read prerequisite. */
export class GwsSlackIdentityService implements IGwsSlackIdentityService {
  readonly #getConfig: ConfigLoader;

  constructor(getConfig: ConfigLoader) {
    this.#getConfig = getConfig;
  }

  resolveGooglePin(slackUserId: string): GwsGoogleEmailPin {
    let config: ReturnType<ConfigLoader>;
    try {
      config = this.#getConfig();
    } catch {
      return { ok: false, reason: "config_unavailable" };
    }
    const users =
      config.users?.filter((user) => user.slack?.toUpperCase() === slackUserId.toUpperCase()) ?? [];
    if (users.length > 1) return { ok: false, reason: "user_ambiguous" };
    const email = users[0]?.google_workspace_email?.toLowerCase();
    if (email) {
      const pinned =
        config.users?.filter((user) => user.google_workspace_email?.toLowerCase() === email) ?? [];
      if (pinned.length !== 1) return { ok: false, reason: "google_email_ambiguous" };
    }
    return { ok: true, googleEmailPin: email };
  }

  resolveActiveRequester(sessionId: string | undefined): GwsSlackRequester {
    if (!sessionId) return { ok: false, reason: "missing_session" };
    const active = findActiveSlackTriggerActor(sessionId);
    if (!active.ok) return { ok: false, reason: "no_active_slack_trigger" };
    const pin = this.resolveGooglePin(active.slackUserId);
    if (!pin.ok) return pin;
    return {
      ok: true,
      slackUserId: active.slackUserId,
      sessionId: active.sessionId,
      anchorId: active.anchorId,
      triggerId: active.triggerId,
      googleEmailPin: pin.googleEmailPin,
    };
  }
}
