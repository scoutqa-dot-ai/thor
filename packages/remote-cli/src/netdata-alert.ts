import { truncate } from "@thor/common";
import { postSlackMessageApi, type SlackPostMessageDeps } from "./slack-post-message.ts";

export interface NetdataAlertEnv {
  SLACK_BOT_TOKEN?: string;
  SLACK_API_BASE_URL?: string;
  SLACK_SUPPORT_CHANNEL_ID?: string;
  NETDATA_PUBLIC_URL?: string;
}

export interface NetdataAlertDeps {
  fetch?: typeof fetch;
  env?: NetdataAlertEnv;
}

export interface NetdataAlertResult {
  ok: boolean;
  status: number;
  body: { ok: boolean; error?: string };
}

const MAX_ALERT_TEXT_BYTES = 8192;

function stringField(body: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function validateAlertBody(
  body: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "alert payload must be an object" };
  }
  const record = body as Record<string, unknown>;
  const status = stringField(record, ["status", "new_status"]);
  const alarm = stringField(record, ["alarm", "name"]);
  if (!status) return { ok: false, error: "alert payload missing status" };
  if (!alarm) return { ok: false, error: "alert payload missing alarm" };
  return { ok: true, body: record };
}

export function formatNetdataAlertText(body: Record<string, unknown>, publicUrl = ""): string {
  const status = stringField(body, ["status", "new_status"]) ?? "unknown";
  const oldStatus = stringField(body, ["old_status", "oldStatus"]);
  const alarm = stringField(body, ["alarm", "name"]) ?? "unknown alarm";
  const chart = stringField(body, ["chart", "chart_name"]);
  const family = stringField(body, ["family", "context", "container"]);
  const host = stringField(body, ["host", "hostname"]);
  const value = stringField(body, ["value", "current", "current_value"]);
  const summary = stringField(body, ["summary", "info", "description"]);
  const duration = stringField(body, ["duration"]);

  const icon = status.toLowerCase() === "critical" ? ":rotating_light:" : ":warning:";
  const title = `${icon} Netdata ${status.toUpperCase()}: ${alarm}`;
  const lines = [title];
  if (oldStatus) lines.push(`*Transition:* ${oldStatus} → ${status}`);
  if (host) lines.push(`*Host:* ${host}`);
  if (family || chart)
    lines.push(`*Container/chart:* ${[family, chart].filter(Boolean).join(" / ")}`);
  if (value) lines.push(`*Current value:* ${value}`);
  if (duration) lines.push(`*Duration:* ${duration}`);
  if (summary) lines.push(`*Summary:* ${truncate(summary, 500)}`);
  if (publicUrl.trim()) lines.push(`*Netdata:* ${publicUrl.trim().replace(/\/$/, "")}`);
  return truncate(lines.join("\n"), MAX_ALERT_TEXT_BYTES);
}

export async function handleNetdataAlert(
  body: unknown,
  deps: NetdataAlertDeps = {},
): Promise<NetdataAlertResult> {
  const env = deps.env ?? {};
  if (!env.SLACK_SUPPORT_CHANNEL_ID) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: "SLACK_SUPPORT_CHANNEL_ID is not set" },
    };
  }

  const validated = validateAlertBody(body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { ok: false, error: validated.error } };
  }

  const slackResult = await postSlackMessageApi(
    {
      channel: env.SLACK_SUPPORT_CHANNEL_ID,
      text: formatNetdataAlertText(validated.body, env.NETDATA_PUBLIC_URL),
    },
    {
      fetch: deps.fetch,
      env: {
        SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
        SLACK_API_BASE_URL: env.SLACK_API_BASE_URL,
      } satisfies SlackPostMessageDeps["env"],
    },
  );
  if ("error" in slackResult) {
    return { ok: false, status: 502, body: { ok: false, error: slackResult.error } };
  }

  return { ok: true, status: 200, body: { ok: true } };
}
