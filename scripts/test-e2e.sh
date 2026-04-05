#!/usr/bin/env bash
#
# End-to-end test for Thor.
#
# Tests the full chain: curl -> runner -> OpenCode service -> per-upstream proxies -> MCP servers
#
# Prerequisites:
#   - Both services running (either `pnpm dev` or `docker compose up`)
#   - OpenCode configured with an LLM provider in the runner environment
#
# Usage:
#   ./scripts/test-e2e.sh
#   RUNNER_URL=http://localhost:3000 OPENCODE_URL=http://localhost:4096 ./scripts/test-e2e.sh
#
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
PROXY_URL="${PROXY_URL:-http://localhost:3001}"
GIT_WRAPPERS_URL="${GIT_WRAPPERS_URL:-http://localhost:3004}"
OPENCODE_URL="${OPENCODE_URL:-http://localhost:4096}"
SESSION_DIR="${SESSION_DIR:-/workspace/repos/e2e-test}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
mkdir -p "${HOST_WORKSPACE}/repos/e2e-test"
MEMORY_DIR="${MEMORY_DIR:-${HOST_WORKSPACE}/memory}"

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

proxy_health=$(curl -sf "$PROXY_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$proxy_health" == *"ok"* ]]' "Proxy is healthy" "got: $proxy_health"

runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$runner_health" == *"ok"* ]]' "Runner is healthy" "got: $runner_health"

# ── 2. Trigger: list tools ──────────────────────────────────────────────────

echo ""
echo "=== Trigger: List Tools ==="
echo "  (this may take a moment while the agent session runs)"

list_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"List all MCP tools available to you, one per line.\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
list_response=$(echo "$list_raw" | parse_done)

