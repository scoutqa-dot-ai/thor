#!/usr/bin/env bash
#
# End-to-end test for Thor PoC (Phase 4).
#
# Tests the full chain: curl -> runner -> OpenCode -> proxy -> Linear MCP
#
# Prerequisites:
#   - Both services running (either `pnpm dev` with LINEAR_API_KEY, or `docker compose up`)
#   - OpenCode configured with an LLM provider in the runner environment
#
# Usage:
#   ./scripts/test-e2e.sh                    # default: http://localhost:3000
#   RUNNER_URL=http://localhost:3000 ./scripts/test-e2e.sh
#
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-http://localhost:3000}"
PROXY_URL="${PROXY_URL:-http://localhost:3001}"

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

proxy_health=$(curl -sf "$PROXY_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$proxy_health" == *"ok"* ]]' "Proxy is healthy"

runner_health=$(curl -sf "$RUNNER_URL/health" 2>/dev/null || echo '{}')
assert '[[ "$runner_health" == *"ok"* ]]' "Runner is healthy"

# ── 2. Trigger: list tools ──────────────────────────────────────────────────

echo ""
echo "=== Trigger: List Tools ==="
echo "  (this may take a moment on first run — OpenCode server starts up)"

list_response=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List the tools available to you. Only list tool names that start with thor-proxy, one per line. Nothing else."}' \
  --max-time 180 2>/dev/null || echo '{"error":"request failed"}')

assert '[[ "$list_response" == *"sessionId"* ]]' "Got a session ID"
assert '[[ "$list_response" == *"thor-proxy_linear__"* ]]' "Response contains proxied Linear tools"
assert '[[ "$list_response" == *"list_issues"* ]]' "Response contains list_issues tool"

# ── 3. Trigger: actual tool call ────────────────────────────────────────────

echo ""
echo "=== Trigger: Tool Call (list issues) ==="

issues_response=$(curl -sf -X POST "$RUNNER_URL/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Use the thor-proxy tool to list the 2 most recent Linear issues. Show their identifier, title, and status in a table."}' \
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
