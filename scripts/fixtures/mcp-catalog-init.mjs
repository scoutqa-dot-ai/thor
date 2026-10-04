import fs from "node:fs";
const builtins = ["atlassian", "grafana", "onepassword-browser", "posthog", "falcon", "kali"];
const root = "/etc/thor/mcp-catalog";
for (const path of [
  root,
  "/run/secrets/thor-mcp",
  "/workspace",
  "/workspace/config",
  "/workspace/repos",
  "/workspace/repos/catalog-fixture",
]) {
  fs.mkdirSync(path, { recursive: true });
  fs.chownSync(path, 1001, 1001);
}
fs.chmodSync("/run/secrets/thor-mcp", 0o700);
fs.writeFileSync("/run/secrets/thor-mcp/dummy-token", "dummy-private-file-sentinel\n", {
  mode: 0o600,
});
fs.chownSync("/run/secrets/thor-mcp/dummy-token", 1001, 1001);
fs.writeFileSync("/workspace/config/thor.json", JSON.stringify({ owners: {}, users: [] }));
fs.rmSync("/workspace/repos/catalog-fixture/private-link", { force: true });
fs.symlinkSync(
  "/run/secrets/thor-mcp/dummy-token",
  "/workspace/repos/catalog-fixture/private-link",
);
const server = {
  transport: "streamable-http",
  url: "http://fixture:8000/mcp",
  description: "Local fixture",
  auth: { type: "none" },
  http: { type: "internal-unauthenticated", operatorReviewed: true },
  policy: { allow: ["echo"], approve: [] },
};
const operation = process.argv[2] ?? "add";
if (operation === "foreign-owner") fs.chownSync("/run/secrets/thor-mcp/dummy-token", 0, 0);
if (operation === "missing") {
  fs.rmSync(root + "/catalog.json", { force: true });
} else {
  const servers =
    operation === "foreign-owner"
      ? {
          privateprobe: {
            ...server,
            url: "https://localhost:1/mcp",
            http: undefined,
            auth: { type: "bearer", secretFile: "dummy-token" },
          },
        }
      : operation === "remove"
        ? {}
        : { localdocs: server };
  const value =
    operation === "malformed"
      ? "{invalid"
      : JSON.stringify({ version: 1, servers, disabled: builtins });
  fs.writeFileSync(root + "/catalog.next", value);
  fs.renameSync(root + "/catalog.next", root + "/catalog.json");
}
