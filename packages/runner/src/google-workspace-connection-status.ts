import { z } from "zod";

const ConnectionProbeSchema = z.object({
  oauth: z.object({ configured: z.boolean() }),
  identity: z.object({
    ok: z.boolean(),
    connected: z.boolean().optional(),
    connectionState: z.enum(["connected", "missing", "unavailable"]).optional(),
  }),
});

/** Current stored grant evidence for one trusted Slack requester; never proves Google resource access. */
export type GoogleWorkspaceConnectionStatus = "connected" | "missing" | "unavailable";

/** Read current Google connection state without exposing email, credentials or private grant data. */
export interface IGoogleWorkspaceConnectionStatusClient {
  forSlackUser(slackUserId: string): Promise<GoogleWorkspaceConnectionStatus>;
}

/** Runner-only broker client: credentials are confined to this authenticated context lookup, never tools/executor/model. */
export class GoogleWorkspaceConnectionStatusClient implements IGoogleWorkspaceConnectionStatusClient {
  readonly #url: URL;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(options: { remoteCliUrl: string; internalSecret: string; fetch?: typeof fetch }) {
    this.#url = new URL("/internal/google-workspace/diagnostics", options.remoteCliUrl);
    if (
      !["http:", "https:"].includes(this.#url.protocol) ||
      this.#url.username ||
      this.#url.password
    )
      throw new Error("Google Workspace status broker URL invalid");
    this.#secret = options.internalSecret;
    this.#fetch = options.fetch ?? fetch;
  }

  async forSlackUser(slackUserId: string): Promise<GoogleWorkspaceConnectionStatus> {
    if (!/^[UW][A-Z0-9]+$/.test(slackUserId) || !this.#secret) return "unavailable";
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", "x-thor-internal-secret": this.#secret },
        body: JSON.stringify({ slackUserId }),
        // Product deadline: optional status must not stall an unrelated Slack model turn.
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return "unavailable";
      const probe = ConnectionProbeSchema.safeParse(await response.json());
      if (!probe.success || !probe.data.oauth.configured || !probe.data.identity.ok)
        return "unavailable";
      if (probe.data.identity.connectionState) return probe.data.identity.connectionState;
      // Compatibility with older brokers: positive evidence is useful; false lacks a storage/policy distinction.
      return probe.data.identity.connected === true ? "connected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}
