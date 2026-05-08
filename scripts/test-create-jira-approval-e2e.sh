#!/usr/bin/env bash
#
# Deterministic e2e for the atlassian/createJiraIssue Slack approval card.
# Requires THOR_E2E_TEST_HELPERS=1 on gateway so outbound Slack Web API calls
# are captured locally instead of posted to Slack.

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
THOR_INTERNAL_SECRET="${THOR_INTERNAL_SECRET:-$(docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET 2>/dev/null)}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-$(docker exec thor-gateway-1 printenv SLACK_SIGNING_SECRET 2>/dev/null)}"
SLACK_BOT_USER_ID="${SLACK_BOT_USER_ID:-$(docker exec thor-gateway-1 printenv SLACK_BOT_USER_ID 2>/dev/null)}"
SLACK_CHANNEL_ID="${SLACK_CHANNEL_ID:-C123456789}"
SLACK_THREAD_TS="${SLACK_THREAD_TS:-1778250522.057779}"
JIRA_PROJECT_KEY="${JIRA_PROJECT_KEY:-THOR}"
JIRA_ISSUE_TYPE="${JIRA_ISSUE_TYPE:-Task}"
JIRA_SUMMARY="${JIRA_SUMMARY:-Thor e2e approval card smoke}"
JIRA_DESCRIPTION="${JIRA_DESCRIPTION:-Verify createJiraIssue renders a deterministic Slack approval card and can be rejected without creating Jira side effects.}"
APPROVAL_DIR="${APPROVAL_DIR:-/workspace/repos/acme-multi-hyphen-repo}"
export SLACK_CHANNEL_ID SLACK_THREAD_TS SLACK_BOT_USER_ID JIRA_PROJECT_KEY JIRA_ISSUE_TYPE JIRA_SUMMARY JIRA_DESCRIPTION

passed=0
failed=0

assert() {
  local condition="$1"
  local message="$2"
  local debug="${3:-}"
  if eval "$condition"; then
    echo "  ✓ $message"
    passed=$((passed + 1))
  else
    echo "  ✗ $message"
    [[ -n "$debug" ]] && echo "    → $debug"
    failed=$((failed + 1))
  fi
}

sign_slack_body() {
  local body="$1"
  local ts="$2"
  BODY="$body" TS="$ts" SECRET="$SLACK_SIGNING_SECRET" node -e "
    const crypto = require('crypto');
    const base = 'v0:' + process.env.TS + ':' + process.env.BODY;
    console.log('v0=' + crypto.createHmac('sha256', process.env.SECRET).update(base).digest('hex'));
  "
}

json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | FIELD="$field" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const v = d[process.env.FIELD];
    console.log(v === undefined ? '' : String(v));
  " 2>/dev/null || echo ""
}

exec_stdout_field() {
  local json="$1"
  local field="$2"
  echo "$json" | FIELD="$field" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const stdout = JSON.parse(d.stdout || '{}');
    const v = stdout[process.env.FIELD];
    console.log(v === undefined ? '' : String(v));
  " 2>/dev/null || echo ""
}

fetch_calls() {
  curl -sf "$GATEWAY_URL/internal/e2e/slack-api/calls" \
    -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET"
}

extract_approval_card() {
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const call = [...(d.calls || [])].reverse().find((c) => {
      if (c.method !== 'chat.postMessage') return false;
      const text = JSON.stringify(c.payload?.blocks || []) + ' ' + (c.payload?.text || '');
      return text.includes('Create Jira issue:') && text.includes(process.env.JIRA_SUMMARY);
    });
    if (!call) process.exit(1);
    console.log(JSON.stringify(call));
  "
}

extract_action_value() {
  node -e "
    const call = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const elements = (call.payload.blocks || []).flatMap((b) => b.elements || []);
    const button = elements.find((e) => e.action_id === 'approval_reject');
    console.log(button?.value || '');
  "
}

echo ""
echo "=== createJiraIssue approval card e2e ==="

gateway_health=$(curl -sf "$GATEWAY_URL/health" 2>/dev/null || echo '{}')
remote_cli_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$gateway_health" == *"ok"* ]]' "gateway is healthy" "$gateway_health"
assert '[[ "$remote_cli_health" == *"ok"* ]]' "remote-cli is healthy" "$remote_cli_health"
assert '[[ -n "$THOR_INTERNAL_SECRET" ]]' "THOR_INTERNAL_SECRET is available"
assert '[[ -n "$SLACK_SIGNING_SECRET" ]]' "SLACK_SIGNING_SECRET is available"
assert '[[ -n "$SLACK_BOT_USER_ID" ]]' "SLACK_BOT_USER_ID is available"

curl -sf -X POST "$GATEWAY_URL/internal/e2e/slack-api/reset" \
  -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" >/dev/null

