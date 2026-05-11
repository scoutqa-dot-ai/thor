#!/usr/bin/env bash
#
# Live Slack/OpenCode e2e for approval-card rendering of Atlassian approval-
# required MCP tools. The script posts a real Slack thread anchor, injects a
# signed app_mention through gateway with exact tool arguments, then verifies
# the resulting pending approval cards via Slack Web API reads. It intentionally
# leaves approvals pending so humans can inspect the rendered Slack messages.

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
SLACK_API_URL="${SLACK_API_URL:-https://slack.com/api}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-$(docker exec thor-gateway-1 printenv SLACK_SIGNING_SECRET 2>/dev/null)}"
SLACK_BOT_USER_ID="${SLACK_BOT_USER_ID:-$(docker exec thor-gateway-1 printenv SLACK_BOT_USER_ID 2>/dev/null)}"
SLACK_CHANNEL_ID="${SLACK_E2E_CHANNEL_ID:-${SLACK_CHANNEL_ID:-}}"
RUN_ID="approval-cards-e2e-$(date +%s)"

JIRA_PROJECT_KEY="${JIRA_PROJECT_KEY:-THOR}"
JIRA_ISSUE_TYPE="${JIRA_ISSUE_TYPE:-Task}"
JIRA_SUMMARY="${JIRA_SUMMARY:-Thor createJiraIssue approval card e2e ${RUN_ID}}"
JIRA_DESCRIPTION="${JIRA_DESCRIPTION:-CreateJiraIssue approval-card e2e. Leave pending for human inspection. Marker: ${RUN_ID}}"
JIRA_COMMENT_ISSUE_KEY="${JIRA_COMMENT_ISSUE_KEY:-${JIRA_PROJECT_KEY}-123}"
JIRA_COMMENT_BODY="${JIRA_COMMENT_BODY:-AddCommentToJiraIssue approval-card e2e. Leave pending for human inspection. Marker: ${RUN_ID}}"
export SLACK_CHANNEL_ID SLACK_BOT_USER_ID RUN_ID
export JIRA_PROJECT_KEY JIRA_ISSUE_TYPE JIRA_SUMMARY JIRA_DESCRIPTION JIRA_COMMENT_ISSUE_KEY JIRA_COMMENT_BODY

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
    --data-urlencode 'limit=100'
}

find_approval_card() {
  local key="$1"
  local title="$2"
  local upstream="$3"
  local needles_json="$4"
  echo "$replies" | EXPECT_KEY="$key" EXPECT_TITLE="$title" EXPECT_UPSTREAM="$upstream" EXPECT_NEEDLES_JSON="$needles_json" SEED_TS="$seed_ts" node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const needles = JSON.parse(process.env.EXPECT_NEEDLES_JSON || '[]');
    const messages = d.messages || [];
    const message = [...messages].reverse().find((m) => {
      const text = JSON.stringify(m.blocks || []) + ' ' + (m.text || '');
      return text.includes(process.env.EXPECT_TITLE) && needles.every((needle) => text.includes(needle));
    });
    if (!message) process.exit(1);

    const text = JSON.stringify(message.blocks || []) + ' ' + (message.text || '');
    const elements = (message.blocks || []).flatMap((b) => b.elements || []);
    const buttons = elements.filter((e) => e.type === 'button');
    const values = buttons.map((e) => e.value).filter(Boolean);
    const ok =
      !text.includes('\`\`\`json') &&
      values.length >= 2 &&
      values.some((value) => value.startsWith('v3:') && value.includes(':' + process.env.EXPECT_UPSTREAM + ':') && value.endsWith(':' + process.env.SEED_TS)) &&
      buttons.some((button) => button.action_id === 'approval_approve') &&
      buttons.some((button) => button.action_id === 'approval_reject');
    if (!ok) process.exit(2);
    const value = values.find((candidate) => candidate.startsWith('v3:')) || '';
    const actionId = value.startsWith('v3:') ? value.slice(3).split(':')[0] : '';
    console.log(JSON.stringify({ key: process.env.EXPECT_KEY, ts: message.ts, actionId, value }));
  "
}

