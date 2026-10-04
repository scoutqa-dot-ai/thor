#!/usr/bin/env bash
# Real container test of embedded Durable, restricted tools, wrappers, SSO routing and restart.
# Uses dummy fixtures and project-owned named volumes only; never sources .env or contacts live accounts.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="thor-pi-e2e-$(id -u)-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f "$root/docker/pi-test/compose.yml")
cleanup() {
  status=$?
  if (( status != 0 )); then "${compose[@]}" logs --no-color --tail 80 || true; fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
if [[ "${PI_TEST_USE_CACHED_IMAGES:-0}" == 1 ]]; then
  compose+=(-f "$root/docker/pi-test/cached.yml")
  "${compose[@]}" up --no-build --pull never -d --wait --wait-timeout 180
else
  # Build separately before validation; offline checks below never install dependencies.
  "${compose[@]}" build remote-cli pi-executor runner gateway admin ingress
  "${compose[@]}" up --no-build --pull never -d --wait --wait-timeout 180
fi

# Seed an image only in the executor filesystem, without placing encoded bytes in model text.
"${compose[@]}" exec -T pi-executor node --input-type=module <<'JS'
import { writeFile } from 'node:fs/promises';
await writeFile('/tmp/pi-proof.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8AAQVDqPwMDAEHSBfsl0XwmAAAAAElFTkSuQmCC', 'base64'));
JS

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
const waitProbe=await fetch('http://remote-cli:3004/internal/google-workspace/waits',{headers:{'x-thor-internal-secret':process.env.THOR_INTERNAL_SECRET}});
assert.equal(waitProbe.status,200,await waitProbe.text());
const body={prompt:'fixture-tool',requestId:'container-tool',correlationKey:'slack:thread:C_FIXTURE/1710000000.001',triggerSlackId:'U_FIXTURE',messageTs:'1710000000.002'};
const streamed=await trigger({...body,stream:true});
assert.equal(streamed.status,200);
const frames=(await streamed.text()).trim().split('\n').map(JSON.parse);
assert.equal(frames[0].type,'start');
assert.equal(frames.at(-1).status,'completed',JSON.stringify(frames.at(-1)));
assert.equal(frames.at(-1).response,'fixture completed');
assert(frames.some(frame=>frame.type==='tool'&&frame.tool==='bash'&&frame.status==='completed'));
assert(frames.some(frame=>frame.type==='context'));
const receipt=await (await trigger(body)).json();
assert.equal(receipt.duplicate,true);
assert.equal((await trigger({...body,prompt:'different'})).status,409);
await writeFile('/var/lib/runner/e2e-receipt.json',JSON.stringify(receipt));
const waitProgress=async(predicate)=>{
  for(let attempt=0;attempt<100;attempt++){
    const probe=await (await fetch('http://model-fixture:8000/probe')).json();
    if(predicate(probe.slackDeliveries))return probe.slackDeliveries;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Pi Slack progress did not settle');
};
const initialDeliveries=await waitProgress(deliveries=>deliveries.some(d=>d.method==='/slack/reactions.add'&&d.name==='white_check_mark'&&d.timestamp==='1710000000.002'));
assert(initialDeliveries.some(d=>d.name==='white_check_mark'&&d.channel==='C_FIXTURE'&&d.timestamp==='1710000000.002'));
assert(initialDeliveries.some(d=>d.method==='/slack/reactions.remove'&&d.name==='eyes'&&d.channel==='C_FIXTURE'&&d.timestamp==='1710000000.002'));
assert(!initialDeliveries.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.001'));
assert(frames.filter(frame=>frame.type!=='text').every(frame=>frame.requestId==='container-tool'&&frame.sessionId===frames[0].sessionId));
const probe=await (await fetch('http://model-fixture:8000/probe')).json();
assert.equal(probe.calls,4);assert.equal(probe.wrapperCalls,1);assert(probe.slackPosts>0);
assert.deepEqual(probe.lastProgressTarget,{channel:'C_FIXTURE',threadTs:'1710000000.001'});
assert.equal(probe.lastWrapper.sessionId,receipt.sessionId);
assert.equal(probe.lastWrapper.directory,'/workspace/repos/pi-fixture');
assert(probe.lastWrapper.callId.includes('call_fixture'));
assert.equal(probe.slackReplies,1); assert.equal(probe.lastReply.sessionId,receipt.sessionId);
assert.deepEqual(probe.lastReply.args,['--channel','C_FIXTURE','--thread-ts','1710000000.001']);
assert.equal(probe.lastReply.text,'fixture thread reply\n');
const delayedBody={prompt:'fixture-progress-delay',requestId:'container-zero-tool',correlationKey:'slack:thread:C_DELAYED/1710000000.001',messageTs:'1710000000.003'};
const delayedFrames=(await (await trigger({...delayedBody,stream:true})).text()).trim().split('\n').map(JSON.parse);
assert.deepEqual(delayedFrames.at(-1).toolCalls,[]);
const delayedDeliveries=await waitProgress(deliveries=>deliveries.some(d=>d.method==='/slack/chat.delete'&&d.channel==='C_DELAYED'));
const delayedFooter=delayedDeliveries.find(d=>d.method==='/slack/chat.postMessage'&&d.channel==='C_DELAYED');
assert(delayedFooter.text.includes('Neo thinking... 0 tool calls'));
assert.equal(delayedFooter.blocks[0].elements[0].image_url,'http://ingress:8080/neo-thinking-v1.gif');
assert(delayedFooter.blocks[0].elements.some(element=>element.type==='plain_text'&&element.text==='Model: fixture-balanced · Thinking: medium'));
assert(delayedDeliveries.some(d=>d.channel==='C_DELAYED'&&d.text?.includes('Neo responding')&&d.blocks[0].elements[0].image_url==='http://ingress:8080/neo-ai-still-v1.png'));
assert(delayedDeliveries.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.003'));
for(const [path,mime] of [['/neo-thinking-v1.gif','image/gif'],['/neo-working-v1.gif','image/gif'],['/neo-ai-still-v1.png','image/png']]){
  const image=await fetch('http://ingress:8080'+path,{redirect:'manual'});
  assert.equal(image.status,200);assert(image.headers.get('content-type').includes(mime));assert((await image.arrayBuffer()).byteLength>1000);
}
console.log('PASS: actual native Pi/Slack SDK image lifecycle, zero-tool grace, static output, exact-source check and public artwork');
await assert.rejects(readFile('/tmp/pi-proof.png'));
const imageBody={prompt:'fixture-image',requestId:'container-image',correlationKey:'cron:container-image'};
const imageFrames=(await (await trigger({...imageBody,stream:true})).text()).trim().split('\n').map(JSON.parse);
assert.equal(imageFrames.at(-1).response,'fixture image inspected');
assert(imageFrames.some(frame=>frame.type==='tool'&&frame.tool==='read_image'&&frame.status==='completed'));
assert.equal((await (await fetch('http://model-fixture:8000/probe')).json()).imageInputs,1);
const imageReceipt=await (await trigger(imageBody)).json();
const imageHtml=await (await fetch(`http://127.0.0.1:3000/runner/v/${imageReceipt.anchorId}/${imageReceipt.triggerId}`)).text();
assert(imageHtml.includes('[Image attached: image/png]'));
assert(!imageHtml.includes('data:image/')); assert(!imageHtml.includes('iVBORw0KGgo'));
console.log('PASS: executor-only raster image reaches actual Responses input_image and safe viewer marker');
for (const mode of ['native-structured','native-image','native-error']) {
  const nativeBody={prompt:'fixture-native-mcp '+mode,requestId:'container-'+mode,correlationKey:'cron:container-'+mode};
  const nativeFrames=(await (await trigger({...nativeBody,stream:true})).text()).trim().split('\n').map(JSON.parse);
  assert.equal(nativeFrames.at(-1).response,'fixture native MCP verified');
  assert(nativeFrames.some(frame=>frame.type==='tool'&&frame.tool==='mcp_search'&&frame.status==='completed'));
  assert(nativeFrames.some(frame=>frame.type==='tool'&&frame.tool==='mcp_call'&&frame.status===(mode==='native-error'?'error':'completed')));
}
const actualMcp=await (await fetch('http://mcp-fixture:8000/health')).json();
assert.equal(actualMcp.effects,3);
assert.deepEqual(actualMcp.calls.map(call=>call.arguments),[{text:'native-structured'},{text:'native-image'},{text:'native-error'}]);
assert(actualMcp.calls.every(call=>call.name==='echo'));
const nativeProbe=await (await fetch('http://model-fixture:8000/probe')).json();
assert.equal(nativeProbe.wrapperCalls,1); // Native calls never use the shell/argv wrapper.
console.log('PASS: actual Durable SQLite -> real broker -> real SDK MCP search/object call, structured/image/isError results, no shell roundtrip');
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
assert.equal(connect.status,400);assert((await connect.text()).includes('Resume Google Workspace connection'));
const callback=await fetch('http://ingress:8080/google-workspace/oauth/callback?code=fixture-code&state=fixture-state',{headers:{'x-thor-internal-secret':'forged'}});assert.equal(callback.status,400);
// Actual signed HTTP intake, disk queue, gateway admission and embedded Pi response.
const signedEvent={type:'event_callback',team_id:'T_FIXTURE',event_id:'Ev_signed_first',event:{type:'app_mention',user:'U_SIGNED',channel:'C_SIGNED',ts:'1710000000.010',text:'<@UBOT> [profile:strong thinking:low] fixture-slack-intake'}};
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
await waitProgress(deliveries=>deliveries.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.011'));
const slackProbe=await (await fetch('http://model-fixture:8000/probe')).json();assert.equal(slackProbe.slackReplies,1);assert.equal(slackProbe.hostReplies,2);
assert(slackProbe.modelSelections.some(choice=>choice.model==='fixture-strong'&&choice.effort==='low'));
assert.deepEqual(slackProbe.modelSelections.at(-1),{model:'fixture-balanced',effort:'medium'}); // A new human task reroutes, not the prior strong override.
assert.equal(slackProbe.lastHostReply.channel,'C_SIGNED');assert.equal(slackProbe.lastHostReply.threadTs,'1710000000.010');assert.equal(slackProbe.lastHostReply.text,'fixture signed completed');
assert(slackProbe.lastHostReply.blocks.at(-1).elements.some(element=>element.text==='Model: fixture-balanced · Thinking: medium'));
const nativeStatuses=slackProbe.slackDeliveries.filter(d=>d.method==='/slack/agents.sessions.setStatus'&&d.channel==='C_SIGNED');
assert(nativeStatuses.some(d=>d.status==='processing'));assert.equal(nativeStatuses.at(-1).status,'active');
const signedChecks=await waitProgress(deliveries=>deliveries.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.011'));
assert(signedChecks.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.010'&&d.channel==='C_SIGNED'));
assert(signedChecks.some(d=>d.name==='white_check_mark'&&d.timestamp==='1710000000.011'&&d.channel==='C_SIGNED'));
console.log('PASS: signed Slack mention, disk queue, actor attribution, duplicate suppression, in-thread reply and non-mention continuation through real gateway/Pi');
const routingBody={prompt:'fixture-escalation',routingTask:'Create a Google document',requestId:'container-escalation'};
const routingFrames=(await (await trigger({...routingBody,stream:true})).text()).trim().split('\n').map(JSON.parse);
assert.equal(routingFrames.at(-1).response,'fixture promoted twice');
assert.equal(routingFrames.filter(frame=>frame.type==='tool'&&frame.tool==='escalate_model'&&frame.status==='completed').length,2);
const routingReceipt=await (await trigger(routingBody)).json();
const routingHtml=await (await fetch(`http://127.0.0.1:3000/runner/v/${routingReceipt.anchorId}/${routingReceipt.triggerId}`)).text();
assert(routingHtml.includes('fixture-strong · thinking high · profile strong'));
assert(routingHtml.includes('Need more reasoning')&&routingHtml.includes('Need deeper reasoning'));
const routingProbe=await (await fetch('http://model-fixture:8000/probe')).json();
assert.deepEqual(routingProbe.modelSelections.slice(-3),[{model:'fixture-fast',effort:'low'},{model:'fixture-balanced',effort:'medium'},{model:'fixture-strong',effort:'high'}]);
console.log('PASS: actual per-task Responses model/effort, explicit Slack override, new-human reroute, bounded native escalation and viewer attribution');
const approvalBody={prompt:'fixture-native-mcp-approval',requestId:'container-native-approval',correlationKey:'slack:thread:DFIXTURE/1710000000.100',triggerSlackId:'U_FIXTURE',messageTs:'1710000000.101',thinkingLevel:'high',slackReplyAdmission:{version:1,teamId:'T_FIXTURE',channel:'DFIXTURE',threadTs:'1710000000.100'}};
const approvalFrames=(await (await trigger({...approvalBody,stream:true})).text()).trim().split('\n').map(JSON.parse);
assert.equal(approvalFrames.at(-1).status,'error');assert.equal(approvalFrames.at(-1).authWait,'approval');
const beforeApproval=await (await fetch('http://mcp-fixture:8000/health')).json();
assert.equal(beforeApproval.effects,3);assert.equal(beforeApproval.cards.length,1);
const card=beforeApproval.cards[0];
assert.equal(card.channel,'DFIXTURE');
const value=card.blocks.flatMap(block=>block.elements??[]).find(element=>element.action_id==='approval_approve').value;
const actionBody=new URLSearchParams({payload:JSON.stringify({type:'block_actions',team:{id:'T_FIXTURE'},user:{id:'U_FIXTURE'},channel:{id:'DFIXTURE'},message:{ts:'1710000000.123'},actions:[{action_id:'approval_approve',value}]})}).toString();
const actionTime=String(Math.floor(Date.now()/1000));
const actionSignature='v0='+createHmac('sha256','fixture-signing-secret').update(`v0:${actionTime}:${actionBody}`).digest('hex');
const actionResponse=await fetch('http://ingress:8080/slack/interactivity',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':actionTime,'x-slack-signature':actionSignature},body:actionBody});
assert.equal(actionResponse.status,200);
const approvedDeliveries=await waitProgress(deliveries=>deliveries.some(d=>d.method==='/slack/chat.postMessage'&&d.text==='fixture approved disposition'));
const approvedReply=approvedDeliveries.find(d=>d.text==='fixture approved disposition');
assert.equal(approvedReply.channel,'DFIXTURE');assert.equal(approvedReply.threadTs,'1710000000.100');
assert(approvedReply.blocks.at(-1).elements.some(element=>element.text==='Model: fixture-balanced · Thinking: high'));
const afterApproval=await (await fetch('http://mcp-fixture:8000/health')).json();
assert.equal(afterApproval.effects,4);assert.equal(afterApproval.calls.at(-1).name,'write_doc');
assert.deepEqual(afterApproval.calls.at(-1).arguments,{text:'dummy-private-approved-native'});
assert(!approvedDeliveries.some(d=>d.text==='fixture native approval pending'));
console.log('PASS: native pending hold -> signed gateway click -> private broker dispatch -> authenticated queue continuation -> original host target/model, exactly one approved effect');
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
