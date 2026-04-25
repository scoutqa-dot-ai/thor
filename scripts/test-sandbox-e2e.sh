#!/usr/bin/env bash
#
# Sandbox e2e tests for Thor (extracted from test-e2e.sh).
#
# Tests the full sandbox lifecycle via direct remote-cli calls (no LLM):
#   bundle sync, dirty overlay, pull-back, toolchain, version switching,
#   quoting, subdir cwd, auto-recreate, two-worktree isolation, parallel exec.
#
# Prerequisites:
#   - docker compose stack running (remote-cli container healthy)
#   - DAYTONA_SNAPSHOT set in remote-cli
#
# Usage:
#   ./scripts/test-sandbox-e2e.sh
#   REMOTE_CLI_URL=http://localhost:3004 ./scripts/test-sandbox-e2e.sh
#
set -euo pipefail

REMOTE_CLI_URL="${REMOTE_CLI_URL:-http://localhost:3004}"
HOST_WORKSPACE="${HOST_WORKSPACE:-./docker-volumes/workspace}"
REMOTE_CLI_GIT_REPO_URL="${REMOTE_CLI_GIT_REPO_URL:-https://github.com/scoutqa-dot-ai/thor}"
REMOTE_CLI_GIT_REPO_NAME="${REMOTE_CLI_GIT_REPO_NAME:-scoutqa-dot-ai-thor-sandbox-e2e}"
REMOTE_CLI_GIT_REPO_DIR="${REMOTE_CLI_GIT_REPO_DIR:-/workspace/repos/${REMOTE_CLI_GIT_REPO_NAME}}"
HOST_REMOTE_CLI_GIT_REPO_DIR="${HOST_REMOTE_CLI_GIT_REPO_DIR:-${HOST_WORKSPACE}/repos/${REMOTE_CLI_GIT_REPO_NAME}}"

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

json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const v = d[\"$field\"];
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

# ── Prerequisites ──────────────────────────────────────────────────────────

echo ""
echo "=== Prerequisites ==="

remote_cli_container=$(resolve_remote_cli_container)
remote_cli_health=$(curl -sf "$REMOTE_CLI_URL/health" 2>/dev/null || echo '{}')

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

if [[ -n "$remote_cli_container" ]]; then
  DAYTONA_SNAPSHOT=$(docker exec "$remote_cli_container" printenv DAYTONA_SNAPSHOT 2>/dev/null || true)
  if [[ -n "$DAYTONA_SNAPSHOT" ]]; then
    echo "  ✓ DAYTONA_SNAPSHOT: $DAYTONA_SNAPSHOT"
  else
    echo "  ✗ DAYTONA_SNAPSHOT is not set in remote-cli (sandbox tests will fail)"
    preflight_ok=false
  fi
fi

if [[ "$preflight_ok" != "true" ]]; then
  echo ""
  echo "FAIL — prerequisites not met"
  exit 1
fi

# ── Clone target repo (needed for sandbox worktree operations) ─────────────

echo ""
echo "=== Clone target repo ==="

[[ -n "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"
mkdir -p "$(dirname "$HOST_REMOTE_CLI_GIT_REPO_DIR")"

echo "  Cloning $REMOTE_CLI_GIT_REPO_URL inside $remote_cli_container..."
clone_output=$(docker exec "$remote_cli_container" \
  git clone "$REMOTE_CLI_GIT_REPO_URL" "$REMOTE_CLI_GIT_REPO_DIR" 2>&1 || true)

assert '[[ -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]' \
  "docker exec in remote-cli cloned the GitHub repo" \
  "output: ${clone_output:0:300}"

if [[ ! -d "$HOST_REMOTE_CLI_GIT_REPO_DIR/.git" ]]; then
  echo ""
  echo "FAIL — clone failed, cannot continue"
  exit 1
fi

# ── Sandbox lifecycle + git bundle sync ──────────────────────────────────────
#
# Tests the full sandbox lifecycle via direct remote-cli calls (no LLM):
#   1. List → empty
#   2. Create worktree at old commit, exec → initial bundle sync
#   3. Verify sandbox has correct SHA
#   4. Fast-forward worktree to recent commit, exec → delta bundle sync
#   5. Verify sandbox updated to new SHA
#   6. Reset worktree backward to old commit, exec → backward sync (no bundle)
#   7. Verify sandbox reverted to old SHA
#   8. Stop → cleanup
#   9. List → empty again

echo ""
echo "=== Sandbox Lifecycle + Git Bundle Sync ==="

# Parse NDJSON sandbox exec response: extract stdout data and exitCode
sandbox_exec_stdout() {
  node -e "
    const lines = require('fs').readFileSync(0,'utf8').trim().split('\n');
    let out = '';
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'stdout' && typeof d.data === 'string') out += d.data;
      } catch {}
    }
    process.stdout.write(out);
  " 2>/dev/null
}

