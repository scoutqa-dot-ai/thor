#!/usr/bin/env bash
#
# Live Slack/OpenCode e2e for the atlassian/createJiraIssue approval card.
# Posts a real seeded Slack thread as the anchor, injects a signed Slack
# app_mention through gateway with the exact Jira arguments the agent must use,
# reads the resulting approval card via Slack Web API, then rejects it through
# the real interactivity route to avoid Jira side effects.

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
SLACK_API_URL="${SLACK_API_URL:-https://slack.com/api}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-$(docker exec thor-gateway-1 printenv SLACK_SIGNING_SECRET 2>/dev/null)}"
SLACK_BOT_USER_ID="${SLACK_BOT_USER_ID:-$(docker exec thor-gateway-1 printenv SLACK_BOT_USER_ID 2>/dev/null)}"
SLACK_CHANNEL_ID="${SLACK_E2E_CHANNEL_ID:-${SLACK_CHANNEL_ID:-}}"
JIRA_PROJECT_KEY="${JIRA_PROJECT_KEY:-THOR}"
JIRA_ISSUE_TYPE="${JIRA_ISSUE_TYPE:-Task}"
RUN_ID="jira-approval-e2e-$(date +%s)"
JIRA_SUMMARY="${JIRA_SUMMARY:-Thor createJiraIssue approval card e2e ${RUN_ID}}"
JIRA_DESCRIPTION="${JIRA_DESCRIPTION:-CreateJiraIssue approval-card e2e. Request approval only; the test will reject this approval to avoid Jira side effects. Marker: ${RUN_ID}}"
export SLACK_CHANNEL_ID SLACK_BOT_USER_ID JIRA_PROJECT_KEY JIRA_ISSUE_TYPE JIRA_SUMMARY JIRA_DESCRIPTION RUN_ID

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
    const path = process.env.FIELD.split('.');
    let v = d;
    for (const part of path) v = v?.[part];
    console.log(v === undefined || v === null ? '' : String(v));
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

slack_post_json() {
  local method="$1"
  local json="$2"
  curl -sS -X POST "$SLACK_API_URL/$method" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data-binary "$json"
}

slack_replies() {
  curl -sS --get "$SLACK_API_URL/conversations.replies" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    --data-urlencode "channel=$SLACK_CHANNEL_ID" \
    --data-urlencode "ts=$seed_ts" \
    --data-urlencode 'limit=50'
}

extract_approval_card() {
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const messages = d.messages || [];
    const message = [...messages].reverse().find((m) => {
      const text = JSON.stringify(m.blocks || []) + ' ' + (m.text || '');
      return text.includes('Create Jira issue:') && text.includes(process.env.JIRA_SUMMARY);
    });
    if (!message) process.exit(1);
    console.log(JSON.stringify(message));
  "
}

extract_action_value() {
  node -e "
    const message = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const elements = (message.blocks || []).flatMap((b) => b.elements || []);
    const button = elements.find((e) => e.action_id === 'approval_reject');
    console.log(button?.value || '');
  "
}

extract_updated_message() {
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const message = (d.messages || []).find((m) => m.ts === process.env.MESSAGE_TS);
    if (!message) process.exit(1);
    console.log(JSON.stringify(message));
  "
}

echo ""
echo "=== createJiraIssue approval card live e2e ==="

gateway_health=$(curl -sf "$GATEWAY_URL/health" 2>/dev/null || echo '{}')
remote_cli_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$gateway_health" == *"ok"* ]]' "gateway is healthy" "$gateway_health"
assert '[[ "$remote_cli_health" == *"ok"* ]]' "remote-cli is healthy" "$remote_cli_health"
assert '[[ -n "$SLACK_BOT_TOKEN" ]]' "SLACK_BOT_TOKEN is available"
assert '[[ -n "$SLACK_SIGNING_SECRET" ]]' "SLACK_SIGNING_SECRET is available"
assert '[[ -n "$SLACK_BOT_USER_ID" ]]' "SLACK_BOT_USER_ID is available"
assert '[[ -n "$SLACK_CHANNEL_ID" ]]' "SLACK_E2E_CHANNEL_ID or SLACK_CHANNEL_ID is set"

