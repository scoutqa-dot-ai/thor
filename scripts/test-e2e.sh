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
#     ./scripts/test-e2e.sh
#   RUNNER_URL=http://localhost:3000 REMOTE_CLI_URL=http://localhost:3004 \
#   REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
#   REMOTE_CLI_GITHUB_REPO=owner/repo \
#     ./scripts/test-e2e.sh
#
# The repo's owner must be present in /workspace/config/thor.json's `owners` map for
# `git clone` to pass policy and resolve a GitHub App installation. The same
# config must contain the THOR_E2E_JIRA_EMAIL user for attribution checks.
set -euo pipefail

repo_name_from_clone_url() {
  local url="$1"
  local repo="${url##*/}"
  repo="${repo%.git}"
  echo "$repo"
}

: "${REMOTE_CLI_GIT_REPO_URL:?REMOTE_CLI_GIT_REPO_URL is required}"
: "${REMOTE_CLI_GITHUB_REPO:?REMOTE_CLI_GITHUB_REPO is required}"

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3002}"
SLACK_API_URL="${SLACK_API_URL:-https://slack.com/api}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_CHANNEL_ID="${SLACK_E2E_CHANNEL_ID:-${SLACK_CHANNEL_ID:-}}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
HOST_WORKSPACE_CONFIG="${HOST_WORKSPACE_CONFIG:-${HOST_WORKSPACE}/config/thor.json}"
THOR_INTERNAL_SECRET="${THOR_INTERNAL_SECRET:-$(docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET 2>/dev/null)}"
REMOTE_CLI_GIT_REPO_NAME="${REMOTE_CLI_GIT_REPO_NAME:-$(repo_name_from_clone_url "$REMOTE_CLI_GIT_REPO_URL")}"
REMOTE_CLI_GIT_REPO_DIR="${REMOTE_CLI_GIT_REPO_DIR:-/workspace/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_DIR="${HOST_REMOTE_CLI_GIT_REPO_DIR:-${HOST_WORKSPACE}/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_MARKER="${HOST_REMOTE_CLI_GIT_REPO_DIR}/.thor-e2e-clone"
REMOTE_CLI_AUTH_TS="${REMOTE_CLI_AUTH_TS:-$(date +%s)}"
REMOTE_CLI_WORKTREE_BRANCH="${REMOTE_CLI_WORKTREE_BRANCH:-e2e-remote-cli-${REMOTE_CLI_AUTH_TS}}"
REMOTE_CLI_WORKTREE_DIR="${REMOTE_CLI_WORKTREE_DIR:-/workspace/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${REMOTE_CLI_WORKTREE_BRANCH}}"
HOST_REMOTE_CLI_WORKTREE_DIR="${HOST_REMOTE_CLI_WORKTREE_DIR:-${HOST_WORKSPACE}/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${REMOTE_CLI_WORKTREE_BRANCH}}"
DEFAULT_THOR_E2E_JIRA_EMAIL="thor-e2e-reviewer@example.com"
ATTRIBUTION_E2E_SLACK_ID="${ATTRIBUTION_E2E_SLACK_ID:-U_E2E_ATTRIBUTION}"
ATTRIBUTION_E2E_NAME="${ATTRIBUTION_E2E_NAME:-Thor E2E Reviewer}"
ATTRIBUTION_E2E_GITHUB="${ATTRIBUTION_E2E_GITHUB:-thor-e2e-reviewer}"
THOR_E2E_JIRA_EMAIL="${THOR_E2E_JIRA_EMAIL:-$DEFAULT_THOR_E2E_JIRA_EMAIL}"
JIRA_CLOUD_ID="${JIRA_CLOUD_ID:-}"
export REMOTE_CLI_GIT_REPO_DIR REMOTE_CLI_WORKTREE_BRANCH REMOTE_CLI_WORKTREE_DIR
export ATTRIBUTION_E2E_SLACK_ID ATTRIBUTION_E2E_NAME ATTRIBUTION_E2E_GITHUB THOR_E2E_JIRA_EMAIL
export JIRA_CLOUD_ID SLACK_CHANNEL_ID
JIRA_E2E_ISSUE_KEY=""
passed=0
failed=0

cleanup() {
  if [[ -n "${JIRA_E2E_ISSUE_KEY:-}" && -n "${ATLASSIAN_AUTH:-}" && -n "${JIRA_CLOUD_ID:-}" ]]; then
    jira_delete_issue "$JIRA_E2E_ISSUE_KEY" >/dev/null 2>&1 || true
  fi

  [[ -n "$HOST_REMOTE_CLI_WORKTREE_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_WORKTREE_DIR"
  if [[ -f "$HOST_REMOTE_CLI_GIT_REPO_MARKER" ]]; then
    rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
  fi
}

trap cleanup EXIT

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
  echo "$json" | FIELD="$field" node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const path = process.env.FIELD.split('.');
    let v = d;
    for (const part of path) v = v?.[part];
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

json_string() {
  node -e "console.log(JSON.stringify(process.argv[1]))" "$1"
}

exec_payload() {
  local cwd="$1"
  shift
  node -e "
    console.log(JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.argv[1]
    }));
  " "$cwd" "$@"
}

jira_api_base() {
  local cloud="$JIRA_CLOUD_ID"
  if [[ "$cloud" == http://* || "$cloud" == https://* ]]; then
    echo "${cloud%/}/rest/api/3"
  else
    echo "https://api.atlassian.com/ex/jira/$cloud/rest/api/3"
  fi
}

jira_delete_issue() {
  local issue_key="$1"
  curl -sS -X DELETE \
    -H "Authorization: $ATLASSIAN_AUTH" \
    -H 'Accept: application/json' \
    "$(jira_api_base)/issue/$issue_key"
}

find_jira_tool_worklog_entry() {
  local tool="$1"
  WORKLOG_DIR="${HOST_WORKSPACE}/worklog" TOOL="$tool" node <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.env.WORKLOG_DIR;
const tool = process.env.TOOL;

function matchesJiraE2E(entry) {
  if (entry.tool !== tool) return false;
  if (tool === "lookupJiraAccountId") {
    return (
      entry.decision === "allowed" &&
      entry.args?.cloudId === process.env.JIRA_CLOUD_ID &&
      String(entry.args?.searchString || "").toLowerCase() ===
        process.env.THOR_E2E_JIRA_EMAIL.toLowerCase()
    );
  }
  if (tool === "createJiraIssue") {
    return entry.decision === "approved" && entry.args?.summary === process.env.JIRA_E2E_SUMMARY;
  }
  return false;
}

const files = fs.existsSync(root)
  ? fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(`_tool-call_${tool}.json`))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort()
      .reverse()
  : [];

for (const file of files) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!matchesJiraE2E(entry)) continue;
    console.log(JSON.stringify(entry));
    process.exit(0);
  } catch {}
}
process.exit(1);
NODE
}

