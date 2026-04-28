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
THOR_INTERNAL_SECRET="${THOR_INTERNAL_SECRET:-$(docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET 2>/dev/null)}"
REMOTE_CLI_GIT_REPO_URL="${REMOTE_CLI_GIT_REPO_URL:-https://github.com/scoutqa-dot-ai/thor}"
REMOTE_CLI_GIT_REPO_NAME="${REMOTE_CLI_GIT_REPO_NAME:-scoutqa-dot-ai-thor-e2e}"
REMOTE_CLI_GIT_REPO_DIR="${REMOTE_CLI_GIT_REPO_DIR:-/workspace/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_DIR="${HOST_REMOTE_CLI_GIT_REPO_DIR:-${HOST_WORKSPACE}/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
REMOTE_CLI_AUTH_TS="${REMOTE_CLI_AUTH_TS:-$(date +%s)}"
REMOTE_CLI_WORKTREE_BRANCH="${REMOTE_CLI_WORKTREE_BRANCH:-e2e-remote-cli-${REMOTE_CLI_AUTH_TS}}"
REMOTE_CLI_WORKTREE_DIR="${REMOTE_CLI_WORKTREE_DIR:-/workspace/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${REMOTE_CLI_WORKTREE_BRANCH}}"
HOST_REMOTE_CLI_WORKTREE_DIR="${HOST_REMOTE_CLI_WORKTREE_DIR:-${HOST_WORKSPACE}/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${REMOTE_CLI_WORKTREE_BRANCH}}"

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

# ── Prerequisites ──────────────────────────────────────────────────────────
#
# Fail early if the environment isn't ready. Every section below depends on
# healthy services and a discoverable remote-cli container.

echo ""
echo "=== Prerequisites ==="

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

if [[ "$remote_cli_health" == *"ok"* ]]; then
  echo "  ✓ remote-cli is healthy"
else
  echo "  ✗ remote-cli is not healthy at $REMOTE_CLI_URL"
  preflight_ok=false
fi

if [[ "$runner_health" == *"ok"* ]]; then
  echo "  ✓ runner is healthy"
else
  echo "  ✗ runner is not healthy at $RUNNER_URL"
  preflight_ok=false
fi

if [[ "$gateway_health" == *"ok"* ]]; then
  echo "  ✓ gateway is healthy"
else
  echo "  ✗ gateway is not healthy at $GATEWAY_URL"
  preflight_ok=false
fi

if [[ "$preflight_ok" != "true" ]]; then
  echo ""
  echo "FAIL — prerequisites not met"
  exit 1
fi

# ── 2. Remote-cli git/gh auth ────────────────────────────────────────────────

echo ""
echo "=== Remote-CLI Git/GH Auth ==="

[[ -n "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
[[ -n "$HOST_REMOTE_CLI_WORKTREE_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_WORKTREE_DIR"
mkdir -p "$(dirname "$HOST_REMOTE_CLI_GIT_REPO_DIR")" "$(dirname "$HOST_REMOTE_CLI_WORKTREE_DIR")"

echo "  Cloning $REMOTE_CLI_GIT_REPO_URL inside $remote_cli_container..."
clone_output=$(docker exec "$remote_cli_container" \
  git clone "$REMOTE_CLI_GIT_REPO_URL" "$REMOTE_CLI_GIT_REPO_DIR" 2>&1 || true)
clone_origin=$(docker exec "$remote_cli_container" \
  git -C "$REMOTE_CLI_GIT_REPO_DIR" remote get-url origin 2>/dev/null || echo "")

assert '[[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]' \
  "docker exec in remote-cli cloned the GitHub repo" \
  "output: ${clone_output:0:300}"
assert '[[ "$clone_origin" == "$REMOTE_CLI_GIT_REPO_URL" ]]' \
  "cloned repo origin matches expected URL" \
  "origin='$clone_origin'"

if [[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" && "$clone_origin" == "$REMOTE_CLI_GIT_REPO_URL" ]]; then
  REMOTE_CLI_GH_CORR_KEY="e2e-remote-cli-gh-${REMOTE_CLI_AUTH_TS}"
  echo "  Sending trigger #1 (asking agent to run gh pr list)..."
  gh_trigger_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
    -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"Run: gh pr list --limit 5\\nIf the command succeeds, reply with GH_PR_LIST_OK on the first line, then summarize the result in one short sentence. If the command fails, reply with GH_PR_LIST_FAILED on the first line and include the error.\",\"correlationKey\":\"$REMOTE_CLI_GH_CORR_KEY\",\"directory\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
    --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
  gh_trigger=$(echo "$gh_trigger_raw" | parse_done)

  gh_session=$(json_field "$gh_trigger" "sessionId")
  gh_status=$(json_field "$gh_trigger" "status")
  gh_response_text=$(json_field "$gh_trigger" "response")
  gh_response_ok=$(response_contains "$gh_trigger" "GH_PR_LIST_OK")

  assert '[[ -n "$gh_session" ]]' "GH auth trigger: got a session ID" "sessionId='$gh_session'"
  assert '[[ "$gh_status" == "completed" ]]' "GH auth trigger: completed successfully" "status='$gh_status'"
  assert '[[ "$gh_response_ok" == "yes" ]]' \
    "GH auth trigger: agent successfully listed PRs" \
    "response: ${gh_response_text:0:300}"

  REMOTE_CLI_WORKTREE_CORR_KEY="e2e-remote-cli-worktree-${REMOTE_CLI_AUTH_TS}"
  echo "  Sending trigger #2 (asking agent to create a worktree)..."
  worktree_trigger_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
    -H 'Content-Type: application/json' \
    -d "{\"prompt\":\"Run: git worktree add -b $REMOTE_CLI_WORKTREE_BRANCH $REMOTE_CLI_WORKTREE_DIR HEAD\\nIf the command succeeds, reply with GIT_WORKTREE_OK on the first line, then mention the branch name. If the command fails, reply with GIT_WORKTREE_FAILED on the first line and include the error.\",\"correlationKey\":\"$REMOTE_CLI_WORKTREE_CORR_KEY\",\"directory\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
    --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
  worktree_trigger=$(echo "$worktree_trigger_raw" | parse_done)

  worktree_session=$(json_field "$worktree_trigger" "sessionId")
  worktree_status=$(json_field "$worktree_trigger" "status")
  worktree_response_text=$(json_field "$worktree_trigger" "response")
  worktree_response_ok=$(response_contains "$worktree_trigger" "GIT_WORKTREE_OK")
  worktree_list=$(docker exec "$remote_cli_container" \
    git -C "$REMOTE_CLI_GIT_REPO_DIR" worktree list 2>/dev/null || echo "")

  assert '[[ -n "$worktree_session" ]]' "Worktree trigger: got a session ID" "sessionId='$worktree_session'"
  assert '[[ "$worktree_status" == "completed" ]]' "Worktree trigger: completed successfully" "status='$worktree_status'"
  assert '[[ "$worktree_response_ok" == "yes" ]]' \
    "Worktree trigger: agent created the worktree" \
    "response: ${worktree_response_text:0:300}"
  assert '[[ -d "$HOST_REMOTE_CLI_WORKTREE_DIR" ]]' \
    "Worktree trigger: worktree path exists on disk" \
    "expected path: $HOST_REMOTE_CLI_WORKTREE_DIR"
  assert '[[ "$worktree_list" == *"$REMOTE_CLI_WORKTREE_DIR"* ]]' \
    "Worktree trigger: cloned repo registers the new worktree" \
    "worktree list: ${worktree_list:0:300}"
fi

# ── 3. Session resume via correlation key ────────────────────────────────────

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

# ── 4. Cross-session memory ──────────────────────────────────────────────────

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

# ── 5. Approval Flow ────────────────────────────────────────────────────────

echo ""
echo "=== Approval Flow ==="

# 4a. Discover an approval-required tool from an upstream
APPROVAL_UPSTREAM=""
APPROVAL_TOOL=""
APPROVAL_DIR=""
CONFIG_FILE="${HOST_WORKSPACE}/config.json"
APPROVAL_DISCOVERY_DEBUG=""
approval_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')

if [[ ! -f "$CONFIG_FILE" ]]; then
  APPROVAL_DISCOVERY_DEBUG="workspace config not found at $CONFIG_FILE"
else
  repo_upstream_pairs=$(CONFIG_FILE="$CONFIG_FILE" node -e "
    const fs = require('fs');
    const health = JSON.parse(fs.readFileSync(0, 'utf8'));
    const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, 'utf8'));
    const connected = new Set(
      Object.entries(health.mcp?.instances || {})
        .filter(([, info]) => info && info.connected)
        .map(([name]) => name)
    );
    for (const [repo, rcfg] of Object.entries(cfg.repos || {})) {
      for (const upstream of (rcfg.proxies || [])) {
        if (connected.has(upstream)) {
          console.log(repo + ':' + upstream);
        }
      }
    }
  " <<<"$approval_health" 2>/dev/null || echo "")

  if [[ "$approval_health" != *'"status":"ok"'* ]]; then
    APPROVAL_DISCOVERY_DEBUG="remote-cli health unavailable at $REMOTE_CLI_URL"
  elif [[ -z "$repo_upstream_pairs" ]]; then
    APPROVAL_DISCOVERY_DEBUG="No configured repo has a connected MCP upstream. Check $CONFIG_FILE and $REMOTE_CLI_URL/health."
  else
    while IFS= read -r pair; do
      [[ -n "$pair" ]] || continue
      repo_name="${pair%%:*}"
      upstream_name="${pair##*:}"
      test_dir="/workspace/repos/$repo_name"
      host_dir="${HOST_WORKSPACE}/repos/$repo_name"
      found_tool="$(approval_tool_for_upstream "$upstream_name")"
      # Repo directory must exist on host (mounted into container)
      if [[ ! -d "$host_dir" ]]; then
        APPROVAL_DISCOVERY_DEBUG="${APPROVAL_DISCOVERY_DEBUG:+$APPROVAL_DISCOVERY_DEBUG; }missing host repo dir: $host_dir"
        continue
      fi
      if [[ -n "$found_tool" ]]; then
        APPROVAL_UPSTREAM="$upstream_name"
        APPROVAL_TOOL="$found_tool"
        APPROVAL_DIR="$test_dir"
        break
      fi
      APPROVAL_DISCOVERY_DEBUG="${APPROVAL_DISCOVERY_DEBUG:+$APPROVAL_DISCOVERY_DEBUG; }upstream $upstream_name has no approval-required tool in e2e map"
    done <<<"$repo_upstream_pairs"
  fi
fi

if [[ -z "$APPROVAL_TOOL" ]]; then
  assert 'false' "approval flow: discovered an approval-required tool" "${APPROVAL_DISCOVERY_DEBUG:-approval tool discovery returned no match}"
elif [[ -z "$THOR_INTERNAL_SECRET" ]]; then
  assert 'false' "approval flow: THOR_INTERNAL_SECRET is available" "Set THOR_INTERNAL_SECRET or ensure docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET returns a value"
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
      -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
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
      -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
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

# ── 6. Git/GH policy enforcement ─────────────────────────────────────────────
#
# Validates that remote-cli blocks disallowed git/gh commands at the policy
# layer. These are direct HTTP calls — no LLM round-trip needed.

echo ""
echo "=== Git/GH Policy Enforcement ==="

POLICY_CWD="${POLICY_CWD:-/workspace/repos/${ALIAS_REPO:-acme-multi-hyphen-repo}}"

# 6a. git checkout should be blocked
checkout_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"checkout\",\"main\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
checkout_exit=$(json_field "$checkout_raw" "exitCode")
checkout_stderr=$(json_field "$checkout_raw" "stderr")
assert '[[ "$checkout_exit" == "1" ]]' "git checkout is blocked" "exitCode='$checkout_exit'"
assert '[[ "$checkout_stderr" == *"not allowed"* ]]' "git checkout error mentions not allowed" "stderr='${checkout_stderr:0:200}'"

# 6b. git switch should be blocked
switch_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"switch\",\"main\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
switch_exit=$(json_field "$switch_raw" "exitCode")
assert '[[ "$switch_exit" == "1" ]]' "git switch is blocked" "exitCode='$switch_exit'"

# 6c. Leading flags should be blocked
flag_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"-c\",\"user.name=x\",\"status\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
flag_exit=$(json_field "$flag_raw" "exitCode")
flag_stderr=$(json_field "$flag_raw" "stderr")
assert '[[ "$flag_exit" == "1" ]]' "git leading flags are blocked" "exitCode='$flag_exit'"
assert '[[ "$flag_stderr" == *"Load skill using-git"* ]]' "leading flags error points to using-git" "stderr='${flag_stderr:0:200}'"

# 6d. git push to non-origin remote should be blocked
push_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"push\",\"upstream\",\"main\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
push_exit=$(json_field "$push_raw" "exitCode")
push_stderr=$(json_field "$push_raw" "stderr")
assert '[[ "$push_exit" == "1" ]]' "git push to non-origin is blocked" "exitCode='$push_exit'"
assert '[[ "$push_stderr" == *"Load skill using-git"* ]]' "push error points to using-git" "stderr='${push_stderr:0:200}'"

# 6e. cwd outside /workspace should be blocked
cwd_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"status\"],\"cwd\":\"/tmp/evil\"}" \
  2>/dev/null || echo '{}')
cwd_exit=$(json_field "$cwd_raw" "exitCode")
assert '[[ "$cwd_exit" == "1" ]]' "git cwd outside /workspace is blocked" "exitCode='$cwd_exit'"

# 6f. unsafe gh api shapes should be blocked
gh_api_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/gh" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"api\",\"repos/{owner}/{repo}\",\"--method\",\"GET\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
gh_api_exit=$(json_field "$gh_api_raw" "exitCode")
gh_api_stderr=$(json_field "$gh_api_raw" "stderr")
assert '[[ "$gh_api_exit" == "1" ]]' "unsafe gh api shapes are blocked" "exitCode='$gh_api_exit'"
assert '[[ "$gh_api_stderr" == *"not allowed"* ]]' "gh api error mentions not allowed" "stderr='${gh_api_stderr:0:200}'"

# 6g. gh api help should be allowed
gh_api_help_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/gh" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"api\",\"--help\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
gh_api_help_exit=$(json_field "$gh_api_help_raw" "exitCode")
assert '[[ "$gh_api_help_exit" == "0" ]]' "gh api help succeeds" "exitCode='$gh_api_help_exit'"

# 6h. gh pr checkout should be blocked
gh_prco_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/gh" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"pr\",\"checkout\",\"1\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
gh_prco_exit=$(json_field "$gh_prco_raw" "exitCode")
assert '[[ "$gh_prco_exit" == "1" ]]' "gh pr checkout is blocked" "exitCode='$gh_prco_exit'"

# 6i. Allowed read commands should succeed
status_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"status\"],\"cwd\":\"$POLICY_CWD\"}" \
  2>/dev/null || echo '{}')
status_exit=$(json_field "$status_raw" "exitCode")
assert '[[ "$status_exit" == "0" ]]' "git status (allowed) succeeds" "exitCode='$status_exit'"

# ── 7. Busy session + interrupt ──────────────────────────────────────────────
#
# Tests that a busy session returns { busy: true } without interrupt,
# and that interrupt=true aborts the busy session and executes the new prompt.

echo ""
echo "=== Busy Session + Interrupt ==="

BUSY_CORR_KEY="e2e-busy-$(date +%s)"
BUSY_PHRASE="BUSY$(date +%s | tail -c 6)"

# 7a. Start a long-running trigger (sleep prompt) in the background
echo "  Sending trigger #1 (long-running prompt to occupy session)..."
curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Run a bash command: sleep 30. Then say DONE.\",\"correlationKey\":\"$BUSY_CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 10 2>/dev/null >/dev/null &
BUSY_BG_PID=$!
sleep 5

# 7b. Send a non-interrupt trigger — should get { busy: true }
echo "  Sending trigger #2 (non-interrupt, expecting busy)..."
busy_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Say hello.\",\"correlationKey\":\"$BUSY_CORR_KEY\",\"directory\":\"$SESSION_DIR\"}" \
  --max-time 30 2>/dev/null || echo '{}')
busy_val=$(json_field "$busy_raw" "busy")
assert '[[ "$busy_val" == "true" ]]' "Non-interrupt trigger returns busy" "response: ${busy_raw:0:200}"

# 7c. Send an interrupt trigger — should abort and execute
echo "  Sending trigger #3 (interrupt=true, expecting execution)..."
interrupt_raw=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Our secret word is $BUSY_PHRASE. Confirm by repeating it back.\",\"correlationKey\":\"$BUSY_CORR_KEY\",\"interrupt\":true,\"directory\":\"$SESSION_DIR\"}" \
  --max-time 180 2>/dev/null || echo '{"type":"done","error":"request failed"}')
interrupt_trigger=$(echo "$interrupt_raw" | parse_done)

interrupt_session=$(json_field "$interrupt_trigger" "sessionId")
interrupt_status=$(json_field "$interrupt_trigger" "status")
interrupt_response=$(json_field "$interrupt_trigger" "response")
interrupt_has_phrase=$(response_contains "$interrupt_trigger" "$BUSY_PHRASE")

assert '[[ -n "$interrupt_session" ]]' "Interrupt trigger: got a session ID" "sessionId='$interrupt_session'"
assert '[[ "$interrupt_status" == "completed" ]]' "Interrupt trigger: completed successfully" "status='$interrupt_status'"
assert '[[ "$interrupt_has_phrase" == "yes" ]]' "Interrupt trigger: agent confirmed the phrase" "response: ${interrupt_response:0:200}"

# Clean up background curl
kill "$BUSY_BG_PID" 2>/dev/null || true
wait "$BUSY_BG_PID" 2>/dev/null || true


# ── 9. Alias-based session matching via gateway ──────────────────────────────
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
ALIAS_PHRASE="ALIAS$(echo "${ALIAS_TS}" | tail -c 6)"
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

  # Best-effort cleanup of the test worktree/branch via policy. Both
  # `git worktree remove --force` and `git branch -D` are intentionally outside
  # the policy allowlist (destructive verbs), so these calls may return 4xx —
  # that's fine. The script wipes the entire repo dir at exit anyway, so
  # leftover branches/worktrees never persist across CI runs.
  echo ""
  echo "  Cleaning up test worktree and branch (best-effort)..."
  curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"worktree\",\"remove\",\"$ALIAS_WORKTREE\"],\"cwd\":\"$ALIAS_DIR\"}" \
    >/dev/null 2>&1 || true
  curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
    -H 'Content-Type: application/json' \
    -d "{\"args\":[\"worktree\",\"prune\"],\"cwd\":\"$ALIAS_DIR\"}" \
    >/dev/null 2>&1 || true
fi

# ── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

# Clean up e2e test directory and per-repo memory (only if we created the default one)
[[ "$SESSION_DIR" == "/workspace/repos/e2e-test" && -n "$HOST_WORKSPACE" ]] && rm -rf "${HOST_WORKSPACE}/repos/e2e-test" "${MEMORY_DIR}/e2e-test"
[[ -n "$HOST_REMOTE_CLI_WORKTREE_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_WORKTREE_DIR"
[[ -n "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
