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
GIT_WRAPPERS_URL="${GIT_WRAPPERS_URL:-http://localhost:3004}"
OPENCODE_URL="${OPENCODE_URL:-http://localhost:4096}"
SESSION_DIR="${SESSION_DIR:-/workspace/repos/e2e-test}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
mkdir -p "${HOST_WORKSPACE}/repos/e2e-test"
WORKLOG_DIR="${WORKLOG_DIR:-${HOST_WORKSPACE}/worklog}"
MEMORY_DIR="${MEMORY_DIR:-${HOST_WORKSPACE}/memory}"
TODAY=$(date +%Y-%m-%d)

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
    const v = d[\"$field\"];
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

# ── 1. Health checks ────────────────────────────────────────────────────────

echo ""
echo "=== Health Checks ==="

proxy_health=$(curl -sf "$PROXY_LINEAR_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$proxy_health" == *"ok"* ]]' "Proxy (linear) is healthy" "got: $proxy_health"

runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$runner_health" == *"ok"* ]]' "Runner is healthy" "got: $runner_health"

# ── 2. Trigger: list tools ──────────────────────────────────────────────────

echo ""
echo "=== Trigger: List Tools ==="
echo "  (this may take a moment while the agent session runs)"

list_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"List the tools available to you. Only list tool names from linear or posthog, one per line. Nothing else.\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
list_response=$(echo "$list_raw" | parse_done)

list_session=$(json_field "$list_response" "sessionId")
list_response_text=$(json_field "$list_response" "response")
assert '[[ -n "$list_session" ]]' "Got a session ID" "sessionId='$list_session'"
assert '[[ "$(response_contains "$list_response" "list_issues")" == "yes" ]]' "Response mentions list_issues tool" "response: ${list_response_text:0:200}"

list_has_linear=$(response_contains "$list_response" "get_issue")
list_has_posthog=$(response_contains "$list_response" "insight-query")
assert '[[ "$list_has_linear" == "yes" || "$list_has_posthog" == "yes" ]]' "Response mentions proxied tools (linear or posthog)" "response: ${list_response_text:0:200}"

# ── 3. Trigger: actual tool call ────────────────────────────────────────────

echo ""
echo "=== Trigger: Tool Call (list issues) ==="

issues_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Use the linear tools to list the 2 most recent Linear issues. Show their identifier, title, and status in a table.\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
issues_response=$(echo "$issues_raw" | parse_done)

issues_session=$(json_field "$issues_response" "sessionId")
issues_tool_calls=$(json_field "$issues_response" "toolCalls")
issues_response_text=$(json_field "$issues_response" "response")
assert '[[ -n "$issues_session" ]]' "Got a session ID" "sessionId='$issues_session'"
assert '[[ "$(response_contains "$issues_response" "list_issues")" == "yes" ]]' "Tool calls include list_issues" "toolCalls: ${issues_tool_calls:0:200} | response: ${issues_response_text:0:200}"

has_response=$(echo "$issues_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.response && d.response.length > 20 ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$has_response" == "yes" ]]' "Response contains substantive content" "response length: ${#issues_response_text}"

# ── 4. Memory continuity: session resume + notes ────────────────────────────

echo ""
echo "=== Memory Continuity: Session Resume + Notes ==="

CORR_KEY="e2e-test-$(date +%s)"
NOTES_FILE="$WORKLOG_DIR/$TODAY/notes/$(echo "$CORR_KEY" | sed 's/[^a-zA-Z0-9_-]/-/g; s/-\+/-/g').md"

# Generate a random phrase so the agent can only know it from trigger #1
PHRASE="THOR$(date +%s | tail -c 6)"

# 4a. First trigger — tell the agent a phrase to remember
echo "  Sending trigger #1 (new session — planting phrase: $PHRASE)..."
trigger1_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Our team mascot name is $PHRASE. Confirm by repeating the mascot name back to me.\",\"correlationKey\":\"$CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger1=$(echo "$trigger1_raw" | parse_done)

session1=$(json_field "$trigger1" "sessionId")
resumed1=$(json_field "$trigger1" "resumed")
response1_has_phrase=$(response_contains "$trigger1" "$PHRASE")

response1_text=$(json_field "$trigger1" "response")
assert '[[ -n "$session1" ]]' "Trigger #1: got a session ID" "sessionId='$session1'"
assert '[[ "$resumed1" == "false" ]]' "Trigger #1: was NOT a resumed session" "resumed='$resumed1'"
assert '[[ "$response1_has_phrase" == "yes" ]]' "Trigger #1: agent confirmed the phrase" "response: ${response1_text:0:200}"
assert '[[ -f "$NOTES_FILE" ]]' "Trigger #1: notes file created" "expected: $NOTES_FILE"

