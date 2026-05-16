#!/usr/bin/env bash
#
# Minimal OpenCode/LLM smoke test for Thor.
#
# This script intentionally calls runner /trigger and may incur model cost.
# Keep deterministic service/policy checks in scripts/test-e2e.sh.
#
# Prerequisites:
#   - runner, remote-cli, gateway, and OpenCode running
#   - LLM provider credentials configured for OpenCode
#
# Usage:
#   ./scripts/test-opencode-e2e.sh
#   RUNNER_URL=http://localhost:3000 REMOTE_CLI_URL=http://localhost:3004 ./scripts/test-opencode-e2e.sh
#
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
SESSION_DIR="${SESSION_DIR:-/workspace/repos/e2e-test}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
REMOTE_CLI_GIT_REPO_URL="${REMOTE_CLI_GIT_REPO_URL:-https://github.com/scoutqa-dot-ai/thor}"
REMOTE_CLI_GIT_REPO_NAME="${REMOTE_CLI_GIT_REPO_NAME:-scoutqa-dot-ai-thor-opencode-e2e}"
REMOTE_CLI_GIT_REPO_DIR="${REMOTE_CLI_GIT_REPO_DIR:-/workspace/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_DIR="${HOST_REMOTE_CLI_GIT_REPO_DIR:-${HOST_WORKSPACE}/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
THOR_INTERNAL_SECRET="${THOR_INTERNAL_SECRET:-$(docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET 2>/dev/null)}"

mkdir -p "${HOST_WORKSPACE}/repos/e2e-test"

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
    if [[ -n "$debug" ]]; then
      echo "    → $debug"
    fi
    failed=$((failed + 1))
  fi
}

parse_done() {
  node -e "
    const input = require('fs').readFileSync(0,'utf8').trim();
    const lines = input ? input.split('\n') : [];
    for (const line of lines.reverse()) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'done') { console.log(JSON.stringify(d)); process.exit(0); }
      } catch {}
    }
    console.log('{}');
  " 2>/dev/null
}

json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | FIELD="$field" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const v = d[process.env.FIELD];
    console.log(v === undefined ? '' : typeof v === 'boolean' ? String(v) : String(v));
  " 2>/dev/null || echo ""
}

exec_stdout_field() {
  local json="$1"
  local field="$2"
  echo "$json" | FIELD="$field" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const stdout = JSON.parse(d.stdout || '{}');
    const v = stdout[process.env.FIELD];
    console.log(v === undefined ? '' : typeof v === 'boolean' ? String(v) : String(v));
  " 2>/dev/null || echo ""
}

response_contains() {
  local json="$1"
  local needle="$2"
  echo "$json" | NEEDLE="$needle" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
    console.log(text.includes(process.env.NEEDLE) ? 'yes' : 'no');
  " 2>/dev/null || echo "no"
}

resolve_remote_cli_container() {
  if [[ -n "${REMOTE_CLI_CONTAINER:-}" ]]; then
    echo "$REMOTE_CLI_CONTAINER"
    return 0
  fi

  docker ps --filter label=com.docker.compose.service=remote-cli --format '{{.Names}}' 2>/dev/null | head -n 1
}

approval_tool_for_upstream() {
  case "$1" in
    atlassian) echo "createJiraIssue" ;;
    posthog) echo "create-feature-flag" ;;
    *) echo "" ;;
  esac
}

