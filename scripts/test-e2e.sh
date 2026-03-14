#!/usr/bin/env bash
#
# End-to-end test for Thor.
#
# Tests the full chain: curl -> runner -> OpenCode service -> per-upstream proxies -> MCP servers
#
# Prerequisites:
#   - Both services running (either `pnpm dev` with LINEAR_API_KEY, or `docker compose up`)
#   - OpenCode configured with an LLM provider in the runner environment
#
# Usage:
#   ./scripts/test-e2e.sh
#   RUNNER_URL=http://localhost:3000 OPENCODE_URL=http://localhost:4096 ./scripts/test-e2e.sh
#
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
PROXY_LINEAR_URL="${PROXY_LINEAR_URL:-http://localhost:3010}"
OPENCODE_URL="${OPENCODE_URL:-http://localhost:4096}"
WORKLOG_DIR="${WORKLOG_DIR:-./docker-volumes/workspace/worklog}"
MEMORY_DIR="${MEMORY_DIR:-./docker-volumes/workspace/memory}"
TODAY=$(date +%Y-%m-%d)

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

# Helper: extract the "done" event from NDJSON response
parse_done() {
  node -e "
    const lines = require('fs').readFileSync(0,'utf8').trim().split('\n');
    for (const line of lines.reverse()) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'done') { console.log(JSON.stringify(d)); process.exit(0); }
      } catch {}
    }
    console.log('{}');
  " 2>/dev/null
}

# Helper: extract a field from a JSON string
json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const v = d[$field];
    console.log(v === undefined ? '' : typeof v === 'boolean' ? String(v) : String(v));
  " 2>/dev/null || echo ""
}

# Helper: check if response text contains a substring
response_contains() {
  local json="$1"
  local needle="$2"
  echo "$json" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
    console.log(text.includes('$needle') ? 'yes' : 'no');
  " 2>/dev/null || echo "no"
}

# ── 0. Cleanup ─────────────────────────────────────────────────────────────

echo ""
echo "=== Cleanup ==="

# Remove ALWAYS.md to ensure clean state
if [[ -f "$MEMORY_DIR/ALWAYS.md" ]]; then
  rm "$MEMORY_DIR/ALWAYS.md"
  echo "  Removed existing ALWAYS.md"
fi

# Remove today's e2e test notes (any file matching e2e-test-*)
if [[ -d "$WORKLOG_DIR/$TODAY/notes" ]]; then
  find "$WORKLOG_DIR/$TODAY/notes" -name 'e2e-test-*' -delete 2>/dev/null || true
  echo "  Cleaned up today's e2e test notes"
fi

echo "  Done"

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

list_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List the tools available to you. Only list tool names from linear or posthog, one per line. Nothing else."}' \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
list_response=$(echo "$list_raw" | parse_done)

assert '[[ "$(json_field "$list_response" "sessionId")" != "" ]]' "Got a session ID"
assert '[[ "$(response_contains "$list_response" "list_issues")" == "yes" ]]' "Response mentions list_issues tool"

list_has_linear=$(response_contains "$list_response" "get_issue")
list_has_posthog=$(response_contains "$list_response" "insight-query")
assert '[[ "$list_has_linear" == "yes" || "$list_has_posthog" == "yes" ]]' "Response mentions proxied tools (linear or posthog)"

# ── 3. Trigger: actual tool call ────────────────────────────────────────────

echo ""
echo "=== Trigger: Tool Call (list issues) ==="

issues_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Use the linear tools to list the 2 most recent Linear issues. Show their identifier, title, and status in a table."}' \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
issues_response=$(echo "$issues_raw" | parse_done)

assert '[[ "$(json_field "$issues_response" "sessionId")" != "" ]]' "Got a session ID"
assert '[[ "$(response_contains "$issues_response" "list_issues")" == "yes" ]]' "Tool calls include list_issues"

has_response=$(echo "$issues_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.response && d.response.length > 20 ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$has_response" == "yes" ]]' "Response contains substantive content"

# ── 4. Memory continuity: session resume + notes ────────────────────────────

echo ""
echo "=== Memory Continuity: Session Resume + Notes ==="

CORR_KEY="e2e-test-$(date +%s)"
NOTES_FILE="$WORKLOG_DIR/$TODAY/notes/$(echo "$CORR_KEY" | sed 's/[^a-zA-Z0-9_-]/-/g; s/-\+/-/g').md"

# Generate a random code word so the agent can only know it from trigger #1
SECRET_CODE="THOR$(date +%s | tail -c 6)"

