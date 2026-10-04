import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolveOnePasswordBrowserUpstream } from "./src/managed-browser-upstream.ts";
import { prepareBrokerCommand } from "./src/broker-command-isolation.ts";

const probe = String.raw`
const fs=require('fs');
for (const p of ['/etc/thor/mcp-catalog/catalog.json','/run/secrets/thor-mcp/dummy-token','/proc/1/root/run/secrets/thor-mcp/dummy-token','/workspace/repos/catalog-fixture/private-link']) {
  try { fs.readFileSync(p); throw new Error('private mount exposed'); } catch (e) { if(e.message==='private mount exposed') throw e; }
}
for (const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
  let env='';try{env=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{}
  if(env.includes('dummy-broker-env-sentinel')||env.includes('dummy-private-file-sentinel')) throw new Error('broker proc environment exposed');
}
if(JSON.stringify(process.env).includes('dummy-broker-env-sentinel')) throw new Error('broker environment exposed');
process.stdout.write('isolated');`;
async function run(binary, args, env, token) {
  const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  child.stdio[3].on("error", () => {}); // Early bwrap denial is reported by its exit/stderr below.
  child.stdio[3].end(token ?? "");
  const code = await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 0, error);
  assert.equal(output, "isolated");
}
const managed = resolveOnePasswordBrowserUpstream(process.env);
assert.equal(managed.kind, "stdio");
await run(
  managed.command,
  [...managed.args.slice(0, -2), "/usr/local/bin/node", "-e", probe],
  { PATH: "/usr/bin:/bin", ...managed.env },
  managed.secretInput.getContents(),
);
const command = prepareBrokerCommand("git", [], "/workspace/repos/catalog-fixture", process.env);
assert.equal(command.ok, true);
// Replace only the integration executable with the measurement probe; preserve its exact mounts/env.
await run(
  command.binary,
  [...command.args.slice(0, -1), "/usr/local/bin/node", "-e", probe],
  command.env,
);
console.log("managed browser and broker command child isolation passed");
