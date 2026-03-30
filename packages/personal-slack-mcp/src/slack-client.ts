/**
 * Shared Slack WebClient wrapper for personal user token.
 * All Slack API calls go through this module.
 */

import { WebClient } from "@slack/web-api";

export interface SlackDeps {
  client: WebClient;
  token: string;
}

export function createSlackDeps(token: string): SlackDeps {
  return {
    client: new WebClient(token),
    token,
  };
}