sandbox_exec_exit() {
  node -e "
    const lines = require('fs').readFileSync(0,'utf8').trim().split('\n');
    let code = '';
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (typeof d.exitCode === 'number') code = String(d.exitCode);
      } catch {}
    }
    console.log(code);
  " 2>/dev/null
}

SBX_REPO_DIR="$REMOTE_CLI_GIT_REPO_DIR"
SBX_HOST_REPO_DIR="$HOST_REMOTE_CLI_GIT_REPO_DIR"

# Pick an old commit (first commit) and a recent one.
SBX_OLD_SHA=$(docker exec "$remote_cli_container" \
  git -C "$SBX_REPO_DIR" rev-list --reverse HEAD 2>/dev/null | head -1) || true
SBX_NEW_SHA=$(docker exec "$remote_cli_container" \
  git -C "$SBX_REPO_DIR" rev-parse HEAD 2>/dev/null) || true

SBX_TS=$(date +%s)
SBX_BRANCH="e2e-sandbox-${SBX_TS}"
SBX_WORKTREE_DIR="/workspace/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${SBX_BRANCH}"
SBX_HOST_WORKTREE_DIR="${HOST_WORKSPACE}/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${SBX_BRANCH}"

if [[ -z "$SBX_OLD_SHA" || -z "$SBX_NEW_SHA" ]]; then
  echo "  ⚠ Prerequisites missing (clone may have failed) — skipping sandbox tests"
elif [[ "$SBX_OLD_SHA" == "$SBX_NEW_SHA" ]]; then
  echo "  ⚠ Repo has only one commit — skipping sandbox tests"