mention_body=$(node -e "
  const body = {
    type: 'event_callback',
    event_id: 'Ev2e-jira-' + Date.now(),
    team_id: 'T_E2E',
    event: {
      type: 'message',
      user: 'U_E2E_REVIEWER',
      channel: process.env.SLACK_CHANNEL_ID,
      thread_ts: process.env.SLACK_THREAD_TS,
      ts: process.env.SLACK_THREAD_TS,
      text: 'createJiraIssue approval-card e2e ingress anchor'
    }
  };
  console.log(JSON.stringify(body));
")
ts=$(date +%s)
sig=$(sign_slack_body "$mention_body" "$ts")
event_status=$(curl -s -o /tmp/thor-jira-event-response.json -w '%{http_code}' -X POST "$GATEWAY_URL/slack/events" \
  -H 'Content-Type: application/json' \
  -H "X-Slack-Request-Timestamp: $ts" \
  -H "X-Slack-Signature: $sig" \
  --data-binary "$mention_body")
assert '[[ "$event_status" == "200" ]]' "fake Slack message webhook accepted" "status=$event_status response=$(tr -d '\n' </tmp/thor-jira-event-response.json 2>/dev/null || true)"

trigger_context_raw=$(curl -sf -X POST "$RUNNER_URL/internal/e2e/trigger-context" \
  -H 'Content-Type: application/json' \
  -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
  -d "{\"correlationKey\":\"slack:thread:$SLACK_THREAD_TS\",\"promptPreview\":\"createJiraIssue approval card e2e context\"}" \
  2>/dev/null || echo '{}')
E2E_THOR_SESSION_ID=$(json_field "$trigger_context_raw" "sessionId")
assert '[[ -n "$E2E_THOR_SESSION_ID" ]]' "runner: created Slack-thread trigger context" "response: ${trigger_context_raw:0:300}"

approval_args_json=$(node -e "
  console.log(JSON.stringify({
    projectKey: process.env.JIRA_PROJECT_KEY,
    issueTypeName: process.env.JIRA_ISSUE_TYPE,
    summary: process.env.JIRA_SUMMARY,
    description: process.env.JIRA_DESCRIPTION,
  }));
")
escaped_approval_args=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$approval_args_json")
call_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
  -H 'Content-Type: application/json' \
  -H "x-thor-session-id: $E2E_THOR_SESSION_ID" \
  -d "{\"args\":[\"atlassian\",\"createJiraIssue\",$escaped_approval_args],\"cwd\":\"$APPROVAL_DIR\",\"directory\":\"$APPROVAL_DIR\"}" \
  2>/dev/null || echo '{}')
approval_event=$(echo "$call_raw" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const candidates = [];
  for (const value of [d.stdout, d.stderr]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try { candidates.push(JSON.parse(value)); } catch {}
  }
  if (Array.isArray(d.content)) {
    for (const item of d.content) {
      if (typeof item?.text !== 'string') continue;
      try { candidates.push(JSON.parse(item.text)); } catch {}
    }
  }
  const event = candidates.find((c) => c?.type === 'approval_required');
  if (!event) process.exit(1);
  console.log(JSON.stringify(event));
" 2>/dev/null || echo "")
action_id=$(echo "$approval_event" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.actionId || '')" 2>/dev/null || echo "")
assert '[[ -n "$approval_event" && -n "$action_id" ]]' "remote-cli: deterministic createJiraIssue returned approval_required" "response: ${call_raw:0:500}"

card_status=""
if [[ -n "$approval_event" ]]; then
  card_status=$(APPROVAL_EVENT="$approval_event" node -e "
    const body = { channel: process.env.SLACK_CHANNEL_ID, threadTs: process.env.SLACK_THREAD_TS, event: JSON.parse(process.env.APPROVAL_EVENT) };
    console.log(JSON.stringify(body));
  " | curl -s -o /tmp/thor-jira-card-response.json -w '%{http_code}' -X POST "$GATEWAY_URL/internal/e2e/approval-card" \
    -H 'Content-Type: application/json' \
    -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
    --data-binary @-)
fi
assert '[[ "$card_status" == "200" ]]' "gateway helper rendered approval card" "status=$card_status response=$(tr -d '\n' </tmp/thor-jira-card-response.json 2>/dev/null || true)"

approval_call=""
calls=$(fetch_calls 2>/dev/null || echo '{}')
approval_call=$(echo "$calls" | JIRA_SUMMARY="$JIRA_SUMMARY" extract_approval_card 2>/dev/null || echo "")

assert '[[ -n "$approval_call" ]]' "captured Jira approval card post" "calls: ${calls:0:1000}"

button_value=""
action_id=""
message_ts=""
if [[ -n "$approval_call" ]]; then
  card_assertions=$(echo "$approval_call" | JIRA_PROJECT_KEY="$JIRA_PROJECT_KEY" JIRA_ISSUE_TYPE="$JIRA_ISSUE_TYPE" JIRA_SUMMARY="$JIRA_SUMMARY" JIRA_DESCRIPTION="$JIRA_DESCRIPTION" SLACK_THREAD_TS="$SLACK_THREAD_TS" node -e "
    const call = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const blocks = call.payload.blocks || [];
    const text = JSON.stringify(blocks);
    const elements = blocks.flatMap((b) => b.elements || []);
    const values = elements.map((e) => e.value).filter(Boolean);
    const checks = {
      title: text.includes('Create Jira issue: ' + process.env.JIRA_SUMMARY),
      project: text.includes('*Project:*') && text.includes(process.env.JIRA_PROJECT_KEY),
      issueType: text.includes('*Issue type:*') && text.includes(process.env.JIRA_ISSUE_TYPE),
      summary: text.includes('*Summary:*') && text.includes(process.env.JIRA_SUMMARY),
      description: text.includes('*Description*') && text.includes(process.env.JIRA_DESCRIPTION),
      noRawJson: !text.includes('\`\`\`json'),
      v3: values.length >= 2 && values.every((v) => v.startsWith('v3:') && v.includes(':atlassian:') && v.endsWith(':' + process.env.SLACK_THREAD_TS)),
    };
    console.log(JSON.stringify(checks));
    process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
  " 2>/dev/null || echo '{}')
  assert '[[ "$card_assertions" == *"\"v3\":true"* ]]' "Jira card renders typed fields and v3 button routing" "$card_assertions"
  button_value=$(echo "$approval_call" | extract_action_value)
  action_id="${button_value#v3:}"
  action_id="${action_id%%:*}"
  message_ts=$(echo "$approval_call" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(c.response?.ts || c.payload?.ts || '')")
fi

assert '[[ -n "$action_id" && "$button_value" == v3:* ]]' "extracted approval action from reject button" "button_value=$button_value"

if [[ -n "$action_id" ]]; then
  payload=$(BUTTON_VALUE="$button_value" MESSAGE_TS="$message_ts" node -e "
    const payload = {
      type: 'block_actions',
      user: { id: 'U_E2E_REVIEWER' },
      channel: { id: process.env.SLACK_CHANNEL_ID },
      message: { ts: process.env.MESSAGE_TS, thread_ts: process.env.SLACK_THREAD_TS },
      container: { type: 'message', channel_id: process.env.SLACK_CHANNEL_ID, message_ts: process.env.MESSAGE_TS, thread_ts: process.env.SLACK_THREAD_TS },
      actions: [{ action_id: 'approval_reject', value: process.env.BUTTON_VALUE }]
    };
    console.log(JSON.stringify(payload));
  ")
  form_body=$(PAYLOAD="$payload" node -e "console.log('payload=' + encodeURIComponent(process.env.PAYLOAD))")
  ts=$(date +%s)
  sig=$(sign_slack_body "$form_body" "$ts")
  reject_status=$(curl -s -o /tmp/thor-jira-reject-response.json -w '%{http_code}' -X POST "$GATEWAY_URL/slack/interactivity" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -H "X-Slack-Request-Timestamp: $ts" \
    -H "X-Slack-Signature: $sig" \
    --data-binary "$form_body")
  assert '[[ "$reject_status" == "200" ]]' "fake Slack reject click accepted" "status=$reject_status response=$(tr -d '\n' </tmp/thor-jira-reject-response.json 2>/dev/null || true)"

  rejected_update=""
  for _ in $(seq 1 30); do
    calls=$(fetch_calls 2>/dev/null || echo '{}')
    rejected_update=$(echo "$calls" | ACTION_ID="$action_id" node -e "
      const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const call = [...(d.calls || [])].reverse().find((c) => c.method === 'chat.update' && String(c.payload?.text || '').includes('Rejected') && String(c.payload?.text || '').includes(process.env.ACTION_ID));
      console.log(call ? JSON.stringify(call) : '');
    " 2>/dev/null || echo "")
    [[ -n "$rejected_update" ]] && break
    sleep 1
  done
  assert '[[ -n "$rejected_update" ]]' "captured rejected Slack update" "calls: ${calls:0:1000}"

  final_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"status\",\"$action_id\"]}" \
    2>/dev/null || echo '{}')
  final_status=$(exec_stdout_field "$final_raw" "status")
  assert '[[ "$final_status" == "rejected" ]]' "remote-cli approval status is rejected" "status=$final_status response=${final_raw:0:300}"
fi

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
fi

echo "ALL TESTS PASSED"