extract_jira_issue_key() {
  local text="$1"
  ISSUE_TEXT="$text" node <<'NODE' 2>/dev/null || echo ""
const text = process.env.ISSUE_TEXT || "";
const project = "THORE2E";
const match = text.match(new RegExp("\\b" + project + "-[0-9]+\\b"));
console.log(match?.[0] || "");
NODE
}

assert_attribution_config() {
  if [[ ! -f "$HOST_WORKSPACE_CONFIG" ]]; then
    assert 'false' \
      "attribution e2e: workspace config exists" \
      "expected config at $HOST_WORKSPACE_CONFIG"
    return 1
  fi

  if CONFIG_PATH="$HOST_WORKSPACE_CONFIG" \
    THOR_E2E_JIRA_EMAIL="$THOR_E2E_JIRA_EMAIL" \
    ATTRIBUTION_E2E_NAME="$ATTRIBUTION_E2E_NAME" \
    ATTRIBUTION_E2E_SLACK_ID="$ATTRIBUTION_E2E_SLACK_ID" \
    ATTRIBUTION_E2E_GITHUB="$ATTRIBUTION_E2E_GITHUB" \
      node <<'NODE' >/dev/null
const fs = require("fs");
const path = process.env.CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const users = Array.isArray(config.users) ? config.users : [];
const match = users.find((user) =>
  String(user.email || "").toLowerCase() === process.env.THOR_E2E_JIRA_EMAIL.toLowerCase() &&
  String(user.name || "") === process.env.ATTRIBUTION_E2E_NAME &&
  String(user.slack || "").toUpperCase() === process.env.ATTRIBUTION_E2E_SLACK_ID.toUpperCase() &&
  String(user.github || "").toLowerCase() === process.env.ATTRIBUTION_E2E_GITHUB.toLowerCase()
);
if (!match) process.exit(1);
NODE
  then
    assert 'true' \
      "attribution e2e: workspace config includes the e2e attribution user"
  else
    assert 'false' \
      "attribution e2e: workspace config includes the e2e attribution user" \
      "expected users[] entry: email=$THOR_E2E_JIRA_EMAIL, name=$ATTRIBUTION_E2E_NAME, slack=$ATTRIBUTION_E2E_SLACK_ID, github=$ATTRIBUTION_E2E_GITHUB in $HOST_WORKSPACE_CONFIG"
    return 1
  fi
}