extract_action_id() {
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const parts = [d.stdout || '', d.stderr || ''];
    if (Array.isArray(d.content)) parts.push(...d.content.map(c => c.text || ''));
    const text = parts.join(' ');
    const m = text.match(/\"actionId\"\s*:\s*\"([^\"]+)\"/);
    console.log(m ? m[1] : '');
  " 2>/dev/null || echo ""
}

echo ""
echo "=== Prerequisites ==="
echo "  ℹ OpenCode smoke enabled: this script calls /trigger and may incur LLM cost"

remote_cli_container=$(resolve_remote_cli_container)
remote_cli_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')
runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
gateway_health=$(curl -sf "$GATEWAY_URL/health" 2>/dev/null || echo '{}')

preflight_ok=true
if [[ -z "$remote_cli_container" ]]; then
  echo "  ✗ remote-cli container not found (set REMOTE_CLI_CONTAINER or start the compose service)"
  preflight_ok=false
else
  echo "  ✓ remote-cli container: $remote_cli_container"
fi
if [[ "$remote_cli_health" == *"ok"* ]]; then echo "  ✓ remote-cli is healthy"; else echo "  ✗ remote-cli is not healthy at $REMOTE_CLI_URL"; preflight_ok=false; fi
if [[ "$runner_health" == *"ok"* ]]; then echo "  ✓ runner is healthy"; else echo "  ✗ runner is not healthy at $RUNNER_URL"; preflight_ok=false; fi
if [[ "$gateway_health" == *"ok"* ]]; then echo "  ✓ gateway is healthy"; else echo "  ✗ gateway is not healthy at $GATEWAY_URL"; preflight_ok=false; fi

if [[ "$preflight_ok" != "true" ]]; then
  echo ""
  echo "FAIL — prerequisites not met"
  exit 1
fi

echo ""
echo "=== Agent wrapper command ==="
rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
mkdir -p "$(dirname "$HOST_REMOTE_CLI_GIT_REPO_DIR")"
clone_output=$(docker exec "$remote_cli_container" git clone "$REMOTE_CLI_GIT_REPO_URL" "$REMOTE_CLI_GIT_REPO_DIR" 2>&1 || true)
assert '[[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]' "cloned smoke repo for agent command" "output: ${clone_output:0:300}"

GH_CORR_KEY="opencode-e2e-gh-$(date +%s)"
echo "  Asking agent to run gh pr list..."
gh_trigger_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Run: gh pr list --limit 5\\nIf the command succeeds, reply with GH_PR_LIST_OK on the first line, then summarize the result in one short sentence. If the command fails, reply with GH_PR_LIST_FAILED on the first line and include the error.\",\"correlationKey\":\"$GH_CORR_KEY\",\"directory\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
gh_trigger=$(echo "$gh_trigger_raw" | parse_done)
gh_session=$(json_field "$gh_trigger" "sessionId")
gh_status=$(json_field "$gh_trigger" "status")
gh_response_text=$(json_field "$gh_trigger" "response")
gh_response_ok=$(response_contains "$gh_trigger" "GH_PR_LIST_OK")
assert '[[ -n "$gh_session" ]]' "agent command: got a session ID" "sessionId='$gh_session'"
assert '[[ "$gh_status" == "completed" ]]' "agent command: completed successfully" "status='$gh_status'"
assert '[[ "$gh_response_ok" == "yes" ]]' "agent command: successfully listed PRs" "response: ${gh_response_text:0:300}"

echo ""
echo "=== Session resume ==="
RESUME_CORR_KEY="slack:thread:opencode-e2e-resume-$(date +%s)"
PHRASE="THOR$(date +%s | tail -c 6)"
trigger1_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Our team mascot name is $PHRASE. Confirm by repeating the mascot name back to me.\",\"correlationKey\":\"$RESUME_CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger1=$(echo "$trigger1_raw" | parse_done)
session1=$(json_field "$trigger1" "sessionId")
resumed1=$(json_field "$trigger1" "resumed")
response1_has_phrase=$(response_contains "$trigger1" "$PHRASE")
response1_text=$(json_field "$trigger1" "response")
assert '[[ -n "$session1" ]]' "resume trigger #1: got a session ID" "sessionId='$session1'"
assert '[[ "$resumed1" == "false" ]]' "resume trigger #1: was not resumed" "resumed='$resumed1'"
assert '[[ "$response1_has_phrase" == "yes" ]]' "resume trigger #1: agent confirmed phrase" "response: ${response1_text:0:200}"

trigger2_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What is our team mascot name? Reply with just the name, nothing else.\",\"correlationKey\":\"$RESUME_CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger2=$(echo "$trigger2_raw" | parse_done)
session2=$(json_field "$trigger2" "sessionId")
resumed2=$(json_field "$trigger2" "resumed")
response2_has_phrase=$(response_contains "$trigger2" "$PHRASE")
response2_text=$(json_field "$trigger2" "response")
assert '[[ "$session2" == "$session1" ]]' "resume trigger #2: reused same session ID" "expected='$session1', got='$session2'"
assert '[[ "$resumed2" == "true" ]]' "resume trigger #2: was resumed" "resumed='$resumed2'"
assert '[[ "$response2_has_phrase" == "yes" ]]' "resume trigger #2: agent recalled phrase" "response: ${response2_text:0:200}"

echo ""
echo "=== Approval-status re-entry ==="
APPROVAL_UPSTREAM=""
APPROVAL_TOOL=""
APPROVAL_DIR=""
APPROVAL_DISCOVERY_DEBUG=""

if [[ "$remote_cli_health" != *'"status":"ok"'* ]]; then
  APPROVAL_DISCOVERY_DEBUG="remote-cli health unavailable at $REMOTE_CLI_URL"
else
  connected_upstreams=$(node -e "
    const health = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const connected = new Set(Object.entries(health.mcp?.instances || {}).filter(([, info]) => info && info.connected).map(([name]) => name));
    for (const upstream of connected) console.log(upstream);
  " <<<"$remote_cli_health" 2>/dev/null || echo "")

  approval_repo="${SLACK_DEFAULT_REPO:-}"
  if [[ -z "$approval_repo" || ! -d "${HOST_WORKSPACE}/repos/$approval_repo" ]]; then
    approval_repo=$(ls -1 "${HOST_WORKSPACE}/repos" 2>/dev/null | head -n 1)
  fi

  if [[ -z "$connected_upstreams" ]]; then
    APPROVAL_DISCOVERY_DEBUG="No MCP upstream is connected. Check $REMOTE_CLI_URL/health."
  elif [[ -z "$approval_repo" || ! -d "${HOST_WORKSPACE}/repos/$approval_repo" ]]; then
    APPROVAL_DISCOVERY_DEBUG="No repo found under ${HOST_WORKSPACE}/repos."
  else
    while IFS= read -r upstream_name; do
      [[ -n "$upstream_name" ]] || continue
      found_tool="$(approval_tool_for_upstream "$upstream_name")"
      if [[ -n "$found_tool" ]]; then
        APPROVAL_UPSTREAM="$upstream_name"
        APPROVAL_TOOL="$found_tool"
        APPROVAL_DIR="/workspace/repos/$approval_repo"
        break
      fi
      APPROVAL_DISCOVERY_DEBUG="${APPROVAL_DISCOVERY_DEBUG:+$APPROVAL_DISCOVERY_DEBUG; }upstream $upstream_name has no approval-required tool in e2e map"
    done <<<"$connected_upstreams"
  fi
fi

if [[ -z "$APPROVAL_TOOL" ]]; then
  echo "  ⚠ No discoverable approval-required tool; skipping approval re-entry smoke (${APPROVAL_DISCOVERY_DEBUG:-no matching connected upstream})"
elif [[ -z "$THOR_INTERNAL_SECRET" ]]; then
  echo "  ⚠ THOR_INTERNAL_SECRET unavailable; skipping approval re-entry smoke"
else
  echo "  Creating pending approval via $APPROVAL_UPSTREAM/$APPROVAL_TOOL..."
  e2e_call_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"$APPROVAL_UPSTREAM\",\"$APPROVAL_TOOL\",\"{}\"],\"cwd\":\"$APPROVAL_DIR\",\"directory\":\"$APPROVAL_DIR\"}" \
    2>/dev/null || echo '{}')
  e2e_action_id=$(echo "$e2e_call_raw" | extract_action_id)

  if [[ -z "$e2e_action_id" ]]; then
    echo "  ⚠ Could not create pending approval — skipping approval re-entry smoke"
  else
    curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
      -H 'Content-Type: application/json' \
      -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
      -d "{\"args\":[\"resolve\",\"$e2e_action_id\",\"rejected\",\"opencode-e2e\",\"opencode e2e automated rejection\"]}" \
      2>/dev/null >/dev/null

    final_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
      -H 'Content-Type: application/json' \
      -d "{\"args\":[\"status\",\"$e2e_action_id\"]}" \
      2>/dev/null || echo '{}')
    final_status=$(exec_stdout_field "$final_raw" "status")
    assert '[[ "$final_status" == "rejected" ]]' "approval setup: final direct status is rejected" "status='$final_status'"

    approval_trigger_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
      -H 'Content-Type: application/json' \
      -d "{\"prompt\":\"Run: approval status $e2e_action_id\\nThen tell me the status field.\",\"correlationKey\":\"opencode-e2e-approval-$(date +%s)\",\"directory\":\"$APPROVAL_DIR\"}" \
      --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
    approval_trigger=$(echo "$approval_trigger_raw" | parse_done)
    approval_session=$(json_field "$approval_trigger" "sessionId")
    approval_trigger_text=$(json_field "$approval_trigger" "response")
    response_has_rejected=$(echo "$approval_trigger" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const text = ((d.response || '') + JSON.stringify(d.toolCalls || [])).toLowerCase();
      console.log(text.includes('rejected') || text.includes('rejection') ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
    assert '[[ -n "$approval_session" ]]' "approval re-entry: got a session ID" "sessionId='$approval_session'"
    assert '[[ "$response_has_rejected" == "yes" ]]' "approval re-entry: agent confirms rejection" "response: ${approval_trigger_text:0:300}"
  fi
fi

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

[[ "$SESSION_DIR" == "/workspace/repos/e2e-test" && -n "$HOST_WORKSPACE" ]] && rm -rf "${HOST_WORKSPACE}/repos/e2e-test"
[[ -n "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