else
  # 8a. List sandboxes — should be empty (or at least none for our worktree)
  sbx_list_before=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
    -H 'Content-Type: application/json' \
    -d '{"mode":"list"}' 2>/dev/null)
  sbx_list_before_exit=$(json_field "$sbx_list_before" "exitCode")
  assert '[[ "$sbx_list_before_exit" == "0" ]]' "sandbox list succeeds" "exitCode='$sbx_list_before_exit'"

  # 8b. Create worktree at old commit
  mkdir -p "$(dirname "$SBX_HOST_WORKTREE_DIR")"
  docker exec "$remote_cli_container" \
    git -C "$SBX_REPO_DIR" worktree add -b "$SBX_BRANCH" "$SBX_WORKTREE_DIR" "$SBX_OLD_SHA" 2>/dev/null
  worktree_created=$?

  if [[ $worktree_created -ne 0 ]]; then
    assert 'false' "sandbox worktree created at old commit" "git worktree add failed"
  else
    assert 'true' "sandbox worktree created at old commit ($SBX_OLD_SHA)" ""

    # Verify local HEAD matches old SHA
    local_sha=$(docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" rev-parse HEAD 2>/dev/null)
    assert '[[ "$local_sha" == "$SBX_OLD_SHA" ]]' \
      "worktree HEAD is old commit" \
      "expected='${SBX_OLD_SHA:0:12}', got='${local_sha:0:12}'"

    # 8c. Exec in sandbox — initial bundle sync, verify SHA inside sandbox
    echo "  Creating sandbox and verifying initial bundle sync..."
    sbx_exec1_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"cat\",\".git/HEAD\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_exec1_exit=$(echo "$sbx_exec1_raw" | sandbox_exec_exit)
    sbx_exec1_sha=$(echo "$sbx_exec1_raw" | sandbox_exec_stdout | tr -d '[:space:]')

    assert '[[ "$sbx_exec1_exit" == "0" ]]' "sandbox exec (initial sync) succeeded" "exitCode='$sbx_exec1_exit'"
    assert '[[ "$sbx_exec1_sha" == "$SBX_OLD_SHA" ]]' \
      "sandbox has correct SHA after initial bundle" \
      "expected='${SBX_OLD_SHA:0:12}', got='${sbx_exec1_sha:0:12}'"

    # 8d. List sandboxes — should show our sandbox
    sbx_list_mid=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d '{"mode":"list"}' 2>/dev/null)
    sbx_list_mid_has_cwd=$(echo "$sbx_list_mid" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const list = JSON.parse(d.stdout || '[]');
      console.log(list.some(s => s.cwd === '$SBX_WORKTREE_DIR') ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
    assert '[[ "$sbx_list_mid_has_cwd" == "yes" ]]' \
      "sandbox list includes our worktree" \
      "cwd=$SBX_WORKTREE_DIR"

    # 8e. Fast-forward worktree to recent commit
    echo "  Fast-forwarding worktree to recent commit for delta sync..."
    docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" reset --hard "$SBX_NEW_SHA" 2>/dev/null >/dev/null
    updated_sha=$(docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" rev-parse HEAD 2>/dev/null)
    assert '[[ "$updated_sha" == "$SBX_NEW_SHA" ]]' \
      "worktree fast-forwarded to recent commit" \
      "expected='${SBX_NEW_SHA:0:12}', got='${updated_sha:0:12}'"

    # 8f. Exec again — delta bundle sync, verify new SHA in sandbox
    echo "  Verifying delta bundle sync..."
    sbx_exec2_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"cat\",\".git/HEAD\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_exec2_exit=$(echo "$sbx_exec2_raw" | sandbox_exec_exit)
    sbx_exec2_sha=$(echo "$sbx_exec2_raw" | sandbox_exec_stdout | tr -d '[:space:]')

    assert '[[ "$sbx_exec2_exit" == "0" ]]' "sandbox exec (delta sync) succeeded" "exitCode='$sbx_exec2_exit'"
    assert '[[ "$sbx_exec2_sha" == "$SBX_NEW_SHA" ]]' \
      "sandbox has correct SHA after delta bundle" \
      "expected='${SBX_NEW_SHA:0:12}', got='${sbx_exec2_sha:0:12}'"

    # 8i. Switch worktree to an unrelated orphan branch, verify sandbox syncs
    # (also covers backward/fallback bundle path since orphan is unrelated to HEAD)
    echo "  Creating orphan branch and switching worktree..."
    docker exec "$remote_cli_container" sh -c "
      cd $SBX_WORKTREE_DIR &&
      git checkout --orphan e2e-orphan-${SBX_TS} &&
      git rm -rf . >/dev/null 2>&1 &&
      echo 'orphan-content' > orphan.txt &&
      git add orphan.txt &&
      git commit -m 'orphan commit' --allow-empty
    " 2>/dev/null >/dev/null
    orphan_sha=$(docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" rev-parse HEAD 2>/dev/null)
    assert '[[ -n "$orphan_sha" && "$orphan_sha" != "$SBX_OLD_SHA" && "$orphan_sha" != "$SBX_NEW_SHA" ]]' \
      "worktree switched to unrelated orphan branch" \
      "orphan_sha='${orphan_sha:0:12}'"

    echo "  Verifying unrelated branch sync..."
    sbx_exec4_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"cat\",\".git/HEAD\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_exec4_exit=$(echo "$sbx_exec4_raw" | sandbox_exec_exit)
    sbx_exec4_sha=$(echo "$sbx_exec4_raw" | sandbox_exec_stdout | tr -d '[:space:]')

    assert '[[ "$sbx_exec4_exit" == "0" ]]' "sandbox exec (unrelated branch sync) succeeded" "exitCode='$sbx_exec4_exit'"
    assert '[[ "$sbx_exec4_sha" == "$orphan_sha" ]]' \
      "sandbox has correct SHA after unrelated branch sync" \
      "expected='${orphan_sha:0:12}', got='${sbx_exec4_sha:0:12}'"

    # 8j. Stop sandbox
    echo "  Cleaning up sandbox..."
    sbx_stop_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR\"}" 2>/dev/null)
    sbx_stop_exit=$(json_field "$sbx_stop_raw" "exitCode")
    assert '[[ "$sbx_stop_exit" == "0" ]]' "sandbox stop succeeded" "exitCode='$sbx_stop_exit'"

    # 8k. List sandboxes — ours should be gone (retry for Daytona API eventual consistency)
    sbx_list_after_has_cwd="yes"
    for _sbx_retry in 1 2 3; do
      sbx_list_after=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d '{"mode":"list"}' 2>/dev/null)
      sbx_list_after_has_cwd=$(echo "$sbx_list_after" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
        const list = JSON.parse(d.stdout || '[]');
        console.log(list.some(s => s.cwd === '$SBX_WORKTREE_DIR') ? 'yes' : 'no');
      " 2>/dev/null || echo "yes")
      [[ "$sbx_list_after_has_cwd" == "no" ]] && break
      sleep 2
    done
    assert '[[ "$sbx_list_after_has_cwd" == "no" ]]' \
      "sandbox removed after stop" \
      "still found in list"

    # 8l. Dirty worktree overlay from subdirectory cwd
    # Uses subdirectory cwd to verify overlay push resolves the worktree root correctly.
    echo "  Testing dirty worktree overlay (subdirectory cwd)..."
    docker exec "$remote_cli_container" sh -c \
      "mkdir -p $SBX_WORKTREE_DIR/sub/pkg && echo 'dirty-content-e2e' > $SBX_WORKTREE_DIR/sub/pkg/dirty-file.txt" 2>/dev/null
    sbx_dirty_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"cat\",\"dirty-file.txt\"],\"cwd\":\"$SBX_WORKTREE_DIR/sub/pkg\"}" \
      2>/dev/null)
    sbx_dirty_exit=$(echo "$sbx_dirty_raw" | sandbox_exec_exit)
    sbx_dirty_stdout=$(echo "$sbx_dirty_raw" | sandbox_exec_stdout)
    assert '[[ "$sbx_dirty_exit" == "0" ]]' "dirty worktree exec succeeded (overlay, subdir cwd)" "exitCode='$sbx_dirty_exit'"
    assert '[[ "$sbx_dirty_stdout" == *"dirty-content-e2e"* ]]' \
      "sandbox received uncommitted file content via subdir cwd" \
      "stdout='${sbx_dirty_stdout:0:200}'"
    # Verify local worktree is untouched (no git history manipulation)
    dirty_file_exists=$(docker exec "$remote_cli_container" \
      test -f "$SBX_WORKTREE_DIR/sub/pkg/dirty-file.txt" && echo "yes" || echo "no")
    assert '[[ "$dirty_file_exists" == "yes" ]]' \
      "local dirty file preserved after overlay" \
      "file exists: $dirty_file_exists"
    # Verify git history is untouched (no temp commits)
    local_head_msg=$(docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" log -1 --format=%s 2>/dev/null)
    assert '[[ "$local_head_msg" != "thor-sandbox-wip" ]]' \
      "no temp commit in local history" \
      "HEAD message: '$local_head_msg'"
    # Clean up dirty file
    docker exec "$remote_cli_container" \
      rm -rf "$SBX_WORKTREE_DIR/sub" 2>/dev/null

    # 8l-2. Pull sandbox changes back to local worktree (subdirectory cwd)
    # Uses subdirectory cwd to verify pull resolves the worktree root correctly.
    echo "  Testing pull sandbox changes (subdirectory cwd)..."
    # First, create the subdirectory in the sandbox so the cd prefix succeeds
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"mkdir\",\"-p\",\"pulltest\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null >/dev/null
    # Run from a subdirectory — creates a file relative to the subdir cwd
    sbx_pull_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"bash\",\"-c\",\"echo pull-content-e2e > created.txt\"],\"cwd\":\"$SBX_WORKTREE_DIR/pulltest\"}" \
      2>/dev/null)
    sbx_pull_exit=$(echo "$sbx_pull_raw" | sandbox_exec_exit)
    assert '[[ "$sbx_pull_exit" == "0" ]]' "sandbox create-file command succeeded (subdir cwd)" "exitCode='$sbx_pull_exit'"
    # Verify the file was pulled to the worktree root (under pulltest/, not doubled)
    pull_content=$(docker exec "$remote_cli_container" \
      cat "$SBX_WORKTREE_DIR/pulltest/created.txt" 2>/dev/null || echo "")
    assert '[[ "$pull_content" == *"pull-content-e2e"* ]]' \
      "file created in subdir cwd pulled to correct worktree path" \
      "content='${pull_content:0:200}'"
    # Clean up pulled files
    docker exec "$remote_cli_container" \
      rm -rf "$SBX_WORKTREE_DIR/pulltest" 2>/dev/null

    # 8l-3. Realistic pull: mangle package.json, run prettier in sandbox, verify formatted result pulled back
    echo "  Testing realistic pull: format mangled package.json in sandbox..."
    # Switch worktree to latest commit (which has package.json with prettier)
    docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" checkout -B "$SBX_BRANCH" "$SBX_NEW_SHA" 2>/dev/null >/dev/null
    # Save original package.json content
    original_pkg=$(docker exec "$remote_cli_container" \
      cat "$SBX_WORKTREE_DIR/package.json" 2>/dev/null)
    # Mangle: add a new field with bad formatting (single-line JSON blob)
    # This ensures the formatted result differs from the committed version,
    # so git status inside the sandbox sees it as modified and pull brings it back.
    docker exec -w "$SBX_WORKTREE_DIR" "$remote_cli_container" \
      node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8"));p.e2eMarker="FORMATTED_E2E";require("fs").writeFileSync("package.json",JSON.stringify(p))' 2>/dev/null
    mangled_pkg=$(docker exec "$remote_cli_container" \
      cat "$SBX_WORKTREE_DIR/package.json" 2>/dev/null)
    mangled_lines=$(echo "$mangled_pkg" | wc -l | tr -d ' ')
    assert '[[ "$mangled_lines" == "1" ]]' \
      "package.json mangled to single line with e2eMarker" \
      "lines='$mangled_lines'"
    # Run prettier in sandbox (overlay pushes mangled file, exec formats, pull brings it back)
    sbx_fmt_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"npx -y prettier@3 --write package.json\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_fmt_exit=$(echo "$sbx_fmt_raw" | sandbox_exec_exit)
    assert '[[ "$sbx_fmt_exit" == "0" ]]' \
      "npx prettier succeeded in sandbox" \
      "exitCode='$sbx_fmt_exit'"
    # Verify the local package.json is now properly formatted (multi-line, not mangled)
    formatted_pkg=$(docker exec "$remote_cli_container" \
      cat "$SBX_WORKTREE_DIR/package.json" 2>/dev/null)
    formatted_lines=$(echo "$formatted_pkg" | wc -l | tr -d ' ')
    assert '[[ "$formatted_lines" -gt 5 ]]' \
      "formatted package.json pulled back (multi-line)" \
      "lines='$formatted_lines'"
    # Verify the e2eMarker survived the round-trip (proves it's not just the original)
    assert '[[ "$formatted_pkg" == *"FORMATTED_E2E"* ]]' \
      "formatted package.json contains e2eMarker (not just original)" \
      "content='${formatted_pkg:0:300}'"
    # Restore original package.json
    docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" checkout -- package.json 2>/dev/null

    # 8m. Failing command exit code propagation
    echo "  Testing failing command propagation..."
    # Reset worktree to a clean state (may be on orphan branch from previous test)
    docker exec "$remote_cli_container" \
      git -C "$SBX_WORKTREE_DIR" checkout -B "$SBX_BRANCH" "$SBX_OLD_SHA" 2>/dev/null >/dev/null
    sbx_fail_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"echo FAIL_OUTPUT && exit 42\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_fail_exit=$(echo "$sbx_fail_raw" | sandbox_exec_exit)
    sbx_fail_stdout=$(echo "$sbx_fail_raw" | sandbox_exec_stdout)
    assert '[[ "$sbx_fail_exit" == "42" ]]' \
      "failing command exit code propagates" \
      "exitCode='$sbx_fail_exit'"
    assert '[[ "$sbx_fail_stdout" == *"FAIL_OUTPUT"* ]]' \
      "failing command output arrives on stdout" \
      "stdout='${sbx_fail_stdout:0:200}'"

    # 8o. Toolchain: verify pre-installed runtimes are available via bash -lc
    echo "  Testing sandbox toolchain (Node, Java, Python, Maven, Gradle)..."
    sbx_tc_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"node --version && java --version 2>&1 | head -1 && python3 --version && mvn --version 2>&1 | head -1 && gradle --version 2>&1 | grep Gradle\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_tc_exit=$(echo "$sbx_tc_raw" | sandbox_exec_exit)
    sbx_tc_stdout=$(echo "$sbx_tc_raw" | sandbox_exec_stdout)
    assert '[[ "$sbx_tc_exit" == "0" ]]' "toolchain commands all succeeded" "exitCode='$sbx_tc_exit'"
    assert '[[ "$sbx_tc_stdout" == *"v22."* ]]' \
      "Node 22 available (default)" "stdout='${sbx_tc_stdout:0:300}'"
    assert '[[ "$sbx_tc_stdout" == *"21.0"* ]]' \
      "Java 21 available (default)" "stdout='${sbx_tc_stdout:0:300}'"
    assert '[[ "$sbx_tc_stdout" == *"3.12"* ]]' \
      "Python 3.12 available (default)" "stdout='${sbx_tc_stdout:0:300}'"
    assert '[[ "$sbx_tc_stdout" == *"Maven"* ]]' \
      "Maven available" "stdout='${sbx_tc_stdout:0:300}'"
    assert '[[ "$sbx_tc_stdout" == *"Gradle"* ]]' \
      "Gradle available" "stdout='${sbx_tc_stdout:0:300}'"

    # 8p. Version switching: set non-default version, verify it persists
    echo "  Testing version switching persistence across sandbox calls..."

    # Node: switch default to 20, verify next call uses it
    sbx_nvm_set=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"nvm\",\"alias\",\"default\",\"20\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_nvm_set_exit=$(echo "$sbx_nvm_set" | sandbox_exec_exit)
    assert '[[ "$sbx_nvm_set_exit" == "0" ]]' "nvm alias default 20 succeeded" "exitCode='$sbx_nvm_set_exit'"

    sbx_nvm_check=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"node\",\"--version\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_nvm_ver=$(echo "$sbx_nvm_check" | sandbox_exec_stdout | tr -d '[:space:]')
    assert '[[ "$sbx_nvm_ver" == v20.* ]]' \
      "Node version persisted to 20 across calls" \
      "got='$sbx_nvm_ver'"

    # Restore Node default to 22
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"nvm\",\"alias\",\"default\",\"22\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null >/dev/null

    # Java: switch default to 17, verify next call uses it
    sbx_sdk_set=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sdk\",\"default\",\"java\",\"17.0.18-tem\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_sdk_set_exit=$(echo "$sbx_sdk_set" | sandbox_exec_exit)
    assert '[[ "$sbx_sdk_set_exit" == "0" ]]' "sdk default java 17 succeeded" "exitCode='$sbx_sdk_set_exit'"

    sbx_sdk_check=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"java\",\"--version\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_sdk_ver=$(echo "$sbx_sdk_check" | sandbox_exec_stdout | head -1)
    assert '[[ "$sbx_sdk_ver" == *"17.0"* ]]' \
      "Java version persisted to 17 across calls" \
      "got='$sbx_sdk_ver'"

    # Restore Java default to 21
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sdk\",\"default\",\"java\",\"21.0.10-tem\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null >/dev/null

    # 8q. Args with spaces are preserved (shell quoting)
    echo "  Testing arg quoting preservation..."
    sbx_quote_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"touch\",\"hello world.txt\",\"foo.txt\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_quote_exit=$(echo "$sbx_quote_raw" | sandbox_exec_exit)
    assert '[[ "$sbx_quote_exit" == "0" ]]' "touch with spaced filename succeeded" "exitCode='$sbx_quote_exit'"
    # Count files: should be exactly 2 (not 3 from "hello" + "world.txt" + "foo.txt")
    sbx_count_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"ls -1 'hello world.txt' foo.txt 2>/dev/null | wc -l\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_file_count=$(echo "$sbx_count_raw" | sandbox_exec_stdout | tr -d '[:space:]')
    assert '[[ "$sbx_file_count" == "2" ]]' \
      "quoting preserved: 2 files created (not 3)" \
      "file_count='$sbx_file_count'"

    # 8r. Subdirectory cwd: command runs in correct subpath
    echo "  Testing subdirectory cwd resolution..."
    # Create a subdirectory with a marker file in the sandbox
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"bash\",\"-c\",\"mkdir -p sub/dir && echo MARKER > sub/dir/test.txt\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null >/dev/null

    # Execute from the subdirectory — should find the marker file
    sbx_subdir_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"cat\",\"test.txt\"],\"cwd\":\"$SBX_WORKTREE_DIR/sub/dir\"}" \
      2>/dev/null)
    sbx_subdir_exit=$(echo "$sbx_subdir_raw" | sandbox_exec_exit)
    sbx_subdir_stdout=$(echo "$sbx_subdir_raw" | sandbox_exec_stdout | tr -d '[:space:]')
    assert '[[ "$sbx_subdir_exit" == "0" ]]' \
      "subdirectory cwd: command succeeded" "exitCode='$sbx_subdir_exit'"
    assert '[[ "$sbx_subdir_stdout" == "MARKER" ]]' \
      "subdirectory cwd: ran in correct directory" "stdout='$sbx_subdir_stdout'"

    # Verify subdirectory reuses same sandbox (no new sandbox created)
    sbx_list_after_subdir=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d '{"mode":"list"}' 2>/dev/null)
    sbx_count_after_subdir=$(echo "$sbx_list_after_subdir" | node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const list = JSON.parse(d.stdout || '[]');
      const ours = list.filter(s => s.cwd === '$SBX_WORKTREE_DIR');
      console.log(ours.length);
    " 2>/dev/null || echo "0")
    assert '[[ "$sbx_count_after_subdir" == "1" ]]' \
      "subdirectory cwd: reused existing sandbox (no duplicate)" \
      "count='$sbx_count_after_subdir'"

    # 8s. Sandbox disappears between execs (auto-recreate)
    echo "  Testing auto-recreate after sandbox disappears..."
    # First, exec to ensure a sandbox exists
    sbx_pre_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"echo\",\"pre-disappear\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_pre_exit=$(echo "$sbx_pre_raw" | sandbox_exec_exit)
    assert '[[ "$sbx_pre_exit" == "0" ]]' "pre-disappear exec succeeded" "exitCode='$sbx_pre_exit'"
    # Stop the sandbox behind the scenes (simulates Daytona auto-stop)
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR\"}" 2>/dev/null >/dev/null
    sleep 2
    # Exec again — should auto-recreate
    sbx_recreate_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"exec\",\"args\":[\"echo\",\"post-recreate\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
      2>/dev/null)
    sbx_recreate_exit=$(echo "$sbx_recreate_raw" | sandbox_exec_exit)
    sbx_recreate_stdout=$(echo "$sbx_recreate_raw" | sandbox_exec_stdout)
    assert '[[ "$sbx_recreate_exit" == "0" ]]' \
      "auto-recreate after disappear succeeded" \
      "exitCode='$sbx_recreate_exit'"
    assert '[[ "$sbx_recreate_stdout" == *"post-recreate"* ]]' \
      "auto-recreated sandbox runs command correctly" \
      "stdout='${sbx_recreate_stdout:0:200}'"
    # Stop for cleanup
    curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR\"}" 2>/dev/null >/dev/null

    # 8t. Two worktrees, two sandboxes (label isolation)
    sleep 3  # allow Daytona to fully clean up previous sandbox
    echo "  Testing two-worktree sandbox isolation..."
    SBX_BRANCH2="e2e-sandbox2-${SBX_TS}"
    SBX_WORKTREE_DIR2="/workspace/worktrees/${REMOTE_CLI_GIT_REPO_NAME}/${SBX_BRANCH2}"
    docker exec "$remote_cli_container" \
      git -C "$SBX_REPO_DIR" worktree add -b "$SBX_BRANCH2" "$SBX_WORKTREE_DIR2" "$SBX_NEW_SHA" 2>/dev/null
    worktree2_created=$?

    if [[ $worktree2_created -eq 0 ]]; then
      # Exec on worktree 1 (old SHA)
      sbx_iso1_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d "{\"mode\":\"exec\",\"args\":[\"cat\",\".git/HEAD\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
        2>/dev/null)
      sbx_iso1_sha=$(echo "$sbx_iso1_raw" | sandbox_exec_stdout | tr -d '[:space:]')

      # Exec on worktree 2 (new SHA)
      sbx_iso2_raw=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d "{\"mode\":\"exec\",\"args\":[\"cat\",\".git/HEAD\"],\"cwd\":\"$SBX_WORKTREE_DIR2\"}" \
        2>/dev/null)
      sbx_iso2_sha=$(echo "$sbx_iso2_raw" | sandbox_exec_stdout | tr -d '[:space:]')

      assert '[[ "$sbx_iso1_sha" == "$SBX_OLD_SHA" ]]' \
        "worktree 1 sandbox has correct SHA" \
        "expected='${SBX_OLD_SHA:0:12}', got='${sbx_iso1_sha:0:12}'"
      assert '[[ "$sbx_iso2_sha" == "$SBX_NEW_SHA" ]]' \
        "worktree 2 sandbox has correct SHA (isolated)" \
        "expected='${SBX_NEW_SHA:0:12}', got='${sbx_iso2_sha:0:12}'"

      # Verify list shows both
      sbx_list_both=$(curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d '{"mode":"list"}' 2>/dev/null)
      sbx_list_both_count=$(echo "$sbx_list_both" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
        const list = JSON.parse(d.stdout || '[]');
        const ours = list.filter(s =>
          s.cwd === '$SBX_WORKTREE_DIR' || s.cwd === '$SBX_WORKTREE_DIR2'
        );
        console.log(ours.length);
      " 2>/dev/null || echo "0")
      assert '[[ "$sbx_list_both_count" == "2" ]]' \
        "list shows both sandboxes" \
        "count='$sbx_list_both_count'"

      # Stop both
      curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR\"}" 2>/dev/null >/dev/null
      curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
        -H 'Content-Type: application/json' \
        -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR2\"}" 2>/dev/null >/dev/null

      # Clean up worktree 2
      docker exec "$remote_cli_container" \
        git -C "$SBX_REPO_DIR" worktree remove --force "$SBX_WORKTREE_DIR2" 2>/dev/null || true
      docker exec "$remote_cli_container" \
        git -C "$SBX_REPO_DIR" branch -D "$SBX_BRANCH2" 2>/dev/null || true
    else
      assert 'false' "second worktree created for isolation test" "git worktree add failed"
    fi
  fi

  # 8u. Parallel exec on same worktree (cwd-level lock + concurrent streaming)
  echo "  Testing parallel sandbox exec on same worktree..."
  # Create a dirty file so both requests exercise the overlay path
  docker exec "$remote_cli_container" sh -c \
    "echo 'parallel-e2e' > $SBX_WORKTREE_DIR/parallel-test.txt" 2>/dev/null

  # Warm up the sandbox — two-worktree test above stopped it, and the
  # first parallel exec can race with the auto-recreate path (Daytona
  # returns "sandbox container not found" before the container boots).
  curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"exec\",\"args\":[\"true\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
    2>/dev/null >/dev/null

  # Fire two sandbox exec requests in parallel.
  # Each command prints a start timestamp, sleeps, then prints an end
  # timestamp. On the host side we verify the time ranges overlap —
  # proving both commands ran concurrently in the sandbox (the lock
  # serializes overlay sync, not the exec itself). Sleep is long enough
  # to absorb any Daytona exec-startup latency in CI so the ranges
  # actually overlap.
  sbx_par1_file=$(mktemp)
  sbx_par2_file=$(mktemp)
  curl -s --max-time 120 -X POST "$REMOTE_CLI_URL/exec/sandbox" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"echo START_A \$(date +%s); sleep 45; echo END_A \$(date +%s)\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
    2>/dev/null > "$sbx_par1_file" &
  par1_pid=$!
  curl -s --max-time 120 -X POST "$REMOTE_CLI_URL/exec/sandbox" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"exec\",\"args\":[\"sh\",\"-c\",\"echo START_B \$(date +%s); sleep 45; echo END_B \$(date +%s)\"],\"cwd\":\"$SBX_WORKTREE_DIR\"}" \
    2>/dev/null > "$sbx_par2_file" &
  par2_pid=$!
  wait "$par1_pid" "$par2_pid" 2>/dev/null

  sbx_par1_exit=$(cat "$sbx_par1_file" | sandbox_exec_exit)
  sbx_par1_stdout=$(cat "$sbx_par1_file" | sandbox_exec_stdout)
  sbx_par2_exit=$(cat "$sbx_par2_file" | sandbox_exec_exit)
  sbx_par2_stdout=$(cat "$sbx_par2_file" | sandbox_exec_stdout)
  rm -f "$sbx_par1_file" "$sbx_par2_file"

  assert '[[ "$sbx_par1_exit" == "0" ]]' "parallel exec #1 succeeded" "exitCode='$sbx_par1_exit'"
  assert '[[ "$sbx_par2_exit" == "0" ]]' "parallel exec #2 succeeded" "exitCode='$sbx_par2_exit'"
  assert '[[ "$sbx_par1_stdout" == *"START_A"* ]]' \
    "parallel exec #1 output correct" "stdout='${sbx_par1_stdout:0:200}'"
  assert '[[ "$sbx_par2_stdout" == *"START_B"* ]]' \
    "parallel exec #2 output correct" "stdout='${sbx_par2_stdout:0:200}'"

  # Verify time ranges overlap: A started before B ended, and B started before A ended.
  # This proves both commands were running concurrently in the sandbox.
  par_start_a=$(echo "$sbx_par1_stdout" | grep -o 'START_A [0-9]*' | awk '{print $2}')
  par_end_a=$(echo "$sbx_par1_stdout" | grep -o 'END_A [0-9]*' | awk '{print $2}')
  par_start_b=$(echo "$sbx_par2_stdout" | grep -o 'START_B [0-9]*' | awk '{print $2}')
  par_end_b=$(echo "$sbx_par2_stdout" | grep -o 'END_B [0-9]*' | awk '{print $2}')
  assert '[[ -n "$par_start_a" && -n "$par_end_a" && -n "$par_start_b" && -n "$par_end_b" ]]' \
    "parallel exec: all timestamps captured" \
    "start_a=$par_start_a end_a=$par_end_a start_b=$par_start_b end_b=$par_end_b"
  # Overlap: A starts before B ends AND B starts before A ends
  if [[ -n "$par_start_a" && -n "$par_end_a" && -n "$par_start_b" && -n "$par_end_b" ]]; then
    assert '[[ "$par_start_a" -le "$par_end_b" && "$par_start_b" -le "$par_end_a" ]]' \
      "parallel exec: time ranges overlap (commands ran concurrently)" \
      "A=[$par_start_a..$par_end_a] B=[$par_start_b..$par_end_b]"
  fi

  # Verify local worktree is clean (no git history manipulation)
  local_head_parallel=$(docker exec "$remote_cli_container" \
    git -C "$SBX_WORKTREE_DIR" log -1 --format=%s 2>/dev/null)
  assert '[[ "$local_head_parallel" != "thor-sandbox-wip" ]]' \
    "no temp commits in local history after parallel exec" \
    "HEAD message: '$local_head_parallel'"

  # Clean up dirty file and stop sandbox
  docker exec "$remote_cli_container" \
    rm -f "$SBX_WORKTREE_DIR/parallel-test.txt" 2>/dev/null
  curl -s -X POST "$REMOTE_CLI_URL/exec/sandbox" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"stop\",\"cwd\":\"$SBX_WORKTREE_DIR\"}" 2>/dev/null >/dev/null

  # Clean up worktree
  docker exec "$remote_cli_container" \
    git -C "$SBX_REPO_DIR" worktree remove --force "$SBX_WORKTREE_DIR" 2>/dev/null || true
  docker exec "$remote_cli_container" \
    git -C "$SBX_REPO_DIR" branch -D "$SBX_BRANCH" 2>/dev/null || true
fi

# ── Results ────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  $passed passed, $failed failed"
echo ""

# Clean up clone
[[ -n "$HOST_REMOTE_CLI_GIT_REPO_DIR" ]] && rm -rf "$HOST_REMOTE_CLI_GIT_REPO_DIR"

if [[ $failed -gt 0 ]]; then
  echo "FAIL"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