echo ""
echo "=== approval-card live e2e (pending inspection mode) ==="

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
    '*approval-card e2e seed* ' + process.env.RUN_ID,
    'This thread is a live Slack anchor for rendering Atlassian approval-required tools.',
    'The signed app_mention repeats the exact tool arguments so the agent sees them through gateway ingress.',
    'The test leaves all approvals pending for human inspection.'
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
    '<@' + process.env.SLACK_BOT_USER_ID + '> approval-card e2e ' + process.env.RUN_ID + '.',
    'Call each Atlassian approval-required MCP tool below exactly once. Request approval for each and leave every approval pending. Do not approve or reject anything. Do not ask clarifying questions.',
    '',
    '1. atlassian createJiraIssue args:',
    JSON.stringify({ projectKey: process.env.JIRA_PROJECT_KEY, issueTypeName: process.env.JIRA_ISSUE_TYPE, summary: process.env.JIRA_SUMMARY, description: process.env.JIRA_DESCRIPTION }),
    '',
    '2. atlassian addCommentToJiraIssue args:',
    JSON.stringify({ issueIdOrKey: process.env.JIRA_COMMENT_ISSUE_KEY, commentBody: process.env.JIRA_COMMENT_BODY }),
    '',
    'Do not call any PostHog approval tools in this run.'
  ].join('\n');
  const body = {
    type: 'event_callback',
    event_id: 'Ev2e-approval-cards-' + Date.now(),
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
event_status=$(curl -s -o /tmp/thor-approval-cards-event-response.json -w '%{http_code}' -X POST "$GATEWAY_URL/slack/events" \
  -H 'Content-Type: application/json' \
  -H "X-Slack-Request-Timestamp: $ts" \
  -H "X-Slack-Signature: $sig" \
  --data-binary "$event_body")
assert '[[ "$event_status" == "200" ]]' "fake signed Slack app_mention with all approval instructions accepted" "status=$event_status response=$(tr -d '\n' </tmp/thor-approval-cards-event-response.json 2>/dev/null || true)"

declare -A CARD_JSON_BY_KEY=()
declare -A ACTION_ID_BY_KEY=()

expect_card() {
  local key="$1"
  local title="$2"
  local upstream="$3"
  local needles_json="$4"
  local result
  result=$(find_approval_card "$key" "$title" "$upstream" "$needles_json" 2>/dev/null || echo "")
  if [[ -n "$result" ]]; then
    CARD_JSON_BY_KEY["$key"]="$result"
    ACTION_ID_BY_KEY["$key"]=$(json_field "$result" "actionId")
    return 0
  fi
  return 1
}

for _ in $(seq 1 96); do
  replies=$(slack_replies 2>/dev/null || echo '{}')
  expect_card "createJiraIssue" "Create Jira issue: $JIRA_SUMMARY" "atlassian" "$(node -e 'console.log(JSON.stringify([process.env.JIRA_PROJECT_KEY, process.env.JIRA_ISSUE_TYPE, process.env.JIRA_DESCRIPTION]))')" || true
  expect_card "addCommentToJiraIssue" "Comment on Jira issue: $JIRA_COMMENT_ISSUE_KEY" "atlassian" "$(node -e 'console.log(JSON.stringify([process.env.JIRA_COMMENT_BODY]))')" || true
  if [[ ${#CARD_JSON_BY_KEY[@]} -eq 2 ]]; then
    break
  fi
  sleep 5
done

for key in createJiraIssue addCommentToJiraIssue; do
  assert '[[ -n "${CARD_JSON_BY_KEY[$key]:-}" ]]' "found pending approval card for $key via Slack conversations.replies" "replies: ${replies:0:1000}"
  assert '[[ -n "${ACTION_ID_BY_KEY[$key]:-}" ]]' "extracted pending action ID for $key" "card: ${CARD_JSON_BY_KEY[$key]:-}"
done

for key in createJiraIssue addCommentToJiraIssue; do
  action_id="${ACTION_ID_BY_KEY[$key]:-}"
  if [[ -n "$action_id" ]]; then
    status_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
      -H 'Content-Type: application/json' \
      -d "{\"args\":[\"status\",\"$action_id\"]}" \
      2>/dev/null || echo '{}')
    status_val=$(exec_stdout_field "$status_raw" "status")
    assert '[[ "$status_val" == "pending" ]]' "remote-cli approval for $key remains pending" "status=$status_val response=${status_raw:0:300}"
  fi
done

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
fi

echo "ALL TESTS PASSED"