if [[ -f "$NOTES_FILE" ]]; then
  assert 'grep -q "$PHRASE" "$NOTES_FILE"' "Trigger #1: notes file contains the phrase" "phrase=$PHRASE, file=$NOTES_FILE"
fi

# 4b. Verify session exists in OpenCode via its native API
oc_session=$(
  curl -sf "$OPENCODE_URL/session/$session1" 2>/dev/null || echo '{}'
)
oc_session_id=$(echo "$oc_session" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.id || '');
" 2>/dev/null || echo "")

assert '[[ "$oc_session_id" == "$session1" ]]' "OpenCode API confirms session exists" "expected='$session1', got='$oc_session_id'"

# 4c. Second trigger — ask the agent to recall the phrase
echo "  Sending trigger #2 (resume session — asking agent to recall the phrase)..."
trigger2_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What is our team mascot name? Reply with just the name, nothing else.\",\"correlationKey\":\"$CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger2=$(echo "$trigger2_raw" | parse_done)

session2=$(json_field "$trigger2" "sessionId")
resumed2=$(json_field "$trigger2" "resumed")
response2_has_phrase=$(response_contains "$trigger2" "$PHRASE")

response2_text=$(json_field "$trigger2" "response")
assert '[[ "$session2" == "$session1" ]]' "Trigger #2: reused the SAME session ID" "expected='$session1', got='$session2'"
assert '[[ "$resumed2" == "true" ]]' "Trigger #2: was a resumed session" "resumed='$resumed2'"
assert '[[ "$response2_has_phrase" == "yes" ]]' "Trigger #2: agent recalled the phrase ($PHRASE)" "response: ${response2_text:0:200}"

if [[ -f "$NOTES_FILE" ]]; then
  assert 'grep -q "Follow-up" "$NOTES_FILE"' "Trigger #2: notes file has follow-up entry" "file has no 'Follow-up' heading"
  assert 'grep -q "Result" "$NOTES_FILE"' "Trigger #2: notes file has result summary" "file has no 'Result' heading"
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

MEMORY_PHRASE="MEM$(date +%s | tail -c 6)"
CORR_KEY_A="e2e-memory-writer-$(date +%s)"
CORR_KEY_B="e2e-memory-reader-$(date +%s)"

# 5a. Trigger with corr key A — ask the agent to remember something important
echo "  Sending trigger A (asking agent to remember phrase: $MEMORY_PHRASE)..."
trigger_a_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Please remember this for all future sessions: our team mascot is called $MEMORY_PHRASE. Save it to your pinned memory so you never forget.\",\"correlationKey\":\"$CORR_KEY_A\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_a=$(echo "$trigger_a_raw" | parse_done)

status_a=$(json_field "$trigger_a" "status")
response_a_text=$(json_field "$trigger_a" "response")
assert '[[ "$status_a" == "completed" ]]' "Trigger A: completed successfully" "status='$status_a', response: ${response_a_text:0:200}"

# Verify ALWAYS.md was created and contains the phrase
assert '[[ -f "$MEMORY_DIR/ALWAYS.md" ]]' "ALWAYS.md was created" "expected: $MEMORY_DIR/ALWAYS.md"
if [[ -f "$MEMORY_DIR/ALWAYS.md" ]]; then
  assert 'grep -q "$MEMORY_PHRASE" "$MEMORY_DIR/ALWAYS.md"' "ALWAYS.md contains the memory phrase ($MEMORY_PHRASE)" "file content: $(cat "$MEMORY_DIR/ALWAYS.md")"
  echo ""
  echo "  ALWAYS.md content:"
  cat "$MEMORY_DIR/ALWAYS.md" | sed 's/^/    /'
fi

# 5b. Trigger with corr key B (different session) — ask about the phrase
echo ""
echo "  Sending trigger B (new session, different corr key — asking about the phrase)..."
trigger_b_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What is our team mascot called? Reply with just the name.\",\"correlationKey\":\"$CORR_KEY_B\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_b=$(echo "$trigger_b_raw" | parse_done)

session_b=$(json_field "$trigger_b" "sessionId")
resumed_b=$(json_field "$trigger_b" "resumed")
response_b_has_phrase=$(response_contains "$trigger_b" "$MEMORY_PHRASE")

response_b_text=$(json_field "$trigger_b" "response")
assert '[[ "$resumed_b" == "false" ]]' "Trigger B: was NOT a resumed session (different corr key)" "resumed='$resumed_b'"
assert '[[ "$response_b_has_phrase" == "yes" ]]' "Trigger B: agent recalled cross-session memory phrase ($MEMORY_PHRASE)" "response: ${response_b_text:0:200}"

# ── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

# Clean up e2e test directory (only if we created the default one)
[[ "$SESSION_DIR" == "/workspace/repos/e2e-test" ]] && rm -rf "${HOST_WORKSPACE}/repos/e2e-test"

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
