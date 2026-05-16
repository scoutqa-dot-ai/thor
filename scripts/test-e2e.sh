#!/usr/bin/env bash
#
# End-to-end test for Thor.
#
# Deterministic direct service checks only; no OpenCode/LLM-backed /trigger or
# cron/hey-thor calls. Use scripts/test-opencode-e2e.sh for model-backed smoke.
#
# Prerequisites:
#   - Both services running (either `pnpm dev` or `docker compose up`)
#
# Usage:
#   REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
#   REMOTE_CLI_GITHUB_REPO=owner/repo \
#   GIT_CLONE_ALLOWED_OWNERS=owner \
#     ./scripts/test-e2e.sh
#   RUNNER_URL=http://localhost:3000 REMOTE_CLI_URL=http://localhost:3004 \
#   REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
#   REMOTE_CLI_GITHUB_REPO=owner/repo \
#   GIT_CLONE_ALLOWED_OWNERS=owner \
#     ./scripts/test-e2e.sh
#
set -euo pipefail

repo_name_from_clone_url() {
  local url="$1"
  local repo="${url##*/}"
  repo="${repo%.git}"
  echo "$repo"
}

: "${REMOTE_CLI_GIT_REPO_URL:?REMOTE_CLI_GIT_REPO_URL is required}"
: "${REMOTE_CLI_GITHUB_REPO:?REMOTE_CLI_GITHUB_REPO is required}"
: "${GIT_CLONE_ALLOWED_OWNERS:?GIT_CLONE_ALLOWED_OWNERS is required}"

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
THOR_INTERNAL_SECRET="${THOR_INTERNAL_SECRET:-$(docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET 2>/dev/null)}"
REMOTE_CLI_GIT_REPO_NAME="${REMOTE_CLI_GIT_REPO_NAME:-$(repo_name_from_clone_url "$REMOTE_CLI_GIT_REPO_URL")}"
REMOTE_CLI_GIT_REPO_DIR="${REMOTE_CLI_GIT_REPO_DIR:-/workspace/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_DIR="${HOST_REMOTE_CLI_GIT_REPO_DIR:-${HOST_WORKSPACE}/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_MARKER="${HOST_REMOTE_CLI_GIT_REPO_DIR}/.thor-e2e-clone"
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
echo "  ℹ deterministic mode: no /trigger OpenCode/LLM prompts are executed"

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

if [[ -e "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]]; then
  if [[ -f "$HOST_REMOTE_CLI_GIT_REPO_MARKER" ]]; then
    rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
  else
    echo "  ✗ refusing to remove existing repo without e2e marker: $HOST_REMOTE_CLI_GIT_REPO_DIR"
    echo "    → choose a disposable REMOTE_CLI_GIT_REPO_URL or remove the directory manually"
    echo ""
    echo "FAIL — clone target is not safe to replace"
    exit 1
  fi
fi
[[ -n "$HOST_REMOTE_CLI_WORKTREE_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_WORKTREE_DIR"
mkdir -p "$(dirname "$HOST_REMOTE_CLI_GIT_REPO_DIR")" "$(dirname "$HOST_REMOTE_CLI_WORKTREE_DIR")"

echo "  Cloning $REMOTE_CLI_GIT_REPO_URL through /exec/git..."
clone_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"clone\",\"$REMOTE_CLI_GIT_REPO_URL\"],\"cwd\":\"/workspace/repos\"}" \
  2>/dev/null || echo '{}')
clone_exit=$(json_field "$clone_raw" "exitCode")
clone_output=$(json_field "$clone_raw" "stderr")
clone_origin_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
  -H 'Content-Type: application/json' \
  -d "{\"args\":[\"remote\",\"get-url\",\"origin\"],\"cwd\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
  2>/dev/null || echo '{}')
clone_origin=$(json_field "$clone_origin_raw" "stdout")

assert '[[ "$clone_exit" == "0" ]]' \
  "remote-cli /exec/git cloned the GitHub repo" \
  "response: ${clone_raw:0:300}"
assert '[[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]' \
  "cloned repo exists on the shared host workspace" \
  "output: ${clone_output:0:300}"
if [[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]; then
  touch "$HOST_REMOTE_CLI_GIT_REPO_MARKER"
fi
assert '[[ "$clone_origin" == "$REMOTE_CLI_GIT_REPO_URL" ]]' \
  "cloned repo origin matches expected URL" \
  "origin='$clone_origin'"

if [[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" && "$clone_origin" == "$REMOTE_CLI_GIT_REPO_URL" ]]; then
  if [[ -z "$THOR_INTERNAL_SECRET" ]]; then
    assert 'false' \
      "Internal exec PR-head smoke: THOR_INTERNAL_SECRET is available" \
      "Set THOR_INTERNAL_SECRET or ensure docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET returns a value"
  else
    echo "  Calling /internal/exec directly (gh pr list + gh pr view)..."
    internal_pr_list_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/internal/exec" \
      -H 'Content-Type: application/json' \
      -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
      -d "{\"bin\":\"gh\",\"args\":[\"pr\",\"list\",\"--repo\",\"$REMOTE_CLI_GITHUB_REPO\",\"--state\",\"all\",\"--limit\",\"1\",\"--json\",\"number\"],\"cwd\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
      2>/dev/null || echo '{}')
    internal_pr_list_exit=$(json_field "$internal_pr_list_raw" "exitCode")
    internal_pr_number=$(echo "$internal_pr_list_raw" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const prs = JSON.parse(d.stdout || '[]');
      console.log(prs[0]?.number || '');
    " 2>/dev/null || echo "")

    assert '[[ "$internal_pr_list_exit" == "0" ]]' \
      "Internal exec PR-head smoke: gh pr list succeeds" \
      "response: ${internal_pr_list_raw:0:300}"
    assert '[[ -n "$internal_pr_number" ]]' \
      "Internal exec PR-head smoke: found a PR to inspect" \
      "response: ${internal_pr_list_raw:0:300}"

    if [[ -n "$internal_pr_number" ]]; then
      internal_pr_view_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/internal/exec" \
        -H 'Content-Type: application/json' \
        -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
        -d "{\"bin\":\"gh\",\"args\":[\"pr\",\"view\",\"$internal_pr_number\",\"--repo\",\"$REMOTE_CLI_GITHUB_REPO\",\"--json\",\"headRefName,headRepository,headRepositoryOwner\"],\"cwd\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
        2>/dev/null || echo '{}')
      internal_pr_view_exit=$(json_field "$internal_pr_view_raw" "exitCode")
      internal_pr_head_ref=$(echo "$internal_pr_view_raw" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const out = JSON.parse(d.stdout || '{}');
        console.log(out.headRefName || '');
      " 2>/dev/null || echo "")
      internal_pr_head_owner=$(echo "$internal_pr_view_raw" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const out = JSON.parse(d.stdout || '{}');
        console.log(out.headRepositoryOwner?.login || '');
      " 2>/dev/null || echo "")
      internal_pr_head_repo=$(echo "$internal_pr_view_raw" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const out = JSON.parse(d.stdout || '{}');
        console.log(out.headRepository?.name || '');
      " 2>/dev/null || echo "")

      assert '[[ "$internal_pr_view_exit" == "0" ]]' \
        "Internal exec PR-head smoke: gh pr view succeeds" \
        "response: ${internal_pr_view_raw:0:300}"
      assert '[[ -n "$internal_pr_head_ref" && -n "$internal_pr_head_owner" && -n "$internal_pr_head_repo" ]]' \
        "Internal exec PR-head smoke: gh pr view returns head ref and repo owner/name" \
        "ref='$internal_pr_head_ref', owner='$internal_pr_head_owner', repo='$internal_pr_head_repo'"
    fi
  fi

  if [[ -z "$THOR_INTERNAL_SECRET" ]]; then
    assert 'false' \
      "Internal exec worktree smoke: THOR_INTERNAL_SECRET is available" \
      "Set THOR_INTERNAL_SECRET or ensure docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET returns a value"
  else
    echo "  Calling /internal/exec directly (git worktree add)..."
    worktree_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/internal/exec" \
      -H 'Content-Type: application/json' \
      -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
      -d "{\"bin\":\"git\",\"args\":[\"worktree\",\"add\",\"-b\",\"$REMOTE_CLI_WORKTREE_BRANCH\",\"$REMOTE_CLI_WORKTREE_DIR\",\"HEAD\"],\"cwd\":\"$REMOTE_CLI_GIT_REPO_DIR\"}" \
      2>/dev/null || echo '{}')
    worktree_exit=$(json_field "$worktree_raw" "exitCode")
    worktree_list=$(docker exec "$remote_cli_container" \
      git -C "$REMOTE_CLI_GIT_REPO_DIR" worktree list 2>/dev/null || echo "")

    assert '[[ "$worktree_exit" == "0" ]]' \
      "Internal exec worktree smoke: git worktree add succeeds" \
      "response: ${worktree_raw:0:300}"
  fi
  assert '[[ -d "$HOST_REMOTE_CLI_WORKTREE_DIR" ]]' \
    "Internal exec worktree smoke: worktree path exists on disk" \
    "expected path: $HOST_REMOTE_CLI_WORKTREE_DIR"
  assert '[[ "$worktree_list" == *"$REMOTE_CLI_WORKTREE_DIR"* ]]' \
    "Internal exec worktree smoke: cloned repo registers the new worktree" \
    "worktree list: ${worktree_list:0:300}"
fi

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

  trigger_context_raw=$(curl -sf -X POST "$RUNNER_URL/internal/e2e/trigger-context" \
    -H 'Content-Type: application/json' \
    -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
    -d '{"correlationKey":"e2e-approval-flow"}' \
    2>/dev/null || echo '{}')
  E2E_THOR_SESSION_ID=$(json_field "$trigger_context_raw" "sessionId")
  E2E_THOR_TRIGGER_ID=$(json_field "$trigger_context_raw" "triggerId")
  assert '[[ -n "$E2E_THOR_SESSION_ID" && -n "$E2E_THOR_TRIGGER_ID" ]]' \
    "runner: created e2e trigger context" \
    "response: ${trigger_context_raw:0:300}; set THOR_E2E_TEST_HELPERS=1 for the runner service"

  # 4b. remote-cli-level: call the approval-required tool directly
  echo "  Calling tool via remote-cli (expecting approval interception)..."
  case "$APPROVAL_UPSTREAM/$APPROVAL_TOOL" in
    atlassian/createJiraIssue)
      approval_args_json='{"cloudId":"e2e-cloud","projectKey":"THOR","issueTypeName":"Task","summary":"e2e approval summary","description":"e2e approval body"}'
      ;;
    atlassian/addCommentToJiraIssue)
      approval_args_json='{"cloudId":"e2e-cloud","issueIdOrKey":"THOR-1","commentBody":"e2e approval body"}'
      ;;
    posthog/create-feature-flag)
      approval_args_json="{\"key\":\"thor-e2e-approval-${REMOTE_CLI_AUTH_TS}\",\"name\":\"Thor E2E approval ${REMOTE_CLI_AUTH_TS}\",\"description\":\"e2e approval body\",\"active\":false}"
      ;;
    *)
      approval_args_json='{"description":"e2e approval body"}'
      ;;
  esac
  escaped_approval_args=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$approval_args_json")
  call_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
    -H 'Content-Type: application/json' \
    -H "x-thor-session-id: $E2E_THOR_SESSION_ID" \
    -d "{\"args\":[\"$APPROVAL_UPSTREAM\",\"$APPROVAL_TOOL\",$escaped_approval_args],\"cwd\":\"$APPROVAL_DIR\",\"directory\":\"$APPROVAL_DIR\"}" \
    2>/dev/null || echo '{}')

  # Parse action ID from the remote-cli approval-required response.
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

# ── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

[[ -n "$HOST_REMOTE_CLI_WORKTREE_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_WORKTREE_DIR"
if [[ -f "$HOST_REMOTE_CLI_GIT_REPO_MARKER" ]]; then
  rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
fi

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
