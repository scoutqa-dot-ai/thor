import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const ingress = readFileSync("docker/ingress/nginx.conf.template", "utf8");

function serviceBlock(name: string): string {
  const match = compose.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|\\nvolumes:|$)`),
  );
  if (!match?.[1]) throw new Error(`missing compose service ${name}`);
  return match[1];
}

function locationBlock(path: string): string {
  const start = ingress.indexOf(`location ${path} {`);
  if (start < 0) throw new Error(`missing ingress location ${path}`);
  const end = ingress.indexOf("\n    #", start + 1);
  return ingress.slice(start, end < 0 ? undefined : end);
}

describe("Netdata docker wiring", () => {
  it("declares the Netdata compose service with required mounts, env, and dependency shape", () => {
    const block = serviceBlock("netdata");

    expect(block).toContain("image: netdata/netdata:v2.7.2");
    expect(block).toContain(
      "NETDATA_ALERT_WEBHOOK_URL=http://remote-cli:3004/internal/netdata-alert",
    );
    expect(block).toContain(
      "THOR_INTERNAL_SECRET=${THOR_INTERNAL_SECRET:?set THOR_INTERNAL_SECRET}",
    );
    expect(block).toContain("./docker-volumes/netdata/config:/etc/netdata");
    expect(block).toContain("./docker-volumes/netdata/lib:/var/lib/netdata");
    expect(block).toContain("./docker-volumes/netdata/cache:/var/cache/netdata");
    expect(block).toContain(
      "./docker/netdata/health_alarm_notify.conf:/etc/netdata/health_alarm_notify.conf:ro",
    );
    expect(block).toContain(
      "./docker/netdata/health.d/thor-containers.conf:/etc/netdata/health.d/thor-containers.conf:ro",
    );
    expect(block).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(block).not.toContain("cap_add:");
    expect(block).not.toContain("SYS_ADMIN");
    expect(block).not.toContain("SYS_PTRACE");
    expect(block).not.toContain("apparmor:unconfined");
    expect(block).toContain("remote-cli:");
    expect(block).toContain("condition: service_healthy");
    expect(block).not.toMatch(/\n\s+ports:/);
  });

  it("requires ingress and support-channel env while deriving Netdata links from ingress", () => {
    const block = serviceBlock("remote-cli");

    expect(block).toContain("SLACK_SUPPORT_CHANNEL_ID=${SLACK_SUPPORT_CHANNEL_ID:?set SLACK_SUPPORT_CHANNEL_ID}");
    expect(block).toContain("INGRESS_PUBLIC_URL=${INGRESS_PUBLIC_URL:?set INGRESS_PUBLIC_URL}");
    expect(block).not.toContain(["RUNNER", "BASE", "URL"].join("_"));
    expect(block).not.toContain(["NETDATA", "PUBLIC", "URL"].join("_"));
  });

  it("keeps /netdata/ behind ingress Vouch/admin auth", () => {
    const block = locationBlock("/netdata/");

    expect(ingress).toContain("map $auth_user $netdata_admin_upstream");
    expect(block).toContain("auth_request /vouch/validate;");
    expect(block).toContain("auth_request_set $auth_user $upstream_http_x_vouch_user;");
    expect(block).toContain("proxy_set_header X-Vouch-User $auth_user;");
    expect(block).toContain("proxy_pass $netdata_admin_upstream;");
  });

  it("smoke-tests the Netdata custom notifier payload, header, and endpoint", () => {
    const tmp = mkdtempSync(join(tmpdir(), "thor-netdata-notify-"));
    try {
      const curlLog = join(tmp, "curl-args.txt");
      const stubCurl = join(tmp, "curl");
      writeFileSync(stubCurl, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CURL_ARGS_FILE"\n', {
        mode: 0o755,
      });

      execFileSync(
        "bash",
        [
          "-lc",
          [
            "source docker/netdata/health_alarm_notify.conf",
            "status=CRITICAL",
            "old_status=WARNING",
            "alarm=thor_container_cpu_usage",
            "chart=cgroup_opencode.cpu",
            "family=opencode",
            "hostname=thor-compose",
            "value_string='94.2%'",
            "info='Container CPU usage is above 90%'",
            "duration='2m'",
            "custom_sender",
          ].join("; "),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${tmp}:${process.env.PATH ?? ""}`,
            CURL_ARGS_FILE: curlLog,
            THOR_INTERNAL_SECRET: "test-secret",
            NETDATA_ALERT_WEBHOOK_URL: "http://remote-cli:3004/internal/netdata-alert",
          },
          stdio: "pipe",
        },
      );

      const args = readFileSync(curlLog, "utf8").trim().split("\n");
      expect(args).toContain("--fail");
      expect(args).toContain("x-thor-internal-secret: test-secret");
      expect(args).toContain("http://remote-cli:3004/internal/netdata-alert");
      const payload = JSON.parse(args[args.indexOf("--data") + 1]) as Record<string, string>;
      expect(payload).toMatchObject({
        status: "CRITICAL",
        old_status: "WARNING",
        alarm: "thor_container_cpu_usage",
        chart: "cgroup_opencode.cpu",
        family: "opencode",
        host: "thor-compose",
        value: "94.2%",
        summary: "Container CPU usage is above 90%",
        duration: "2m",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
