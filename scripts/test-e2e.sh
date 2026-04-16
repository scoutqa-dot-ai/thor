#!/usr/bin/env bash
#
# End-to-end test for Thor.
#
# Tests the full chain: curl -> runner -> OpenCode service -> remote-cli -> MCP servers
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
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
SESSION_DIR="${SESSION_DIR:-/workspace/repos/e2e-test}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
mkdir -p "${HOST_WORKSPACE}/repos/e2e-test"
MEMORY_DIR="${MEMORY_DIR:-${HOST_WORKSPACE}/memory}"
CRON_SECRET="${CRON_SECRET:-$(docker exec thor-cron-1 printenv CRON_SECRET 2>/dev/null)}"
RESOLVE_SECRET="${RESOLVE_SECRET:-$(docker exec thor-gateway-1 printenv RESOLVE_SECRET 2>/dev/null)}"

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

# Helper: extract a field from the JSON stored in an exec-result stdout field
exec_stdout_field() {
  local json="$1"
  local field="$2"
  echo "$json" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const stdout = JSON.parse(d.stdout || '{}');
    const v = stdout[\"$field\"];
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

remote_cli_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$remote_cli_health" == *"ok"* ]]' "remote-cli is healthy" "got: $remote_cli_health"

runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$runner_health" == *"ok"* ]]' "Runner is healthy" "got: $runner_health"

# ── 2. Session resume via correlation key ────────────────────────────────────

echo ""
echo "=== Session Resume ==="

CORR_KEY="e2e-test-$(date +%s)"

# Generate a random phrase so the agent can only know it from trigger #1
PHRASE="THOR$(date +%s | tail -c 6)"

# 2a. First trigger — tell the agent a phrase to remember
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

# 2b. Second trigger — ask the agent to recall the phrase
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

# ── 3. Cross-session memory ──────────────────────────────────────────────────

# Clean up stale memory files from prior runs
rm -f "$MEMORY_DIR/ALWAYS.md" "$MEMORY_DIR/README.md"
rm -rf "$MEMORY_DIR/e2e-test"

echo ""
echo "=== Cross-Session Memory ==="

MEMORY_PHRASE="MEM$(date +%s | tail -c 6)"
CORR_KEY_A="e2e-memory-writer-$(date +%s)"
CORR_KEY_B="e2e-memory-reader-$(date +%s)"

# 3a. Trigger with corr key A — ask the agent to remember something important
echo "  Sending trigger A (asking agent to remember phrase: $MEMORY_PHRASE)..."
trigger_a_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Please remember this for all future sessions: our team mascot is called $MEMORY_PHRASE. Save it to the root memory README.md file shown in the root memory hint.\",\"correlationKey\":\"$CORR_KEY_A\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
trigger_a=$(echo "$trigger_a_raw" | parse_done)

status_a=$(json_field "$trigger_a" "status")
response_a_text=$(json_field "$trigger_a" "response")
assert '[[ "$status_a" == "completed" ]]' "Trigger A: completed successfully" "status='$status_a', response: ${response_a_text:0:200}"

# 3b. Trigger with corr key B (different session) — ask about the phrase
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

# ── 4. Approval Flow ────────────────────────────────────────────────────────

echo ""
echo "=== Approval Flow ==="

# 4a. Discover an approval-required tool from an upstream
APPROVAL_UPSTREAM=""
APPROVAL_TOOL=""
APPROVAL_DIR=""
CONFIG_FILE="${HOST_WORKSPACE}/config.json"

if [[ -f "$CONFIG_FILE" ]]; then
  # Build a list of "repo:upstream" pairs — only connected upstreams with approve lists
  repo_upstream_pairs=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null | pnpm --filter @thor/remote-cli exec tsx -e "
    import { readFileSync } from 'node:fs';
    import { PROXY_REGISTRY } from '../common/src/proxies.ts';
    const health = JSON.parse(readFileSync(0,'utf8'));
    const connected = new Set(
      Object.entries(health.mcp?.instances || {})
        .filter(([, info]) => info.connected)
        .map(([name]) => name)
    );
    const cfg = JSON.parse(readFileSync('$CONFIG_FILE','utf8'));
    const repos = cfg.repos || {};
    for (const [repo, rcfg] of Object.entries(repos)) {
      for (const p of (rcfg.proxies || [])) {
        if (connected.has(p) && (PROXY_REGISTRY[p]?.approve || []).length > 0) {
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
    found_tool=$(pnpm --filter @thor/remote-cli exec tsx -e "
      import { PROXY_REGISTRY } from '../common/src/proxies.ts';
      console.log(PROXY_REGISTRY['$upstream_name']?.approve?.[0] || '');
    " 2>/dev/null || echo "")
    if [[ -n "$found_tool" ]]; then
      APPROVAL_UPSTREAM="$upstream_name"
      APPROVAL_TOOL="$found_tool"
      APPROVAL_DIR="$test_dir"
      break
    fi
  done
fi

if [[ -z "$APPROVAL_TOOL" || -z "$RESOLVE_SECRET" ]]; then
  echo "  ⚠ No approval-required tools found — skipping approval flow tests"
else
  echo "  Found approval-required tool: $APPROVAL_UPSTREAM/$APPROVAL_TOOL (via $APPROVAL_DIR)"

  # 4b. remote-cli-level: call the approval-required tool directly
  echo "  Calling tool via remote-cli (expecting approval interception)..."
  call_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"$APPROVAL_UPSTREAM\",\"$APPROVAL_TOOL\",\"{}\"],\"cwd\":\"$APPROVAL_DIR\",\"directory\":\"$APPROVAL_DIR\"}" \
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

  assert '[[ -n "$action_id" ]]' "remote-cli: tool call returned an action ID" "response: ${call_raw:0:300}"
  assert '[[ "$call_not_error" == "yes" ]]' "remote-cli: tool call was not an error" "response: ${call_raw:0:200}"

  if [[ -n "$action_id" ]]; then
    # 4c. Check approval status is pending
    status_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
      -H 'Content-Type: application/json' \
      -d "{\"args\":[\"status\",\"$action_id\"]}" \
      2>/dev/null || echo '{}')
    status_val=$(exec_stdout_field "$status_raw" "status")
    status_tool=$(exec_stdout_field "$status_raw" "tool")
    assert '[[ "$status_val" == "pending" ]]' "remote-cli: approval status is 'pending'" "status='$status_val'"
    assert '[[ "$status_tool" == "$APPROVAL_TOOL" ]]' "remote-cli: approval record has correct tool name" "tool='$status_tool'"

    # 4d. Reject the approval (safe — no side effects on the upstream MCP)
    echo "  Rejecting approval $action_id..."
    resolve_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
      -H 'Content-Type: application/json' \
      -H "x-thor-resolve-secret: $RESOLVE_SECRET" \
      -d "{\"args\":[\"resolve\",\"$action_id\",\"rejected\",\"e2e-test\",\"e2e test - automated rejection\"]}" \
      2>/dev/null || echo '{}')
    resolve_exit=$(json_field "$resolve_raw" "exitCode")
    assert '[[ "$resolve_exit" == "0" ]]' "remote-cli: approval rejection command succeeded" "exitCode='$resolve_exit'"

    # 4e. Verify final status confirms rejection
    final_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
      -H 'Content-Type: application/json' \
      -d "{\"args\":[\"status\",\"$action_id\"]}" \
      2>/dev/null || echo '{}')
    final_status=$(exec_stdout_field "$final_raw" "status")
    assert '[[ "$final_status" == "rejected" ]]' "remote-cli: final status confirms 'rejected'" "status='$final_status'"
  fi

  # ── 4f–4h. End-to-end: rejection lands back in OpenCode session ───────────

  echo ""
  echo "  --- E2E: Rejection reaches OpenCode session ---"

  # 4f. Create a fresh pending approval via remote-cli API
  echo "  Creating pending approval via remote-cli..."
  e2e_call_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"$APPROVAL_UPSTREAM\",\"$APPROVAL_TOOL\",\"{}\"],\"cwd\":\"$APPROVAL_DIR\",\"directory\":\"$APPROVAL_DIR\"}" \
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
    # 4g. Reject the approval via remote-cli API
    echo "  Rejecting approval $e2e_action_id..."
    curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
      -H 'Content-Type: application/json' \
      -H "x-thor-resolve-secret: $RESOLVE_SECRET" \
      -d "{\"args\":[\"resolve\",\"$e2e_action_id\",\"rejected\",\"e2e-test\",\"e2e test - automated rejection\"]}" \
      2>/dev/null >/dev/null

    # 4h. Ask the agent to check the approval status — rejection should be visible
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

# ── 5. Alias-based session matching via gateway ──────────────────────────────
#
# Test flow:
#   1. Trigger #1 (runner): agent runs git worktree add → alias registered
#   2. Trigger #2 (gateway /cron): sends the alias as correlationKey
#      → gateway resolves alias → runner resumes session
#   3. Trigger #3 (runner): verify session continuity by recalling phrase

echo ""
echo "=== Alias-based Session Matching ==="

ALIAS_TS=$(date +%s)
ALIAS_BRANCH="e2e-alias-${ALIAS_TS}"
CORR_KEY_ALIAS="e2e-alias-session-${ALIAS_TS}"
ALIAS_PHRASE="ALIAS$(echo $ALIAS_TS | tail -c 6)"
ALIAS_REPO="${ALIAS_REPO:-acme-multi-hyphen-repo}"
ALIAS_DIR="/workspace/repos/$ALIAS_REPO"
ALIAS_WORKTREE="/workspace/worktrees/$ALIAS_REPO/$ALIAS_BRANCH"
EXPECTED_ALIAS="git:branch:${ALIAS_REPO}:${ALIAS_BRANCH}"

# Check prerequisites
if [[ ! -d "${HOST_WORKSPACE}/repos/$ALIAS_REPO/.git" ]]; then
  echo "  ⚠ Repo $ALIAS_REPO not found or not a git repo — skipping alias tests"
elif [[ -z "$CRON_SECRET" ]]; then
  echo "  ⚠ CRON_SECRET not available — skipping alias tests"
else
  # 5a. Trigger #1 (runner): plant a phrase and run git worktree add
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

  # 5b. Trigger #2 (gateway /cron): use the git branch alias as correlationKey
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

  # 5c. Trigger #3 (runner): verify session continuity by recalling the phrase
  echo "  Waiting for cron trigger to finish, then sending trigger #3..."
  alias_trigger3_done="no"
  for i in $(seq 1 30); do
    sleep 2
    alias_trigger3_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
      -H 'Content-Type: application/json' \
      -d "{\"prompt\":\"What is the phrase I asked you to remember earlier? Reply with just the phrase.\",\"correlationKey\":\"$CORR_KEY_ALIAS\",\"directory\":\"$ALIAS_DIR\"}" \
      --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
    alias_trigger3=$(echo "$alias_trigger3_raw" | parse_done)
    alias_trigger3_session=$(json_field "$alias_trigger3" "sessionId")
    # Keep polling if session is busy OR if the response is empty (request failed)
    if [[ -n "$alias_trigger3_session" ]]; then
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
  curl -sf -X POST "$REMOTE_CLI_URL/exec/git" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"worktree\",\"remove\",\"--force\",\"$ALIAS_WORKTREE\"],\"cwd\":\"$ALIAS_DIR\"}" \
    2>/dev/null >/dev/null
  curl -sf -X POST "$REMOTE_CLI_URL/exec/git" \
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
