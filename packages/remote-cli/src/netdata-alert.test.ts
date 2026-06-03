import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteCliApp } from "./index.ts";

describe("remote-cli internal Netdata alert endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ ok: true, channel: "COPS", ts: "1.2" }) });
    const remoteCli = createRemoteCliApp({
      appEnv: { thorInternalSecret: "internal-secret", isProduction: false },
      env: {
        slackBotToken: "xoxb-test",
        slackApiBaseUrl: "https://slack.test/api",
        slackSupportChannelId: "COPS",
        ingressPublicUrl: "https://thor.example.com/",
      } as any,
      netdataAlert: { fetch: fetchMock as unknown as typeof fetch },
    });
    closeRemoteCli = remoteCli.close;
    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await closeRemoteCli();
  });

  it("requires the internal secret before posting to Slack", async () => {
    const response = await postAlert({ "x-thor-internal-secret": "wrong" });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates payload shape before posting to Slack", async () => {
    const response = await postAlert(
      { "x-thor-internal-secret": "internal-secret" },
      { status: "CRITICAL" },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("missing alarm");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts formatted Netdata alerts to the support channel", async () => {
    const response = await postAlert();
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.test/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
        body: expect.stringContaining('"channel":"COPS"'),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { text: string };
    expect(body.text).toContain("Netdata CRITICAL: container_cpu_usage");
    expect(body.text).toContain("opencode / cgroup_opencode.cpu");
    expect(body.text).toContain("https://thor.example.com/netdata/");
  });

  it("returns a bad-gateway response when Slack rejects the post", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    const response = await postAlert();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("channel_not_found");
  });

  async function postAlert(
    headers: Record<string, string> = { "x-thor-internal-secret": "internal-secret" },
    body: Record<string, unknown> = {
      status: "CRITICAL",
      old_status: "WARNING",
      alarm: "container_cpu_usage",
      chart: "cgroup_opencode.cpu",
      family: "opencode",
      value: "94.2%",
      summary: "CPU usage is above 90%",
    },
  ): Promise<Response> {
    return fetch(`${baseUrl}/internal/netdata-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
});