list_session=$(json_field "$list_response" "sessionId")
list_response_text=$(json_field "$list_response" "response")
assert '[[ -n "$list_session" ]]' "Got a session ID" "sessionId='$list_session'"
list_has_tools=$(echo "$list_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
  const found = /atlassian|posthog|jira|slack|post_message|getJiraIssue|searchJira|insight/i.test(text);
  console.log(found ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$list_has_tools" == "yes" ]]' "Response mentions available MCP tools" "response: ${list_response_text:0:200}"

# ── 3. Trigger: actual tool call ────────────────────────────────────────────

echo ""
echo "=== Trigger: Tool Call (list issues) ==="

issues_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Use the atlassian tools to list the 2 most recent Jira issues. Show their identifier, title, and status in a table.\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
issues_response=$(echo "$issues_raw" | parse_done)

issues_session=$(json_field "$issues_response" "sessionId")
issues_tool_calls=$(json_field "$issues_response" "toolCalls")
issues_response_text=$(json_field "$issues_response" "response")
assert '[[ -n "$issues_session" ]]' "Got a session ID" "sessionId='$issues_session'"
issues_has_tool_calls=$(echo "$issues_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.toolCalls && d.toolCalls.length > 0 ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$issues_has_tool_calls" == "yes" ]]' "Agent made tool calls" "toolCalls: ${issues_tool_calls:0:200}"

has_response=$(echo "$issues_response" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.response && d.response.length > 20 ? 'yes' : 'no');
" 2>/dev/null || echo "no")
assert '[[ "$has_response" == "yes" ]]' "Response contains substantive content" "response length: ${#issues_response_text}"

# ── 4. Memory continuity: session resume ─────────────────────────────────────

echo ""
echo "=== Memory Continuity: Session Resume ==="

CORR_KEY="e2e-test-$(date +%s)"

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

# ── 5. Cross-session memory via README.md ───────────────────────────────────

# Clean up stale memory files from prior runs
rm -f "$MEMORY_DIR/ALWAYS.md" "$MEMORY_DIR/README.md"
rm -rf "$MEMORY_DIR/e2e-test"

echo ""
echo "=== Cross-Session Memory: README.md ==="

MEMORY_PHRASE="MEM$(date +%s | tail -c 6)"
CORR_KEY_A="e2e-memory-writer-$(date +%s)"
CORR_KEY_B="e2e-memory-reader-$(date +%s)"

# 5a. Trigger with corr key A — ask the agent to remember something important
echo "  Sending trigger A (asking agent to remember phrase: $MEMORY_PHRASE)..."
trigger_a_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Please remember this for all future sessions: our team mascot is called $MEMORY_PHRASE. Save it to the root memory README.md file shown in the root memory hint.\",\"correlationKey\":\"$CORR_KEY_A\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_a=$(echo "$trigger_a_raw" | parse_done)

status_a=$(json_field "$trigger_a" "status")
response_a_text=$(json_field "$trigger_a" "response")
assert '[[ "$status_a" == "completed" ]]' "Trigger A: completed successfully" "status='$status_a', response: ${response_a_text:0:200}"

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

# ── 6. Per-repo memory via /workspace/memory/<repo>/README.md ────────────────

echo ""
echo "=== Per-Repo Memory: <repo>/README.md ==="

REPO_MEMORY_PHRASE="REPO$(date +%s | tail -c 6)"
CORR_KEY_C="e2e-repo-memory-writer-$(date +%s)"
CORR_KEY_D="e2e-repo-memory-reader-$(date +%s)"

# 6a. Trigger asking agent to save something to per-repo memory
echo "  Sending trigger C (asking agent to save per-repo memory phrase: $REPO_MEMORY_PHRASE)..."
trigger_c_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Save this fact: the deploy canary threshold is $REPO_MEMORY_PHRASE. Write it to /workspace/memory/e2e-test/README.md (create the directory if needed). Do NOT write to /workspace/memory/README.md.\",\"correlationKey\":\"$CORR_KEY_C\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_c=$(echo "$trigger_c_raw" | parse_done)

status_c=$(json_field "$trigger_c" "status")
response_c_text=$(json_field "$trigger_c" "response")
assert '[[ "$status_c" == "completed" ]]' "Trigger C: completed successfully" "status='$status_c', response: ${response_c_text:0:200}"

# 6b. Trigger with different corr key — ask about the per-repo phrase
echo ""
echo "  Sending trigger D (new session, different corr key — asking about per-repo phrase)..."
trigger_d_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"What is the deploy canary threshold for this repo? Reply with just the value.\",\"correlationKey\":\"$CORR_KEY_D\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_d=$(echo "$trigger_d_raw" | parse_done)

session_d=$(json_field "$trigger_d" "sessionId")
resumed_d=$(json_field "$trigger_d" "resumed")
response_d_has_phrase=$(response_contains "$trigger_d" "$REPO_MEMORY_PHRASE")

response_d_text=$(json_field "$trigger_d" "response")
assert '[[ "$resumed_d" == "false" ]]' "Trigger D: was NOT a resumed session (different corr key)" "resumed='$resumed_d'"
assert '[[ "$response_d_has_phrase" == "yes" ]]' "Trigger D: agent recalled per-repo memory phrase ($REPO_MEMORY_PHRASE)" "response: ${response_d_text:0:200}"

# ── 7. Approval Flow ──────────────────────────────────────────────────────────

echo ""
echo "=== Approval Flow ==="

# 7a. Discover an approval-required tool from an upstream
# The proxy enforces repo-to-proxy access, so we need a directory that maps to a
# configured repo. Scan the workspace config for a repo that has a proxy with
# approval-required tools.
APPROVAL_UPSTREAM=""
APPROVAL_TOOL=""
APPROVAL_DIR=""
CONFIG_FILE="${HOST_WORKSPACE}/config.json"

if [[ -f "$CONFIG_FILE" ]]; then
  # Build a list of "repo:upstream" pairs — only connected upstreams with approve lists
  repo_upstream_pairs=$(curl -sf "$PROXY_URL/health" 2>/dev/null | node -e "
    const health = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const connected = new Set(
      Object.entries(health.instances || {})
        .filter(([, info]) => info.connected)
        .map(([name]) => name)
    );
    const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));
    const repos = cfg.repos || {};
    const proxies = cfg.proxies || {};
    for (const [repo, rcfg] of Object.entries(repos)) {
      for (const p of (rcfg.proxies || [])) {
        if (connected.has(p) && (proxies[p]?.approve || []).length > 0) {
          console.log(repo + ':' + p);
        }
      }
    }
  " 2>/dev/null || echo "")

  for pair in $repo_upstream_pairs; do
    repo_name="${pair%%:*}"
    upstream_name="${pair##*:}"
    test_dir="/workspace/repos/$repo_name"
    host_dir="${HOST_WORKSPACE}/repos/$repo_name"
    # Repo directory must exist on host (mounted into container)
    if [[ ! -d "$host_dir" ]]; then
      continue
    fi
    tools_json=$(curl -sf "$PROXY_URL/$upstream_name/tools" \
      -H "x-thor-directory: $test_dir" 2>/dev/null || echo '{"tools":[]}')
    found_tool=$(echo "$tools_json" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const t = (d.tools || []).find(t => t.classification === 'approve');
      console.log(t ? t.name : '');
    " 2>/dev/null || echo "")
    if [[ -n "$found_tool" ]]; then
      APPROVAL_UPSTREAM="$upstream_name"
      APPROVAL_TOOL="$found_tool"
      APPROVAL_DIR="$test_dir"
      break
    fi
  done
fi

if [[ -z "$APPROVAL_TOOL" ]]; then
  echo "  ⚠ No approval-required tools found — skipping approval flow tests"
else
  echo "  Found approval-required tool: $APPROVAL_UPSTREAM/$APPROVAL_TOOL (via $APPROVAL_DIR)"

  # 7b. Proxy-level: call the approval-required tool directly
  echo "  Calling tool via proxy (expecting approval interception)..."
  call_raw=$(curl -sf -X POST "$PROXY_URL/$APPROVAL_UPSTREAM/tools/call" \
    -H 'Content-Type: application/json' \
    -H "x-thor-directory: $APPROVAL_DIR" \
    -d "{\"name\":\"$APPROVAL_TOOL\",\"arguments\":{}}" \
    2>/dev/null || echo '{}')

  # Parse action ID — check stdout, stderr (thor:meta), and content (legacy MCP format)
  action_id=$(echo "$call_raw" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const parts = [d.stdout || '', d.stderr || ''];
    if (Array.isArray(d.content)) parts.push(...d.content.map(c => c.text || ''));
    const text = parts.join(' ');
    const m = text.match(/\"actionId\"\s*:\s*\"([^\"]+)\"/);
    console.log(m ? m[1] : '');
  " 2>/dev/null || echo "")

  call_not_error=$(echo "$call_raw" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    // New format: exitCode === 0; Old format: isError === false
    const ok = d.exitCode === 0 || d.isError === false;
    console.log(ok ? 'yes' : 'no');
  " 2>/dev/null || echo "no")

  assert '[[ -n "$action_id" ]]' "Proxy: tool call returned an action ID" "response: ${call_raw:0:300}"
  assert '[[ "$call_not_error" == "yes" ]]' "Proxy: tool call was not an error" "response: ${call_raw:0:200}"

  if [[ -n "$action_id" ]]; then
    # 7c. Check approval status is pending
    status_raw=$(curl -sf "$PROXY_URL/approval/$action_id" 2>/dev/null || echo '{}')
    status_val=$(json_field "$status_raw" "status")
    status_tool=$(json_field "$status_raw" "tool")
    assert '[[ "$status_val" == "pending" ]]' "Proxy: approval status is 'pending'" "status='$status_val'"
    assert '[[ "$status_tool" == "$APPROVAL_TOOL" ]]' "Proxy: approval record has correct tool name" "tool='$status_tool'"

    # 7d. List pending approvals — verify our action appears
    pending_raw=$(curl -sf "$PROXY_URL/approvals" 2>/dev/null || echo '{"approvals":[]}')
    pending_has_action=$(echo "$pending_raw" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const found = (d.approvals || []).some(a => a.id === '$action_id');
      console.log(found ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
    assert '[[ "$pending_has_action" == "yes" ]]' "Proxy: action appears in pending approvals list" "actionId=$action_id"

    # 7e. Reject the approval (safe — no side effects on the upstream MCP)
    echo "  Rejecting approval $action_id..."
    resolve_raw=$(curl -sf -X POST "$PROXY_URL/$APPROVAL_UPSTREAM/approval/$action_id/resolve" \
      -H 'Content-Type: application/json' \
      -d '{"decision":"rejected","reviewer":"e2e-test","reason":"e2e test — automated rejection"}' \
      2>/dev/null || echo '{}')
    resolve_status=$(json_field "$resolve_raw" "status")
    resolve_reviewer=$(json_field "$resolve_raw" "reviewer")
    assert '[[ "$resolve_status" == "rejected" ]]' "Proxy: approval was rejected" "status='$resolve_status'"
    assert '[[ "$resolve_reviewer" == "e2e-test" ]]' "Proxy: reviewer recorded correctly" "reviewer='$resolve_reviewer'"

    # 7f. Verify it's no longer in the pending list
    pending_after=$(curl -sf "$PROXY_URL/approvals" 2>/dev/null || echo '{"approvals":[]}')
    still_pending=$(echo "$pending_after" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const found = (d.approvals || []).some(a => a.id === '$action_id');
      console.log(found ? 'yes' : 'no');
    " 2>/dev/null || echo "yes")
    assert '[[ "$still_pending" == "no" ]]' "Proxy: rejected action no longer in pending list" "actionId=$action_id"

    # 7g. Verify final status via GET confirms rejection
    final_raw=$(curl -sf "$PROXY_URL/approval/$action_id" 2>/dev/null || echo '{}')
    final_status=$(json_field "$final_raw" "status")
    assert '[[ "$final_status" == "rejected" ]]' "Proxy: final status confirms 'rejected'" "status='$final_status'"
  fi

  # ── 7h–7j. End-to-end: rejection lands back in OpenCode session ───────────
  #
  # Create a pending approval via proxy, reject it, then ask the agent to poll
  # the status using `approval status <id>` — verifying the rejection message
  # is visible inside the OpenCode session.

  echo ""
  echo "  --- E2E: Rejection reaches OpenCode session ---"

  # 7h. Create a fresh pending approval via proxy API
  echo "  Creating pending approval via proxy..."
  e2e_call_raw=$(curl -sf -X POST "$PROXY_URL/$APPROVAL_UPSTREAM/tools/call" \
    -H 'Content-Type: application/json' \
    -H "x-thor-directory: $APPROVAL_DIR" \
    -d "{\"name\":\"$APPROVAL_TOOL\",\"arguments\":{}}" \
    2>/dev/null || echo '{}')

  e2e_action_id=$(echo "$e2e_call_raw" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const parts = [d.stdout || '', d.stderr || ''];
    if (Array.isArray(d.content)) parts.push(...d.content.map(c => c.text || ''));
    const text = parts.join(' ');
    const m = text.match(/\"actionId\"\s*:\s*\"([^\"]+)\"/);
    console.log(m ? m[1] : '');
  " 2>/dev/null || echo "")

  if [[ -z "$e2e_action_id" ]]; then
    echo "  ⚠ Could not create pending approval — skipping session tests"
  else
    # 7i. Reject the approval via proxy API
    echo "  Rejecting approval $e2e_action_id..."
    curl -sf -X POST "$PROXY_URL/$APPROVAL_UPSTREAM/approval/$e2e_action_id/resolve" \
      -H 'Content-Type: application/json' \
      -d '{"decision":"rejected","reviewer":"e2e-test","reason":"e2e test — automated rejection"}' \
      2>/dev/null >/dev/null

    # 7j. Ask the agent to check the approval status — rejection should be visible
    CORR_KEY_APPROVAL="e2e-approval-$(date +%s)"
    echo "  Sending trigger (asking agent to check approval status of $e2e_action_id)..."
    approval_trigger_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
      -H 'Content-Type: application/json' \
      -d "{\"prompt\":\"Run: approval status $e2e_action_id\\nThen tell me: what is the status field? Is it pending, approved, or rejected?\",\"correlationKey\":\"$CORR_KEY_APPROVAL\",\"directory\":\"$APPROVAL_DIR\"}" \
      --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
    approval_trigger=$(echo "$approval_trigger_raw" | parse_done)

    approval_session=$(json_field "$approval_trigger" "sessionId")
    approval_trigger_text=$(json_field "$approval_trigger" "response")
    assert '[[ -n "$approval_session" ]]' "E2E: trigger got a session ID" "sessionId='$approval_session'"

    # Check that the agent's response confirms rejection
    response_has_rejected=$(echo "$approval_trigger" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const text = ((d.response || '') + JSON.stringify(d.toolCalls || [])).toLowerCase();
      console.log(text.includes('rejected') || text.includes('rejection') ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
    assert '[[ "$response_has_rejected" == "yes" ]]' "E2E: agent confirms rejection landed in session" "response: ${approval_trigger_text:0:300}"
  fi
fi

# ── 8. Alias-based session matching via [thor:meta] ──────────────────────────
#
# When the agent runs an aliasable git command (push, worktree add), remote-cli
# emits a [thor:meta] alias in stderr. The runner extracts this and registers it
# in the notes file as `### Session: git:branch:<repo>:<branch>`.
# The gateway uses resolveCorrelationKeys() to grep the notes files and map the
# alias back to the canonical correlationKey, enabling session continuity.
#
# Test flow:
#   1. Trigger #1 (runner): agent runs git worktree add → alias registered
#   2. Trigger #2 (gateway /cron): sends the alias as correlationKey
#      → gateway resolves alias → runner resumes session A
#   3. Verify: notes file has follow-up entry with same session ID

echo ""
echo "=== Alias-based Session Matching (thor:meta) ==="

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
CRON_SECRET="${CRON_SECRET:-$(docker exec thor-cron-1 printenv CRON_SECRET 2>/dev/null)}"

ALIAS_TS=$(date +%s)
ALIAS_BRANCH="e2e-alias-${ALIAS_TS}"
CORR_KEY_ALIAS="e2e-alias-session-${ALIAS_TS}"
ALIAS_PHRASE="ALIAS$(echo $ALIAS_TS | tail -c 6)"
ALIAS_REPO="katalon-scout-private"
ALIAS_DIR="/workspace/repos/$ALIAS_REPO"
ALIAS_WORKTREE="/workspace/worktrees/$ALIAS_REPO/$ALIAS_BRANCH"
EXPECTED_ALIAS="git:branch:${ALIAS_REPO}:${ALIAS_BRANCH}"

# Check prerequisites
if [[ ! -d "${HOST_WORKSPACE}/repos/$ALIAS_REPO/.git" ]]; then
  echo "  ⚠ Repo $ALIAS_REPO not found or not a git repo — skipping alias tests"
elif [[ -z "$CRON_SECRET" ]]; then
  echo "  ⚠ CRON_SECRET not available — skipping alias tests"
else
  # 8a. Trigger #1 (runner): plant a phrase and run git worktree add
  echo "  Sending trigger #1 (planting phrase $ALIAS_PHRASE + git worktree add $ALIAS_BRANCH)..."
  alias_trigger1_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
    -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"Remember this phrase: $ALIAS_PHRASE. Then run: git worktree add -b $ALIAS_BRANCH $ALIAS_WORKTREE HEAD\",\"correlationKey\":\"$CORR_KEY_ALIAS\",\"directory\":\"$ALIAS_DIR\"}" \
    --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
  alias_trigger1=$(echo "$alias_trigger1_raw" | parse_done)

  alias_session=$(json_field "$alias_trigger1" "sessionId")
  alias_status=$(json_field "$alias_trigger1" "status")
  alias_trigger1_text=$(json_field "$alias_trigger1" "response")
  assert '[[ -n "$alias_session" ]]' "Trigger #1: got a session ID" "sessionId='$alias_session'"
  assert '[[ "$alias_status" == "completed" ]]' "Trigger #1: completed" "status='$alias_status'"

  # Verify the branch was created (response mentions it)
  response_has_branch=$(echo "$alias_trigger1" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const text = (d.response || '') + JSON.stringify(d.toolCalls || []);
    console.log(text.includes('$ALIAS_BRANCH') ? 'yes' : 'no');
  " 2>/dev/null || echo "no")
  assert '[[ "$response_has_branch" == "yes" ]]' "Trigger #1: agent created the branch" "response: ${alias_trigger1_text:0:200}"

  # 8b. Trigger #2 (gateway /cron): use the git branch alias as correlationKey
  # The gateway resolves the alias back to the canonical key → runner resumes session A
  echo "  Sending trigger #2 via gateway (correlationKey=$EXPECTED_ALIAS)..."
  cron_response=$(curl -sf -X POST "$GATEWAY_URL/cron" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CRON_SECRET" \
    -d "{\"prompt\":\"What is the phrase I told you to remember? Reply with just the phrase.\",\"correlationKey\":\"$EXPECTED_ALIAS\",\"directory\":\"$ALIAS_DIR\"}" \
    2>/dev/null || echo '{}')
  cron_ok=$(json_field "$cron_response" "ok")
  cron_resolved_key=$(json_field "$cron_response" "correlationKey")
  assert '[[ "$cron_ok" == "true" ]]' "Trigger #2: gateway accepted the cron event" "response: $cron_response"
  assert '[[ "$cron_resolved_key" == "$CORR_KEY_ALIAS" ]]' \
    "Trigger #2: gateway resolved alias to canonical key" \
    "expected='$CORR_KEY_ALIAS', got='$cron_resolved_key'"

  # 8c. Trigger #3 (runner): verify session continuity by recalling the phrase
  # Wait for the async cron trigger to finish, then send a sync trigger with the
  # canonical key. If the alias resolution worked, triggers #2 and #3 share the
  # same session as trigger #1, so the agent can recall the phrase.
  echo "  Waiting for cron trigger to finish, then sending trigger #3..."
  alias_trigger3_done="no"
  for i in $(seq 1 30); do
    sleep 2
    alias_trigger3_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
      -H 'Content-Type: application/json' \
      -d "{\"prompt\":\"What is the phrase I asked you to remember earlier? Reply with just the phrase.\",\"correlationKey\":\"$CORR_KEY_ALIAS\",\"directory\":\"$ALIAS_DIR\"}" \
      --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
    alias_trigger3=$(echo "$alias_trigger3_raw" | parse_done)
    alias_trigger3_busy=$(json_field "$alias_trigger3" "busy")
    if [[ "$alias_trigger3_busy" != "true" ]]; then
      alias_trigger3_done="yes"
      break
    fi
  done

  if [[ "$alias_trigger3_done" == "yes" ]]; then
    alias_session3=$(json_field "$alias_trigger3" "sessionId")
    alias_resumed3=$(json_field "$alias_trigger3" "resumed")
    alias_trigger3_text=$(json_field "$alias_trigger3" "response")
    alias_response3_has_phrase=$(response_contains "$alias_trigger3" "$ALIAS_PHRASE")

    assert '[[ "$alias_session3" == "$alias_session" ]]' \
      "Trigger #3: same session ID (alias mapping worked end-to-end)" \
      "expected='$alias_session', got='$alias_session3'"
    assert '[[ "$alias_resumed3" == "true" ]]' \
      "Trigger #3: was a resumed session" \
      "resumed='$alias_resumed3'"
    assert '[[ "$alias_response3_has_phrase" == "yes" ]]' \
      "Trigger #3: agent recalled phrase (confirms session continuity)" \
      "response: ${alias_trigger3_text:0:200}"
  else
    assert 'false' "Trigger #3: session became available" "still busy after 60s"
  fi

  # Clean up: remove worktree and delete the test branch
  echo ""
  echo "  Cleaning up test worktree and branch..."
  curl -sf -X POST "$GIT_WRAPPERS_URL/exec/git" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"worktree\",\"remove\",\"--force\",\"$ALIAS_WORKTREE\"],\"cwd\":\"$ALIAS_DIR\"}" \
    2>/dev/null >/dev/null
  curl -sf -X POST "$GIT_WRAPPERS_URL/exec/git" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"branch\",\"-D\",\"$ALIAS_BRANCH\"],\"cwd\":\"$ALIAS_DIR\"}" \
    2>/dev/null >/dev/null
fi

# ── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

# Clean up e2e test directory and per-repo memory (only if we created the default one)
[[ "$SESSION_DIR" == "/workspace/repos/e2e-test" ]] && rm -rf "${HOST_WORKSPACE}/repos/e2e-test" "${MEMORY_DIR}/e2e-test"

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