seed_text=$(node -e "
  console.log([
    '*createJiraIssue approval-card e2e seed* ' + process.env.RUN_ID,
    'Thor: use the Atlassian MCP tool createJiraIssue with these exact arguments:',
    '- projectKey: ' + process.env.JIRA_PROJECT_KEY,
    '- issueTypeName: ' + process.env.JIRA_ISSUE_TYPE,
    '- summary: ' + process.env.JIRA_SUMMARY,
    '- description: ' + process.env.JIRA_DESCRIPTION,
    'The signed app_mention event repeats these exact arguments; the seed is only the real Slack thread anchor/context.'
  ].join('\n'));
")
seed_json=$(SEED_TEXT="$seed_text" node -e "
  console.log(JSON.stringify({ channel: process.env.SLACK_CHANNEL_ID, text: process.env.SEED_TEXT }));
")
seed_raw=$(slack_post_json "chat.postMessage" "$seed_json")
seed_ok=$(json_field "$seed_raw" "ok")
seed_ts=$(json_field "$seed_raw" "ts")
assert '[[ "$seed_ok" == "true" && -n "$seed_ts" ]]' "seeded real Slack thread message" "response: ${seed_raw:0:500}"
export seed_ts

event_body=$(node -e "
  const instruction = [
    '<@' + process.env.SLACK_BOT_USER_ID + '> createJiraIssue approval-card e2e ' + process.env.RUN_ID + '.',
    'Use the Atlassian MCP tool createJiraIssue with exactly these arguments:',
    'projectKey: ' + process.env.JIRA_PROJECT_KEY,
    'issueTypeName: ' + process.env.JIRA_ISSUE_TYPE,
    'summary: ' + process.env.JIRA_SUMMARY,
    'description: ' + process.env.JIRA_DESCRIPTION,
    'Request approval and stop. Do not approve or reject the request yourself. Do not ask clarifying questions.'
  ].join('\n');
  const body = {
    type: 'event_callback',
    event_id: 'Ev2e-jira-' + Date.now(),
    team_id: 'T_E2E',
    event: {
      type: 'app_mention',
      user: 'U_E2E_REVIEWER',
      channel: process.env.SLACK_CHANNEL_ID,
      thread_ts: process.env.seed_ts,
      ts: process.env.seed_ts,
      text: instruction
    }
  };
  console.log(JSON.stringify(body));
")
ts=$(date +%s)
sig=$(sign_slack_body "$event_body" "$ts")
event_status=$(curl -s -o /tmp/thor-jira-event-response.json -w '%{http_code}' -X POST "$GATEWAY_URL/slack/events" \
  -H 'Content-Type: application/json' \
  -H "X-Slack-Request-Timestamp: $ts" \
  -H "X-Slack-Signature: $sig" \
  --data-binary "$event_body")
assert '[[ "$event_status" == "200" ]]' "fake signed Slack app_mention accepted" "status=$event_status response=$(tr -d '\n' </tmp/thor-jira-event-response.json 2>/dev/null || true)"

approval_message=""
replies=""
for _ in $(seq 1 72); do
  replies=$(slack_replies 2>/dev/null || echo '{}')
  approval_message=$(echo "$replies" | JIRA_SUMMARY="$JIRA_SUMMARY" extract_approval_card 2>/dev/null || echo "")
  [[ -n "$approval_message" ]] && break
  sleep 5
done
assert '[[ -n "$approval_message" ]]' "found Jira approval card via Slack conversations.replies" "replies: ${replies:0:1000}"

button_value=""
action_id=""
message_ts=""
if [[ -n "$approval_message" ]]; then
  card_assertions=$(echo "$approval_message" | JIRA_PROJECT_KEY="$JIRA_PROJECT_KEY" JIRA_ISSUE_TYPE="$JIRA_ISSUE_TYPE" JIRA_SUMMARY="$JIRA_SUMMARY" JIRA_DESCRIPTION="$JIRA_DESCRIPTION" seed_ts="$seed_ts" node -e "
    const message = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const blocks = message.blocks || [];
    const text = JSON.stringify(blocks) + ' ' + (message.text || '');
    const elements = blocks.flatMap((b) => b.elements || []);
    const values = elements.map((e) => e.value).filter(Boolean);
    const checks = {
      title: text.includes('Create Jira issue: ' + process.env.JIRA_SUMMARY),
      project: text.includes('*Project:*') && text.includes(process.env.JIRA_PROJECT_KEY),
      issueType: text.includes('*Issue type:*') && text.includes(process.env.JIRA_ISSUE_TYPE),
      summary: text.includes('*Summary:*') && text.includes(process.env.JIRA_SUMMARY),
      description: text.includes('*Description*') && text.includes(process.env.JIRA_DESCRIPTION),
      noRawJson: !text.includes('\`\`\`json'),
      v3: values.length >= 2 && values.every((v) => v.startsWith('v3:') && v.includes(':atlassian:') && v.endsWith(':' + process.env.seed_ts)),
    };
    console.log(JSON.stringify(checks));
    process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
  " 2>/dev/null || echo '{}')
  assert '[[ "$card_assertions" == *"\"v3\":true"* ]]' "Jira card renders typed fields and v3 button routing" "$card_assertions"
  button_value=$(echo "$approval_message" | extract_action_value)
  action_id="${button_value#v3:}"
  action_id="${action_id%%:*}"
  message_ts=$(echo "$approval_message" | node -e "const m=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(m.ts || '')")
fi
export message_ts

assert '[[ -n "$action_id" && "$button_value" == v3:* && -n "$message_ts" ]]' "extracted approval action from Slack reject button" "button_value=$button_value message_ts=$message_ts"

if [[ -n "$action_id" ]]; then
  payload=$(BUTTON_VALUE="$button_value" MESSAGE_TS="$message_ts" node -e "
    const payload = {
      type: 'block_actions',
      user: { id: 'U_E2E_REVIEWER' },
      channel: { id: process.env.SLACK_CHANNEL_ID },
      message: { ts: process.env.MESSAGE_TS, thread_ts: process.env.seed_ts },
      container: { type: 'message', channel_id: process.env.SLACK_CHANNEL_ID, message_ts: process.env.MESSAGE_TS, thread_ts: process.env.seed_ts },
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
  assert '[[ "$reject_status" == "200" ]]' "fake signed Slack reject click accepted" "status=$reject_status response=$(tr -d '\n' </tmp/thor-jira-reject-response.json 2>/dev/null || true)"

  updated_message=""
  for _ in $(seq 1 30); do
    replies=$(slack_replies 2>/dev/null || echo '{}')
    updated_message=$(echo "$replies" | MESSAGE_TS="$message_ts" extract_updated_message 2>/dev/null || echo "")
    if [[ "$updated_message" == *"Rejected"* && "$updated_message" == *"$action_id"* ]]; then
      break
    fi
    sleep 2
  done
  assert '[[ "$updated_message" == *"Rejected"* && "$updated_message" == *"$action_id"* ]]' "verified rejected Slack update via conversations.replies" "message: ${updated_message:0:1000}"

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