resolve_remote_cli_container() {
  if [[ -n "${REMOTE_CLI_CONTAINER:-}" ]]; then
    echo "$REMOTE_CLI_CONTAINER"
    return 0
  fi

  docker ps --filter label=com.docker.compose.service=remote-cli --format '{{.Names}}' 2>/dev/null | head -n 1
}

resolve_opencode_container() {
  if [[ -n "${OPENCODE_CONTAINER:-}" ]]; then
    echo "$OPENCODE_CONTAINER"
    return 0
  fi

  docker ps --filter label=com.docker.compose.service=opencode --format '{{.Names}}' 2>/dev/null | head -n 1
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
  local channel="$1"
  local ts="$2"
  curl -sS --get "$SLACK_API_URL/conversations.replies" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    --data-urlencode "channel=$channel" \
    --data-urlencode "ts=$ts" \
    --data-urlencode 'limit=100'
}

slack_file_info() {
  local file_id="$1"
  curl -sS --get "$SLACK_API_URL/files.info" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    --data-urlencode "file=$file_id"
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
opencode_container=$(resolve_opencode_container)
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

if [[ -n "$opencode_container" ]]; then
  echo "  ✓ opencode container: $opencode_container"
else
  echo "  ⚠ opencode container not found; Slack upload e2e will be skipped"
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

# ── 5. Attribution Flow ─────────────────────────────────────────────────────
#
# Verifies the mounted config contains the E2E attribution user, creates a
# synthetic trigger context with a Slack actor, then checks the real /exec/git
# handler stamps attribution before executing the underlying tool.

echo ""
echo "=== Attribution Flow ==="

if [[ ! -d "$HOST_REMOTE_CLI_WORKTREE_DIR" ]]; then
  assert 'false' \
    "attribution e2e: disposable worktree exists" \
    "expected path: $HOST_REMOTE_CLI_WORKTREE_DIR"
elif [[ -z "$THOR_INTERNAL_SECRET" ]]; then
  assert 'false' \
    "attribution e2e: THOR_INTERNAL_SECRET is available" \
    "Set THOR_INTERNAL_SECRET or ensure docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET returns a value"
elif assert_attribution_config; then
  attribution_trigger_body=$(node -e "
    console.log(JSON.stringify({
      correlationKey: 'e2e-attribution-flow',
      triggerSlackId: process.env.ATTRIBUTION_E2E_SLACK_ID
    }));
  ")
  attribution_context_raw=$(curl -sf -X POST "$RUNNER_URL/internal/e2e/trigger-context" \
    -H 'Content-Type: application/json' \
    -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
    -d "$attribution_trigger_body" \
    2>/dev/null || echo '{}')
  ATTRIBUTION_SESSION_ID=$(json_field "$attribution_context_raw" "sessionId")
  assert '[[ -n "$ATTRIBUTION_SESSION_ID" ]]' \
    "attribution e2e: runner created actor-bearing trigger context" \
    "response: ${attribution_context_raw:0:300}; set THOR_E2E_TEST_HELPERS=1 for the runner service"

  docker exec "$remote_cli_container" /usr/bin/git -C "$REMOTE_CLI_WORKTREE_DIR" config user.name "Thor E2E Bot" >/dev/null 2>&1 || true
  docker exec "$remote_cli_container" /usr/bin/git -C "$REMOTE_CLI_WORKTREE_DIR" config user.email "thor-e2e-bot@example.com" >/dev/null 2>&1 || true

  if [[ -n "$ATTRIBUTION_SESSION_ID" ]]; then
    attribution_file="thor-e2e-attribution-${REMOTE_CLI_AUTH_TS}.txt"
    printf "attribution e2e %s\n" "$REMOTE_CLI_AUTH_TS" >"$HOST_REMOTE_CLI_WORKTREE_DIR/$attribution_file"
    export attribution_file REMOTE_CLI_WORKTREE_DIR

    add_payload=$(node -e "
      console.log(JSON.stringify({
        args: ['add', process.env.attribution_file],
        cwd: process.env.REMOTE_CLI_WORKTREE_DIR
      }));
    ")
    add_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
      -H 'Content-Type: application/json' \
      -d "$add_payload" \
      2>/dev/null || echo '{}')
    add_exit=$(json_field "$add_raw" "exitCode")
    assert '[[ "$add_exit" == "0" ]]' "attribution e2e: git add succeeds" "response: ${add_raw:0:300}"

    commit_message="e2e attribution commit ${REMOTE_CLI_AUTH_TS}"
    export commit_message
    commit_payload=$(node -e "
      console.log(JSON.stringify({
        args: ['commit', '-m', process.env.commit_message],
        cwd: process.env.REMOTE_CLI_WORKTREE_DIR
      }));
    ")
    commit_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/git" \
      -H 'Content-Type: application/json' \
      -H "x-thor-session-id: $ATTRIBUTION_SESSION_ID" \
      -d "$commit_payload" \
      2>/dev/null || echo '{}')
    commit_exit=$(json_field "$commit_raw" "exitCode")
    expected_trailer="Co-authored-by: ${ATTRIBUTION_E2E_NAME} <${THOR_E2E_JIRA_EMAIL}>"
    commit_body=$(docker exec "$remote_cli_container" /usr/bin/git -C "$REMOTE_CLI_WORKTREE_DIR" log -1 --format=%B 2>/dev/null || echo "")
    assert '[[ "$commit_exit" == "0" ]]' "attribution e2e: git commit succeeds" "response: ${commit_raw:0:300}"
    assert '[[ "$commit_body" == *"$expected_trailer"* ]]' \
      "attribution e2e: commit message includes co-author trailer" \
      "commit body: ${commit_body:0:500}"

    # gh pr create: the e2e GitHub App lacks PR write permission, so the
    # underlying gh call is expected to fail. We only verify that Thor's
    # /exec/gh handler injected --assignee <github> from the user config
    # before invoking gh, by inspecting the remote-cli exec_gh log line.
    gh_log_since=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    pr_title="Thor attribution e2e ${REMOTE_CLI_AUTH_TS}"
    pr_body="Thor attribution e2e marker ${REMOTE_CLI_AUTH_TS}"
    export pr_title pr_body
    pr_create_payload=$(node -e "
      console.log(JSON.stringify({
        args: ['pr', 'create', '--title', process.env.pr_title, '--body', process.env.pr_body],
        cwd: process.env.REMOTE_CLI_WORKTREE_DIR
      }));
    ")
    pr_create_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/gh" \
      -H 'Content-Type: application/json' \
      -H "x-thor-session-id: $ATTRIBUTION_SESSION_ID" \
      -d "$pr_create_payload" \
      2>/dev/null || echo '{}')
    pr_create_exit=$(json_field "$pr_create_raw" "exitCode")
    gh_logs=$(docker logs --since "$gh_log_since" "$remote_cli_container" 2>&1 || true)
    assert '[[ "$pr_create_exit" != "0" ]]' \
      "attribution e2e: gh pr create fails (GitHub App lacks write permission)" \
      "exitCode='$pr_create_exit' response: ${pr_create_raw:0:500}"
    assert '[[ "$gh_logs" == *"\"surface\":\"gh-assignee\",\"outcome\":\"applied\""* ]]' \
      "attribution e2e: gh pr create attribution was applied" \
      "logs: ${gh_logs:0:1000}"
    assert '[[ "$gh_logs" == *"\"event\":\"exec_gh\""*"\"--assignee\""*"\"${ATTRIBUTION_E2E_GITHUB}\""* ]]' \
      "attribution e2e: gh pr create invocation includes --assignee with the configured github login" \
      "expected --assignee ${ATTRIBUTION_E2E_GITHUB} in exec_gh args; logs: ${gh_logs:0:1500}"

    # gh issue create: use a unique missing label so the underlying gh call is
    # expected to fail before creating an issue, while still proving Thor
    # injected --assignee <github> and preserved disclaimer body rewriting.
    issue_log_since=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    issue_title="Thor issue attribution e2e ${REMOTE_CLI_AUTH_TS}"
    issue_body="Thor issue attribution e2e marker ${REMOTE_CLI_AUTH_TS}"
    issue_missing_label="thor-e2e-missing-label-${REMOTE_CLI_AUTH_TS}"
    export issue_title issue_body issue_missing_label
    issue_create_payload=$(node -e "
      console.log(JSON.stringify({
        args: [
          'issue',
          'create',
          '--title',
          process.env.issue_title,
          '--body',
          process.env.issue_body,
          '--label',
          process.env.issue_missing_label
        ],
        cwd: process.env.REMOTE_CLI_WORKTREE_DIR
      }));
    ")
    issue_create_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/gh" \
      -H 'Content-Type: application/json' \
      -H "x-thor-session-id: $ATTRIBUTION_SESSION_ID" \
      -d "$issue_create_payload" \
      2>/dev/null || echo '{}')
    issue_create_exit=$(json_field "$issue_create_raw" "exitCode")
    issue_logs=$(docker logs --since "$issue_log_since" "$remote_cli_container" 2>&1 || true)
    assert '[[ "$issue_create_exit" != "0" ]]' \
      "attribution e2e: gh issue create fails before creating an issue" \
      "exitCode='$issue_create_exit' response: ${issue_create_raw:0:500}"
    assert '[[ "$issue_logs" == *"\"surface\":\"gh-assignee\",\"outcome\":\"applied\""* ]]' \
      "attribution e2e: gh issue create attribution was applied" \
      "logs: ${issue_logs:0:1000}"
    assert '[[ "$issue_logs" == *"\"event\":\"exec_gh\""*"\"issue\""*"\"create\""*"\"--assignee\""*"\"${ATTRIBUTION_E2E_GITHUB}\""* ]]' \
      "attribution e2e: gh issue create invocation includes --assignee with the configured github login" \
      "expected --assignee ${ATTRIBUTION_E2E_GITHUB} in issue create exec_gh args; logs: ${issue_logs:0:1500}"
    assert '[[ "$issue_logs" == *"\"event\":\"exec_gh\""*"$issue_body"*"View Thor context"* ]]' \
      "attribution e2e: gh issue create invocation keeps the traced body footer" \
      "expected original body marker and Thor context footer in exec_gh args; logs: ${issue_logs:0:1500}"
  fi
fi

# ── 6. Approval Flow ────────────────────────────────────────────────────────

echo ""
echo "=== Approval Flow ==="

# 4a. Discover an approval-required tool from a connected upstream.
# Per-repo proxy ACLs are gone — every repo under /workspace/repos can use every
# connected upstream. We just need (a) a connected upstream that has an
# approval-required tool in our test map and (b) any repo that exists on disk.
APPROVAL_UPSTREAM=""
APPROVAL_TOOL=""
APPROVAL_DIR=""
APPROVAL_DISCOVERY_DEBUG=""
approval_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')

if [[ "$approval_health" != *'"status":"ok"'* ]]; then
  APPROVAL_DISCOVERY_DEBUG="remote-cli health unavailable at $REMOTE_CLI_URL"
else
  connected_upstreams=$(node -e "
    const health = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const [name, info] of Object.entries(health.mcp?.instances || {})) {
      if (info && info.connected) console.log(name);
    }
  " <<<"$approval_health" 2>/dev/null || echo "")

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
  assert 'false' "approval flow: discovered an approval-required tool" "${APPROVAL_DISCOVERY_DEBUG:-approval tool discovery returned no match}"
elif [[ -z "$THOR_INTERNAL_SECRET" ]]; then
  assert 'false' "approval flow: THOR_INTERNAL_SECRET is available" "Set THOR_INTERNAL_SECRET or ensure docker exec thor-gateway-1 printenv THOR_INTERNAL_SECRET returns a value"
else
  echo "  Found approval-required tool: $APPROVAL_UPSTREAM/$APPROVAL_TOOL (via $APPROVAL_DIR)"

  APPROVAL_THREAD_TS=""
  if [[ -n "$SLACK_BOT_TOKEN" && -n "$SLACK_CHANNEL_ID" ]]; then
    approval_seed_json=$(node -e "
      console.log(JSON.stringify({
        channel: process.env.SLACK_CHANNEL_ID,
        text: 'Thor approval e2e seed ' + process.env.REMOTE_CLI_AUTH_TS
      }));
    ")
    approval_seed_raw=$(slack_post_json "chat.postMessage" "$approval_seed_json")
    approval_seed_ok=$(json_field "$approval_seed_raw" "ok")
    APPROVAL_THREAD_TS=$(json_field "$approval_seed_raw" "ts")
    assert '[[ "$approval_seed_ok" == "true" && -n "$APPROVAL_THREAD_TS" ]]' \
      "approval flow: seeded Slack thread" \
      "response: ${approval_seed_raw:0:500}"
    export APPROVAL_THREAD_TS
  else
    assert 'false' "approval flow: seeded Slack thread" "Set SLACK_BOT_TOKEN and SLACK_E2E_CHANNEL_ID/SLACK_CHANNEL_ID for direct approval-card delivery e2e"
  fi

  jira_assignee_live=false
  if [[ -n "$JIRA_CLOUD_ID" && "$THOR_E2E_JIRA_EMAIL" != "$DEFAULT_THOR_E2E_JIRA_EMAIL" ]]; then
    assert '[[ "$APPROVAL_UPSTREAM/$APPROVAL_TOOL" == "atlassian/createJiraIssue" ]]' \
      "jira attribution e2e: discovered Atlassian createJiraIssue" \
      "discovered '$APPROVAL_UPSTREAM/$APPROVAL_TOOL'; check ATLASSIAN_AUTH and MCP health"
    assert '[[ -n "${ATLASSIAN_AUTH:-}" ]]' \
      "jira attribution e2e: ATLASSIAN_AUTH is available" \
      "set ATLASSIAN_AUTH so Jira lookup and create calls can reach Atlassian"
    if [[ "$APPROVAL_UPSTREAM/$APPROVAL_TOOL" == "atlassian/createJiraIssue" && -n "${ATLASSIAN_AUTH:-}" ]]; then
      jira_assignee_live=true
    fi
  elif [[ -n "$JIRA_CLOUD_ID" ]]; then
    echo "  Skipping Jira assignee e2e: THOR_E2E_JIRA_EMAIL is the default placeholder"
  fi

  trigger_context_body=$(node -e "
    console.log(JSON.stringify({
      correlationKey: 'slack:thread:' + process.env.SLACK_CHANNEL_ID + '/' + process.env.APPROVAL_THREAD_TS,
      triggerSlackId: process.env.ATTRIBUTION_E2E_SLACK_ID
    }));
  ")
  trigger_context_raw=$(curl -sf -X POST "$RUNNER_URL/internal/e2e/trigger-context" \
    -H 'Content-Type: application/json' \
    -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
    -d "$trigger_context_body" \
    2>/dev/null || echo '{}')
  E2E_THOR_SESSION_ID=$(json_field "$trigger_context_raw" "sessionId")
  E2E_THOR_TRIGGER_ID=$(json_field "$trigger_context_raw" "triggerId")
  assert '[[ -n "$E2E_THOR_SESSION_ID" && -n "$E2E_THOR_TRIGGER_ID" ]]' \
    "runner: created e2e trigger context" \
    "response: ${trigger_context_raw:0:300}; set THOR_E2E_TEST_HELPERS=1 for the runner service"

  # 4b. remote-cli-level: call the approval-required tool directly
  echo "  Calling tool via remote-cli (expecting approval interception)..."
  if [[ "$jira_assignee_live" == "true" ]]; then
    JIRA_E2E_SUMMARY="Thor Jira assignee e2e ${REMOTE_CLI_AUTH_TS}"
    jira_e2e_description="Jira assignee attribution e2e. Marker: ${REMOTE_CLI_AUTH_TS}"
    export JIRA_E2E_SUMMARY jira_e2e_description
    approval_args_json=$(node -e "
      console.log(JSON.stringify({
        cloudId: process.env.JIRA_CLOUD_ID,
        projectKey: 'THORE2E',
        issueTypeName: 'ThorE2EFakeIssueType',
        summary: process.env.JIRA_E2E_SUMMARY,
        description: process.env.jira_e2e_description
      }));
    ")
  else
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
  fi
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

    if [[ "$jira_assignee_live" == "true" ]]; then
      # 4d. Approve a Jira issue creation with a fake project key. The upstream
      # create should fail, but only after Thor has performed lookup and sent
      # the create payload with assignee_account_id.
      echo "  Approving Jira approval $action_id..."
      jira_log_since=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      resolve_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
        -H 'Content-Type: application/json' \
        -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
        -d "{\"args\":[\"resolve\",\"$action_id\",\"approved\",\"e2e-test\",\"e2e test - automated Jira assignee verification\"]}" \
        2>/dev/null || echo '{}')
      resolve_exit=$(json_field "$resolve_raw" "exitCode")
      resolve_stdout=$(json_field "$resolve_raw" "stdout")
      resolve_stderr=$(json_field "$resolve_raw" "stderr")
      jira_logs=$(docker logs --since "$jira_log_since" "$remote_cli_container" 2>&1 || true)
      assert '[[ "$jira_logs" == *"\"surface\":\"jira\",\"outcome\":\"applied\""* ]]' \
        "jira attribution e2e: Jira attribution was applied" \
        "logs: ${jira_logs:0:1000}"

      jira_lookup_entry=$(find_jira_tool_worklog_entry "lookupJiraAccountId" 2>/dev/null || echo "")
      jira_create_entry=$(find_jira_tool_worklog_entry "createJiraIssue" 2>/dev/null || echo "")
      jira_injected_account_id=$(json_field "$jira_create_entry" "args.assignee_account_id")
      jira_create_project_key=$(json_field "$jira_create_entry" "args.projectKey")
      jira_create_error=$(json_field "$jira_create_entry" "error")
      jira_create_is_error=$(json_field "$jira_create_entry" "result.isError")
      assert '[[ -n "$jira_lookup_entry" ]]' \
        "jira attribution e2e: lookupJiraAccountId ran for the configured user email" \
        "expected cloud='$JIRA_CLOUD_ID' email='$THOR_E2E_JIRA_EMAIL'"
      assert '[[ "$jira_create_project_key" == "THORE2E" ]]' \
        "jira attribution e2e: createJiraIssue used the fake project key" \
        "projectKey='$jira_create_project_key' expected='THORE2E'; worklog entry: ${jira_create_entry:0:800}"
      assert '[[ -n "$jira_injected_account_id" ]]' \
        "jira attribution e2e: createJiraIssue received an assignee_account_id" \
        "worklog entry: ${jira_create_entry:0:800}"
      assert '[[ "$jira_create_is_error" == "true" || -n "$jira_create_error" || -n "$resolve_stderr" || "$resolve_exit" != "0" ]]' \
        "jira attribution e2e: failed create call recorded an upstream error" \
        "isError='$jira_create_is_error' worklog error='$jira_create_error' stderr='${resolve_stderr:0:500}' response: ${resolve_raw:0:500}"

      issue_key=$(extract_jira_issue_key "$resolve_stdout $resolve_stderr $resolve_raw $jira_create_entry")
      if [[ -n "$issue_key" ]]; then
        JIRA_E2E_ISSUE_KEY="$issue_key"
      fi
      assert '[[ -z "$issue_key" ]]' \
        "jira attribution e2e: fake project key did not create a Jira issue" \
        "unexpected issue key='$issue_key'; cleanup will attempt deletion"
    else
      # 4d. Reject the approval (safe — no side effects on the upstream MCP)
      echo "  Rejecting approval $action_id..."
      resolve_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/mcp" \
        -H 'Content-Type: application/json' \
        -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
        -d "{\"args\":[\"resolve\",\"$action_id\",\"rejected\",\"e2e-test\",\"e2e test - automated rejection\"]}" \
        2>/dev/null || echo '{}')
      resolve_exit=$(json_field "$resolve_raw" "exitCode")
      assert '[[ "$resolve_exit" == "0" ]]' "remote-cli: approval rejection command succeeded" "exitCode='$resolve_exit'"
    fi

    # 4e. Verify final status confirms the approval decision.
    final_raw=$(curl -sf -X POST "$REMOTE_CLI_URL/exec/approval" \
      -H 'Content-Type: application/json' \
      -d "{\"args\":[\"status\",\"$action_id\"]}" \
      2>/dev/null || echo '{}')
    final_status=$(exec_stdout_field "$final_raw" "status")
    expected_final_status=$([[ "$jira_assignee_live" == "true" ]] && echo "approved" || echo "rejected")
    assert '[[ "$final_status" == "$expected_final_status" ]]' \
      "remote-cli: final status confirms '$expected_final_status'" \
      "status='$final_status'"
  fi

fi

# ── 7. Git/GH policy enforcement ─────────────────────────────────────────────
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

# 8. slack-upload should complete a real Slack external upload flow
echo ""
echo "=== Slack upload wrapper ==="

if [[ -z "$SLACK_BOT_TOKEN" || -z "$SLACK_CHANNEL_ID" || -z "$opencode_container" ]]; then
  echo "  ⚠ skipping Slack upload e2e (requires SLACK_BOT_TOKEN, SLACK_E2E_CHANNEL_ID/SLACK_CHANNEL_ID, and opencode container)"
else
  slack_upload_run_id="slack-upload-e2e-${REMOTE_CLI_AUTH_TS}"
  slack_upload_title="slack-upload e2e ${slack_upload_run_id}.txt"
  slack_upload_comment="slack-upload e2e comment ${slack_upload_run_id}"
  slack_upload_body="slack-upload e2e body ${slack_upload_run_id}"
  export SLACK_CHANNEL_ID slack_upload_run_id

  seed_json=$(node -e "
    console.log(JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID,
      text: '*slack-upload e2e seed* ' + process.env.slack_upload_run_id
    }));
  ")
  seed_raw=$(slack_post_json "chat.postMessage" "$seed_json")
  seed_ok=$(json_field "$seed_raw" "ok")
  seed_ts=$(json_field "$seed_raw" "ts")
  assert '[[ "$seed_ok" == "true" && -n "$seed_ts" ]]' "seeded Slack thread for slack-upload e2e" "response: ${seed_raw:0:500}"

  if [[ "$seed_ok" == "true" && -n "$seed_ts" ]]; then
    slack_upload_raw=$(docker exec \
      -e FILE_CONTENT="$slack_upload_body" \
      -e FILE_TITLE="$slack_upload_title" \
      -e CHANNEL_ID="$SLACK_CHANNEL_ID" \
      -e THREAD_TS="$seed_ts" \
      -e INITIAL_COMMENT="$slack_upload_comment" \
      "$opencode_container" \
      sh -lc 'printf "%s\n" "$FILE_CONTENT" > /tmp/slack-upload-e2e.txt && slack-upload /tmp/slack-upload-e2e.txt --title "$FILE_TITLE" --channel "$CHANNEL_ID" --thread-ts "$THREAD_TS" --comment "$INITIAL_COMMENT"' 2>&1 || true)
    assert '[[ "$slack_upload_raw" == "{\"ok\":true}" ]]' "slack-upload returns minimal success payload" "output: ${slack_upload_raw:0:500}"

    upload_reply_json=""
    upload_file_id=""
    upload_file_title=""
    replies='{}'
    for _ in $(seq 1 24); do
      replies=$(slack_replies "$SLACK_CHANNEL_ID" "$seed_ts" 2>/dev/null || echo '{}')
      upload_reply_json=$(echo "$replies" | EXPECT_COMMENT="$slack_upload_comment" EXPECT_TITLE="$slack_upload_title" node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const messages = d.messages || [];
        const match = [...messages].reverse().find((message) => {
          const files = Array.isArray(message.files) ? message.files : [];
          return (message.text || '').includes(process.env.EXPECT_COMMENT) &&
            files.some((file) => file.title === process.env.EXPECT_TITLE);
        });
        if (!match) process.exit(1);
        const file = (match.files || []).find((candidate) => candidate.title === process.env.EXPECT_TITLE);
        console.log(JSON.stringify({ ts: match.ts || '', fileId: file?.id || '', title: file?.title || '' }));
      " 2>/dev/null || echo "")
      upload_file_id=$(json_field "$upload_reply_json" "fileId")
      upload_file_title=$(json_field "$upload_reply_json" "title")
      if [[ -n "$upload_file_id" ]]; then
        break
      fi
      sleep 5
    done

    assert '[[ -n "$upload_file_id" ]]' "Slack thread shows uploaded file reply" "replies: ${replies:0:1000}"
    assert '[[ "$upload_file_title" == "$slack_upload_title" ]]' "uploaded file keeps requested title" "reply: ${upload_reply_json:0:300}"

    if [[ -n "$upload_file_id" ]]; then
      file_info_raw=$(slack_file_info "$upload_file_id" 2>/dev/null || echo '{}')
      file_info_ok=$(json_field "$file_info_raw" "ok")
      file_info_title=$(json_field "$file_info_raw" "file.title")
      assert '[[ "$file_info_ok" == "true" ]]' "files.info returns uploaded Slack file" "response: ${file_info_raw:0:500}"
      assert '[[ "$file_info_title" == "$slack_upload_title" ]]' "files.info matches uploaded title" "response: ${file_info_raw:0:500}"
    fi
  fi
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
