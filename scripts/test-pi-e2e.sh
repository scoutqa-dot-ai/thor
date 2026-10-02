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
import { readFile, readdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
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
assert.deepEqual(probe.lastProgressTarget,{channel:'C_FIXTURE',threadTs:'1710000000.001'});
assert.equal(probe.lastWrapper.sessionId,receipt.sessionId);
assert.equal(probe.lastWrapper.directory,'/workspace/repos/pi-fixture');
assert(probe.lastWrapper.callId.includes('call_fixture'));
assert.equal(probe.slackReplies,1); assert.equal(probe.lastReply.sessionId,receipt.sessionId);
assert.deepEqual(probe.lastReply.args,['--channel','C_FIXTURE','--thread-ts','1710000000.001']);
assert.equal(probe.lastReply.text,'fixture thread reply\n');
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
const unauthorizedConnect=await fetch('http://ingress:8080/google-workspace/connect/authorize',{redirect:'manual',headers:{'x-vouch-user':'forged'}});assert.equal(unauthorizedConnect.status,302);assert(unauthorizedConnect.headers.get('location').includes('/vouch/login'));
const connect=await fetch('http://ingress:8080/google-workspace/connect/authorize',{headers:{...headers,'x-vouch-user':'forged','x-thor-internal-secret':'forged'}});
assert.deepEqual(await connect.json(),{trustedInternalHeader:true,vouchUser:'fixture@example.com'});
const callback=await fetch('http://ingress:8080/google-workspace/oauth/callback?code=fixture-code&state=fixture-state',{headers:{'x-thor-internal-secret':'forged'}});assert.equal((await callback.json()).trustedInternalHeader,true);
// Actual signed HTTP intake, disk queue, gateway admission and embedded Pi response.
const signedEvent={type:'event_callback',team_id:'T_FIXTURE',event_id:'Ev_signed_first',event:{type:'app_mention',user:'U_SIGNED',channel:'C_SIGNED',ts:'1710000000.010',text:'<@U_BOT> fixture-slack-intake'}};
const slackRequest=async(payload,valid=true)=>{
  const raw=JSON.stringify(payload), timestamp=String(Math.floor(Date.now()/1000));
  const signature='v0='+createHmac('sha256','fixture-signing-secret').update(`v0:${timestamp}:${raw}`).digest('hex');
  return fetch('http://ingress:8080/slack/events',{method:'POST',headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':valid?signature:'v0=forged'},body:raw});
};
assert.equal((await slackRequest(signedEvent,false)).status,401);
assert.equal((await slackRequest(signedEvent)).status,200);
const signedRuns=async()=>{
  const runs=[];
  for(const name of await readdir('/workspace/worklog/sessions')) {
    if(!name.endsWith('.jsonl'))continue;
    const records=(await readFile('/workspace/worklog/sessions/'+name,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const starts=records.filter(r=>r.type==='trigger_start'&&r.correlationKey==='slack:thread:C_SIGNED/1710000000.010');
    const ends=records.filter(r=>r.type==='trigger_end'&&starts.some(s=>s.triggerId===r.triggerId));
    if(starts.length)runs.push({sessionId:name.slice(0,-6),starts,ends});
  }
  return runs;
};
const waitSigned=async(count)=>{
  for(let attempt=0;attempt<100;attempt++){
    const runs=await signedRuns();
    if(runs.reduce((n,r)=>n+r.ends.length,0)>=count)return runs;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('Signed Slack intake did not complete in Pi');
};
const first=await waitSigned(1);assert.equal(first.length,1);assert(first[0].sessionId.startsWith('pi-'));assert.equal(first[0].starts[0].triggerSlackId,'U_SIGNED');
assert.equal((await slackRequest(signedEvent)).status,200);
await new Promise(resolve=>setTimeout(resolve,4000));
assert.equal((await signedRuns())[0].starts.length,1);
assert.equal((await slackRequest({...signedEvent,event_id:'Ev_signed_followup',event:{type:'message',user:'U_SIGNED',channel:'C_SIGNED',channel_type:'channel',ts:'1710000000.011',thread_ts:'1710000000.010',text:'fixture-slack-followup'}})).status,200);
const followup=await waitSigned(2);assert.equal(followup.length,1);assert.equal(followup[0].sessionId,first[0].sessionId);assert.equal(followup[0].starts.length,2);
assert(followup[0].starts.every(start=>start.triggerSlackId==='U_SIGNED'));
const slackProbe=await (await fetch('http://model-fixture:8000/probe')).json();assert.equal(slackProbe.slackReplies,3);
assert.deepEqual(slackProbe.lastReply.args,['--channel','C_SIGNED','--thread-ts','1710000000.010']);assert.equal(slackProbe.lastReply.sessionId,first[0].sessionId);
console.log('PASS: signed Slack mention, disk queue, actor attribution, duplicate suppression, in-thread reply and non-mention continuation through real gateway/Pi');
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
