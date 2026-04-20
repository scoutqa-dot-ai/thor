/**
 * Test Docker-in-Docker by bringing up Thor's docker-compose inside a Daytona sandbox.
 *
 * Usage:
 *   DAYTONA_API_KEY=... pnpm -F remote-cli exec tsx ../../scripts/test-dind-compose.ts
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("DAYTONA_API_KEY is required");
  process.exit(1);
}

const d = new Daytona({
  apiKey,
  apiUrl: process.env.DAYTONA_API_URL || "https://app.daytona.io/api",
});

async function exec(
  sandbox: Sandbox,
  label: string,
  cmd: string,
  verbose = false,
): Promise<boolean> {
  const t0 = Date.now();
  process.stdout.write(`  ${label}... `);
  const result = await sandbox.process.executeCommand(cmd);
  const elapsed = Date.now() - t0;
  if (result.exitCode === 0) {
    console.log(`✓ (${elapsed}ms)`);
    if (verbose && result.result)
      console.log(`    ${result.result.trim().split("\n").join("\n    ")}`);
  } else {
    console.log(`✗ (${elapsed}ms)`);
    console.log(`    stdout: ${(result.result || "").slice(0, 500)}`);
  }
  return result.exitCode === 0;
}

async function main() {
  console.log("=== Creating DinD sandbox ===");
  const t0 = Date.now();
  const sandbox = await d.create({
    snapshot: process.env.DAYTONA_SNAPSHOT || "daytona-medium",
    ephemeral: true,
    autoStopInterval: 15,
    labels: { test: "dind-compose" },
  });
  console.log(`  Created in ${Date.now() - t0}ms (id: ${sandbox.id})\n`);

  try {
    // Start Docker daemon
    console.log("=== Start Docker daemon ===");
    await exec(
      sandbox,
      "start dockerd",
      "sudo dockerd --storage-driver overlay2 > /tmp/dockerd.log 2>&1 & " +
        "for i in $(seq 1 30); do docker info > /dev/null 2>&1 && break; sleep 1; done",
    );
    await exec(sandbox, "dockerd logs", "cat /tmp/dockerd.log 2>&1 | tail -20", true);
    await exec(sandbox, "check sudo", "sudo whoami", true);
    await exec(sandbox, "check cgroups", "ls -la /sys/fs/cgroup/ 2>&1 | head -10", true);
    await exec(sandbox, "docker version", "docker version --format '{{.Server.Version}}'");
    await exec(sandbox, "docker compose version", "docker compose version --short");

    // Clone the repo
    console.log("\n=== Clone repo ===");
    await exec(
      sandbox,
      "git clone",
      "git clone --depth 1 https://github.com/scoutqa-dot-ai/thor.git /workspace/sandbox",
    );

    // Write a fake .env
    console.log("\n=== Write fake .env ===");
    const fakeEnv = [
      "CRON_SECRET=fake-cron-secret-12345",
      "RESOLVE_SECRET=fake-resolve-secret-12345",
      "SLACK_BOT_TOKEN=xoxb-fake-token",
      "SLACK_BOT_USER_ID=U00FAKE",
      "SLACK_SIGNING_SECRET=fake-signing-secret",
      "GRAFANA_URL=http://localhost:9999",
      "GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_fake_token",
      "ATLASSIAN_AUTH=Bearer fake-atlassian-token",
      "POSTHOG_API_KEY=phx_fake_posthog_key",
      "LANGFUSE_PUBLIC_KEY=pk-lf-fake",
      "LANGFUSE_SECRET_KEY=sk-lf-fake",
      "GITHUB_PAT=ghp_fake_github_pat",
      "VOUCH_GOOGLE_CLIENT_ID=fake-google-client-id",
      "VOUCH_GOOGLE_CLIENT_SECRET=fake-google-secret",
      "VOUCH_JWT_SECRET=fake-jwt-secret-12345",
      "VOUCH_WHITELIST=test@example.com",
    ].join("\n");
    await exec(
      sandbox,
      "write .env",
      `cat > /workspace/sandbox/.env << 'ENVEOF'\n${fakeEnv}\nENVEOF`,
    );

    // Docker compose build
    console.log("\n=== Docker compose build ===");
    const buildOk = await exec(
      sandbox,
      "docker compose build",
      "cd /workspace/sandbox && docker compose build --parallel 2>&1 | tail -5",
    );

    if (buildOk) {
      // Docker compose up
      console.log("\n=== Docker compose up ===");
      await exec(
        sandbox,
        "docker compose up -d",
        "cd /workspace/sandbox && docker compose up -d 2>&1 | tail -20",
      );

      // Wait a bit for services to start
      await exec(sandbox, "wait 15s for startup", "sleep 15");

      // Check which services are running
      console.log("\n=== Service status ===");
      await exec(
        sandbox,
        "docker compose ps",
        "cd /workspace/sandbox && docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'",
      );

      // Try health checks
      console.log("\n=== Health checks ===");
      await exec(sandbox, "remote-cli health", "curl -sf http://localhost:3004/health");
      await exec(sandbox, "gateway health", "curl -sf http://localhost:3002/health");
      await exec(sandbox, "opencode health", "curl -sf http://localhost:4096/global/health");

      // Tear down
      console.log("\n=== Docker compose down ===");
      await exec(
        sandbox,
        "docker compose down",
        "cd /workspace/sandbox && docker compose down 2>&1 | tail -5",
      );
    }
  } finally {
    console.log("\n=== Cleanup ===");
    await sandbox.delete();
    console.log("  Sandbox deleted.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
