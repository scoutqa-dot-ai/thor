// Dummy Pi workspace/TLS and broker-private catalog/state, on unique test volumes only.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const operation = process.argv[2] ?? "setup";
const catalogPath = "/etc/thor/mcp-catalog/catalog.json";
const tokenPath = "/run/secrets/thor-mcp/dummy-token";
function replacePrivateFile(path, bytes) {
  fs.writeFileSync(path + ".next", bytes, { mode: 0o600 });
  fs.chownSync(path + ".next", 1001, 1001);
  fs.renameSync(path + ".next", path);
}
if (operation === "setup") {
  fs.mkdirSync("/workspace/repos/pi-fixture", { recursive: true });
  fs.writeFileSync("/workspace/repos/pi-fixture/README.md", "fixture repo");
  for (const path of ["/workspace/repos/pi-fixture", "/workspace/repos/pi-fixture/README.md"])
    fs.chownSync(path, 1001, 1001);
  fs.writeFileSync(
    "/workspace/config/thor.json",
    JSON.stringify({
      owners: {},
      users: [],
      slack: { private_channel_allowlist: ["DFIXTURE"] },
      pi: {
        modelRouting: {
          profiles: {
            fast: { modelId: "fixture-fast" },
            balanced: { modelId: "fixture-balanced" },
            strong: { modelId: "fixture-strong" },
          },
        },
      },
    }),
  );
  for (const name of ["repos", "worktrees", "memory", "worklog", "config"])
    fs.chownSync(`/workspace/${name}`, 1001, 1001);
  for (const path of [
    "/etc/thor/mcp-catalog",
    "/var/lib/remote-cli/mcp-approvals",
    "/run/secrets/thor-mcp",
    "/fixture-tls",
    "/fixture-ca",
  ]) {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    fs.chownSync(path, 1001, 1001);
    fs.chmodSync(path, 0o700);
  }
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=mcp-fixture",
      "-addext",
      "subjectAltName=DNS:mcp-fixture",
      "-keyout",
      "/fixture-tls/key.pem",
      "-out",
      "/fixture-ca/cert.pem",
    ],
    { stdio: "ignore" },
  );
  fs.chownSync("/fixture-tls/key.pem", 1001, 1001);
  replacePrivateFile(tokenPath, "dummy-private-token-first\n");
  replacePrivateFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      disabled: ["atlassian", "posthog", "grafana", "falcon", "kali", "onepassword-browser"],
      servers: {
        localdocs: {
          transport: "streamable-http",
          description: "Dummy native HTTP fixture",
          url: "http://mcp-fixture:8000/mcp",
          auth: { type: "none" },
          http: { type: "internal-unauthenticated", operatorReviewed: true },
          policy: { allow: ["echo"], approve: ["write_doc"] },
        },
      },
    }),
  );
} else {
  if (
    !["add", "remove", "disable", "readd", "replace-token", "restore-token", "rotate"].includes(
      operation,
    )
  )
    throw new Error("Pi MCP fixture operation unsupported");
  if (operation === "replace-token" || operation === "rotate")
    replacePrivateFile(tokenPath, "dummy-private-token-replacement\n");
  if (operation === "restore-token") replacePrivateFile(tokenPath, "dummy-private-token-first\n");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  catalog.disabled = catalog.disabled.filter((name) => name !== "rotatingdocs");
  if (operation === "remove") delete catalog.servers.rotatingdocs;
  else if (!["replace-token", "restore-token"].includes(operation)) {
    catalog.servers.rotatingdocs = {
      transport: "streamable-http",
      description: "Dummy bearer lifecycle fixture",
      url: "https://mcp-fixture:8001/mcp",
      auth: { type: "bearer", secretFile: "dummy-token" },
      policy: { allow: ["echo"], approve: [] },
    };
    if (operation === "disable") catalog.disabled.push("rotatingdocs");
  }
  replacePrivateFile(catalogPath, JSON.stringify(catalog));
}
