#!/usr/bin/env bash
# Real container test of embedded Durable, restricted tools, wrappers, SSO routing and restart.
# Uses dummy fixtures and project-owned named volumes only; never sources .env or contacts live accounts.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="thor-pi-e2e-$(id -u)-$$"
compose=(docker compose -p "$project" -f "$root/docker/pi-test/compose.yml")
cleanup() {
  status=$?
  if (( status != 0 )); then "${compose[@]}" logs --no-color --tail 80 || true; fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
"${compose[@]}" up --build -d --wait --wait-timeout 180

"${compose[@]}" exec -T runner node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const trigger = async (body) => fetch('http://127.0.0.1:3000/trigger', {
  method:'POST', headers:{'content-type':'application/json','x-thor-internal-secret':process.env.THOR_INTERNAL_SECRET},
  body:JSON.stringify({directory:'/workspace/repos/pi-fixture', ...body}),
});
await writeFile('/var/lib/runner/runner-only','runner-private-sentinel');
const body={prompt:'fixture-tool',requestId:'container-tool',correlationKey:'slack:thread:C_FIXTURE/1710000000.001',triggerSlackId:'U_FIXTURE'};
const streamed=await trigger({...body,stream:true});
assert.equal(streamed.status,200);
const frames=(await streamed.text()).trim().split('\n').map(JSON.parse);
assert.equal(frames[0].type,'start');
assert.equal(frames.at(-1).status,'completed');
assert.equal(frames.at(-1).response,'fixture completed');
assert(frames.some(frame=>frame.type==='tool'&&frame.tool==='bash'&&frame.status==='completed'));
assert(frames.some(frame=>frame.type==='context'));
const receipt=await (await trigger(body)).json();
assert.equal(receipt.duplicate,true);
assert.equal((await trigger({...body,prompt:'different'})).status,409);
await writeFile('/var/lib/runner/e2e-receipt.json',JSON.stringify(receipt));
const probe=await (await fetch('http://model-fixture:8000/probe')).json();
assert.equal(probe.calls,4);assert.equal(probe.wrapperCalls,1);assert(probe.slackPosts>0);
assert.equal(probe.lastWrapper.sessionId,receipt.sessionId);
assert.equal(probe.lastWrapper.directory,'/workspace/repos/pi-fixture');
assert(probe.lastWrapper.callId.includes('call_fixture'));
const denied=await (await fetch('http://pi-executor:3002/execute',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({sessionId:'00000000-0000-4000-8000-000000000001',cwd:'/workspace/repos/pi-fixture',operation:{type:'writeFile',path:'/workspace/repos/pi-fixture/README.md',content:{encoding:'text',data:'must fail'}}}),
})).json();
assert.equal(denied.ok,false);
const health=await (await fetch('http://ingress:8080/global/health')).json();assert.equal(health.runtime,'pi');
const anonymous=await fetch('http://ingress:8080/',{redirect:'manual'});assert.equal(anonymous.status,302);assert(anonymous.headers.get('location').includes('/vouch/login'));
const headers={cookie:'fixture-auth=1'};
const home=await fetch('http://ingress:8080/',{headers,redirect:'manual'});assert.equal(home.status,302);assert.equal(home.headers.get('location'),'/admin/sessions');
const viewer=await fetch(`http://ingress:8080/runner/v/${receipt.anchorId}/${receipt.triggerId}`,{headers});assert.equal(viewer.status,200);assert((await viewer.text()).includes('fixture completed'));
const admin=await fetch('http://ingress:8080/admin/sessions',{headers});assert.equal(admin.status,200);assert((await admin.text()).includes(receipt.anchorId));
const pending={prompt:'fixture-hold',requestId:'container-recovery',correlationKey:'cron:container-recovery'};
const accepted=await (await trigger(pending)).json();assert.equal(accepted.accepted,true);
await writeFile('/var/lib/runner/e2e-pending.json',JSON.stringify(accepted));
console.log('PASS: tool round, credential/mount isolation, wrapper identity, Slack progress, deduplication and SSO viewers');
JS

"${compose[@]}" exec -T pi-executor node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
assert.equal(await readFile('/workspace/worktrees/pi-proof.txt','utf8'),'executor-only\n');
await assert.rejects(readFile('/var/lib/runner/runner-only','utf8'));
assert.equal(process.env.SLACK_BOT_TOKEN,undefined);
assert.equal(process.env.THOR_INTERNAL_SECRET,undefined);
for(const secret of [undefined,'forged']) {
  const denied=await fetch('http://runner:3000/trigger',{method:'POST',headers:{'content-type':'application/json',...(secret?{'x-thor-internal-secret':secret}:{})},body:JSON.stringify({directory:'/workspace/repos/pi-fixture',prompt:'forge actor',triggerSlackId:'U_ADMIN'})});
  assert.equal(denied.status,401);
}
console.log('PASS: executor cannot access runner-private storage or credentials');
JS

"${compose[@]}" kill -s SIGKILL runner
"${compose[@]}" up -d --wait --wait-timeout 120 runner
"${compose[@]}" exec -T runner node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const pending=JSON.parse(await readFile('/var/lib/runner/e2e-pending.json','utf8'));
const body={directory:'/workspace/repos/pi-fixture',prompt:'fixture-hold',requestId:'container-recovery',correlationKey:'cron:container-recovery',stream:true};
const response=await fetch('http://127.0.0.1:3000/trigger',{method:'POST',headers:{'content-type':'application/json','x-thor-internal-secret':process.env.THOR_INTERNAL_SECRET},body:JSON.stringify(body)});
assert.equal(response.status,200);
const frames=(await response.text()).trim().split('\n').map(JSON.parse);
assert.equal(frames[0].sessionId,pending.sessionId);
assert.equal(frames.at(-1).status,'completed');assert.equal(frames.at(-1).response,'fixture recovered');
const log=(await readFile(`/workspace/worklog/sessions/${pending.sessionId}.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(log.filter(record=>record.type==='trigger_start').length,1);
assert.equal(log.filter(record=>record.type==='trigger_end').length,1);
const original=JSON.parse(await readFile('/var/lib/runner/e2e-receipt.json','utf8'));
const viewer=await fetch(`http://127.0.0.1:3000/runner/v/${original.anchorId}/${original.triggerId}`);
assert.equal(viewer.status,200);assert((await viewer.text()).includes('fixture completed'));
const probe=await (await fetch('http://model-fixture:8000/probe')).json();assert.equal(probe.wrapperCalls,1);
console.log('PASS: SIGKILL recovery, stable conversation/history, one admission and no repeated completed tool');
JS
printf '\nPi container E2E passed. Test containers and volumes will be removed.\n'
