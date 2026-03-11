#!/usr/bin/env bash
#
# End-to-end test for Thor PoC (Phase 4).
#
# Tests the full chain: curl -> runner -> OpenCode service -> per-upstream proxies -> MCP servers
#
# Prerequisites:
#   - Both services running (either `pnpm dev` with LINEAR_API_KEY, or `docker compose up`)
#   - OpenCode configured with an LLM provider in the runner environment
#
# Usage:
#   OPENCODE_SERVER_PASSWORD=... ./scripts/test-e2e.sh
#   RUNNER_URL=http://localhost:3000 OPENCODE_URL=http://localhost:4096 OPENCODE_SERVER_PASSWORD=... ./scripts/test-e2e.sh
#
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
PROXY_LINEAR_URL="${PROXY_LINEAR_URL:-http://localhost:3010}"
OPENCODE_URL="${OPENCODE_URL:-http://localhost:4096}"
OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"

if [[ -z "$OPENCODE_SERVER_PASSWORD" ]]; then
  echo "OPENCODE_SERVER_PASSWORD is required"
  exit 1
fi

passed=0
failed=0

assert() {
  local condition="$1"
  local message="$2"
  if eval "$condition"; then
    echo "  ✓ $message"
    passed=$((passed + 1))
  else
    echo "  ✗ $message"
    failed=$((failed + 1))
  fi
}

# ── 1. Health checks ────────────────────────────────────────────────────────

echo ""
echo "=== Health Checks ==="

proxy_health=$(curl -sf "$PROXY_LINEAR_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$proxy_health" == *"ok"* ]]' "Proxy (linear) is healthy"

runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$runner_health" == *"ok"* ]]' "Runner is healthy"

# ── 2. Trigger: list tools ──────────────────────────────────────────────────

echo ""
echo "=== Trigger: List Tools ==="
echo "  (this may take a moment while the agent session runs)"

list_response=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List the tools available to you. Only list tool names from linear or posthog, one per line. Nothing else."}' \
  --max-time 180 2>/dev/null || echo '{"error":"request failed"}')

assert '[[ "$list_response" == *"sessionId"* ]]' "Got a session ID"
# Check the response text OR the raw JSON for tool names (LLM prose is non-deterministic)
list_has_linear=$(echo "$list_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
  console.log(text.includes('get_issue') || text.includes('list_issues') || text.includes('insight-query') ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$list_has_linear" == "yes" ]]' "Response mentions proxied tools (linear or posthog)"

list_has_issues=$(echo "$list_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
  console.log(text.includes('list_issues') ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$list_has_issues" == "yes" ]]' "Response mentions list_issues tool"

# ── 3. Trigger: actual tool call ────────────────────────────────────────────

echo ""
echo "=== Trigger: Tool Call (list issues) ==="

issues_response=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Use the linear tools to list the 2 most recent Linear issues. Show their identifier, title, and status in a table."}' \
  --max-time 180 2>/dev/null || echo '{"error":"request failed"}')

assert '[[ "$issues_response" == *"sessionId"* ]]' "Got a session ID"
assert '[[ "$issues_response" == *"toolCalls"* ]]' "Response contains toolCalls field"
assert '[[ "$issues_response" == *"list_issues"* ]]' "Tool calls include list_issues"

# Check that we got actual content (not just an error)
has_response=$(echo "$issues_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.response && d.response.length > 20 ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$has_response" == "yes" ]]' "Response contains substantive content"

# ── 4. Memory continuity: session resume + notes ────────────────────────────

echo ""
echo "=== Memory Continuity: Session Resume + Notes ==="

CORR_KEY="e2e-test-$(date +%s)"
WORKLOG_DIR="${WORKLOG_DIR:-./docker-volumes/worklog}"
TODAY=$(date +%Y-%m-%d)
NOTES_FILE="$WORKLOG_DIR/$TODAY/notes/$(echo "$CORR_KEY" | sed 's/[^a-zA-Z0-9_-]/-/g; s/-\+/-/g').md"

# Generate a random code word so the agent can only know it from trigger #1
SECRET_CODE="THOR$(date +%s | tail -c 6)"

# 4b. First trigger — tell the agent a secret code word
echo "  Sending trigger #1 (new session — planting secret code: $SECRET_CODE)..."
trigger1=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Remember this secret code for later: $SECRET_CODE. Confirm you have noted it by repeating the code back to me.\",\"correlationKey\":\"$CORR_KEY\"}" \
  --max-time 180 2>/dev/null || echo '{"error":"request failed"}')

session1=$(echo "$trigger1" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.sessionId || '');
" 2>/dev/null || echo "")

resumed1=$(echo "$trigger1" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.resumed === true ? 'true' : 'false');
" 2>/dev/null || echo "")

# Check that the agent echoed the code back in trigger #1
response1_has_code=$(echo "$trigger1" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log((d.response || '').includes('$SECRET_CODE') ? 'yes' : 'no');
" 2>/dev/null || echo "no")

assert '[[ -n "$session1" ]]' "Trigger #1: got a session ID"
assert '[[ "$resumed1" == "false" ]]' "Trigger #1: was NOT a resumed session"
assert '[[ "$response1_has_code" == "yes" ]]' "Trigger #1: agent confirmed the secret code"
assert '[[ -f "$NOTES_FILE" ]]' "Trigger #1: notes file created"

if [[ -f "$NOTES_FILE" ]]; then
  assert 'grep -q "$SECRET_CODE" "$NOTES_FILE"' "Trigger #1: notes file contains the secret code"
fi

# 4c. Verify session exists in OpenCode via its native API
oc_session=$(
  curl -sf -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
    "$OPENCODE_URL/session/$session1" 2>/dev/null || echo '{}'
)
oc_session_id=$(echo "$oc_session" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.id || '');
" 2>/dev/null || echo "")

assert '[[ "$oc_session_id" == "$session1" ]]' "OpenCode API confirms session exists"

# 4d. Second trigger — ask the agent to recall the secret code
echo "  Sending trigger #2 (resume session — asking agent to recall the code)..."
trigger2=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What was the secret code I told you earlier? Reply with just the code, nothing else.\",\"correlationKey\":\"$CORR_KEY\"}" \
  --max-time 180 2>/dev/null || echo '{"error":"request failed"}')

session2=$(echo "$trigger2" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.sessionId || '');
" 2>/dev/null || echo "")

resumed2=$(echo "$trigger2" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.resumed === true ? 'true' : 'false');
" 2>/dev/null || echo "")

# The critical assertion: the agent must recall the code from the previous turn
response2_has_code=$(echo "$trigger2" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log((d.response || '').includes('$SECRET_CODE') ? 'yes' : 'no');
" 2>/dev/null || echo "no")

assert '[[ "$session2" == "$session1" ]]' "Trigger #2: reused the SAME session ID"
assert '[[ "$resumed2" == "true" ]]' "Trigger #2: was a resumed session"
assert '[[ "$response2_has_code" == "yes" ]]' "Trigger #2: agent recalled the secret code ($SECRET_CODE)"

if [[ -f "$NOTES_FILE" ]]; then
  assert 'grep -q "Follow-up" "$NOTES_FILE"' "Trigger #2: notes file has follow-up entry"
  assert 'grep -q "Result" "$NOTES_FILE"' "Trigger #2: notes file has result summary"
fi

echo ""
echo "  Notes file content:"
if [[ -f "$NOTES_FILE" ]]; then
  head -40 "$NOTES_FILE" | sed 's/^/    /'
else
  echo "    (not found)"
fi

# ── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
