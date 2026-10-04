// Dummy Pi workspace and broker-private catalog/state, on unique test volumes only.
import fs from "node:fs";
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
for (const path of ["/etc/thor/mcp-catalog", "/var/lib/remote-cli/mcp-approvals"]) {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  fs.chownSync(path, 1001, 1001);
  fs.chmodSync(path, 0o700);
}
const catalog = {
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
};
fs.writeFileSync("/etc/thor/mcp-catalog/catalog.json", JSON.stringify(catalog), { mode: 0o600 });
fs.chownSync("/etc/thor/mcp-catalog/catalog.json", 1001, 1001);