# 4a. First trigger — tell the agent a secret code word
echo "  Sending trigger #1 (new session — planting secret code: $SECRET_CODE)..."
trigger1_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Remember this secret code for later: $SECRET_CODE. Confirm you have noted it by repeating the code back to me.\",\"correlationKey\":\"$CORR_KEY\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger1=$(echo "$trigger1_raw" | parse_done)

session1=$(json_field "$trigger1" "sessionId")
resumed1=$(json_field "$trigger1" "resumed")
response1_has_code=$(response_contains "$trigger1" "$SECRET_CODE")

assert '[[ -n "$session1" ]]' "Trigger #1: got a session ID"
assert '[[ "$resumed1" == "false" ]]' "Trigger #1: was NOT a resumed session"
assert '[[ "$response1_has_code" == "yes" ]]' "Trigger #1: agent confirmed the secret code"
assert '[[ -f "$NOTES_FILE" ]]' "Trigger #1: notes file created"

if [[ -f "$NOTES_FILE" ]]; then
  assert 'grep -q "$SECRET_CODE" "$NOTES_FILE"' "Trigger #1: notes file contains the secret code"
fi

# 4b. Verify session exists in OpenCode via its native API
oc_session=$(
  curl -sf "$OPENCODE_URL/session/$session1" 2>/dev/null || echo '{}'
)
oc_session_id=$(echo "$oc_session" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.id || '');
" 2>/dev/null || echo "")

assert '[[ "$oc_session_id" == "$session1" ]]' "OpenCode API confirms session exists"

# 4c. Second trigger — ask the agent to recall the secret code
echo "  Sending trigger #2 (resume session — asking agent to recall the code)..."
trigger2_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What was the secret code I told you earlier? Reply with just the code, nothing else.\",\"correlationKey\":\"$CORR_KEY\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger2=$(echo "$trigger2_raw" | parse_done)

session2=$(json_field "$trigger2" "sessionId")
resumed2=$(json_field "$trigger2" "resumed")
response2_has_code=$(response_contains "$trigger2" "$SECRET_CODE")

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

# ── 5. Cross-session memory via ALWAYS.md ───────────────────────────────────

echo ""
echo "=== Cross-Session Memory: ALWAYS.md ==="

MEMORY_CODE="MEM$(date +%s | tail -c 6)"
CORR_KEY_A="e2e-memory-writer-$(date +%s)"
CORR_KEY_B="e2e-memory-reader-$(date +%s)"

# 5a. Trigger with corr key A — ask the agent to write a fact to ALWAYS.md
echo "  Sending trigger A (writing pinned memory with code: $MEMORY_CODE)..."
trigger_a_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Write the following line to /workspace/memory/ALWAYS.md (create the file if it does not exist): 'The deployment secret code is $MEMORY_CODE'. Do nothing else. Confirm when done.\",\"correlationKey\":\"$CORR_KEY_A\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_a=$(echo "$trigger_a_raw" | parse_done)

status_a=$(json_field "$trigger_a" "status")
assert '[[ "$status_a" == "completed" ]]' "Trigger A: completed successfully"

# Verify ALWAYS.md was created and contains the code
assert '[[ -f "$MEMORY_DIR/ALWAYS.md" ]]' "ALWAYS.md was created"
if [[ -f "$MEMORY_DIR/ALWAYS.md" ]]; then
  assert 'grep -q "$MEMORY_CODE" "$MEMORY_DIR/ALWAYS.md"' "ALWAYS.md contains the memory code ($MEMORY_CODE)"
  echo ""
  echo "  ALWAYS.md content:"
  cat "$MEMORY_DIR/ALWAYS.md" | sed 's/^/    /'
fi

# 5b. Trigger with corr key B (different session) — ask about the code
echo ""
echo "  Sending trigger B (new session, different corr key — asking about the code)..."
trigger_b_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What is the deployment secret code? Reply with just the code, nothing else.\",\"correlationKey\":\"$CORR_KEY_B\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_b=$(echo "$trigger_b_raw" | parse_done)

session_b=$(json_field "$trigger_b" "sessionId")
resumed_b=$(json_field "$trigger_b" "resumed")
response_b_has_code=$(response_contains "$trigger_b" "$MEMORY_CODE")

assert '[[ "$resumed_b" == "false" ]]' "Trigger B: was NOT a resumed session (different corr key)"
assert '[[ "$response_b_has_code" == "yes" ]]' "Trigger B: agent recalled cross-session memory code ($MEMORY_CODE)"

# 5c. Cleanup ALWAYS.md
rm -f "$MEMORY_DIR/ALWAYS.md"
echo "  Cleaned up ALWAYS.md"

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
