#!/usr/bin/env bash
#
# Validate the sandbox Docker image by building it locally and running
# commands inside the container to verify all runtimes work.
#
# Usage:
#   ./scripts/test-sandbox-image.sh
#   IMAGE=my-custom-image ./scripts/test-sandbox-image.sh   # skip build, test existing image
#
set -euo pipefail

IMAGE="${IMAGE:-thor-sandbox-test}"
DOCKERFILE="docker/sandbox/Dockerfile"
CONTAINER=""

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

cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── 1. Build image ─────────────────────────────────────────────────────────

echo "=== Build ==="

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "  Building $IMAGE from $DOCKERFILE..."
  build_output=$(docker build -t "$IMAGE" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")" 2>&1) || {
    echo "  ✗ Docker build failed"
    echo "$build_output" | tail -20
    exit 1
  }
  echo "  ✓ Image built successfully"
else
  echo "  Skipping build (SKIP_BUILD set), using image: $IMAGE"
fi

# Start a container to run tests against
CONTAINER=$(docker run -d --name "thor-sandbox-test-$$" "$IMAGE" sleep 300)
assert '[[ -n "$CONTAINER" ]]' "Container started"

# Helper: run a command in the container via login shell
run() {
  docker exec "$CONTAINER" bash -lc "$*" 2>&1
}

# ── 2. OS & user ──────────────────────────────────────────────────────────

echo ""
echo "=== OS & User ==="

whoami_out=$(run whoami)
assert '[[ "$whoami_out" == "thor" ]]' "Runs as thor user" "got: $whoami_out"

id_out=$(run id -u)
assert '[[ "$id_out" == "1001" ]]' "UID is 1001" "got: $id_out"

workspace_owner=$(run stat -c %U /workspace/repo)
assert '[[ "$workspace_owner" == "thor" ]]' "/workspace/repo owned by thor" "got: $workspace_owner"

# ── 3. Core tools ─────────────────────────────────────────────────────────

echo ""
echo "=== Core Tools ==="

for tool in git curl jq rg fd; do
  tool_out=$(run command -v "$tool")
  assert '[[ -n "$tool_out" ]]' "$tool is available" "not found"
done

git_branch=$(run git config --system init.defaultBranch)
assert '[[ "$git_branch" == "main" ]]' "Default git branch is main" "got: $git_branch"

# ── 4. Node / nvm ─────────────────────────────────────────────────────────

echo ""
echo "=== Node / nvm ==="

node_version=$(run node --version)
assert '[[ "$node_version" == v22.* ]]' "Default Node is v22.x" "got: $node_version"

nvm_list=$(run nvm ls --no-colors)
assert '[[ "$nvm_list" == *"v20."* ]]' "Node 20 installed" "nvm ls: $nvm_list"
assert '[[ "$nvm_list" == *"v24."* ]]' "Node 24 installed" "nvm ls: $nvm_list"

nvm_switch=$(run 'nvm use 20 >/dev/null && node --version')
assert '[[ "$nvm_switch" == v20.* ]]' "nvm use 20 switches to v20.x" "got: $nvm_switch"

pnpm_version=$(run pnpm --version)
assert '[[ -n "$pnpm_version" ]]' "pnpm available via corepack" "got: $pnpm_version"

# ── 5. Java / SDKMAN ──────────────────────────────────────────────────────

echo ""
echo "=== Java / SDKMAN ==="

java_version=$(run java -version 2>&1 | head -1)
assert '[[ "$java_version" == *"21"* ]]' "Default Java is 21" "got: $java_version"

sdk_switch=$(run 'sdk use java 17.0.15-tem >/dev/null 2>&1 && java -version 2>&1 | head -1')
assert '[[ "$sdk_switch" == *"17"* ]]' "sdk use java 17 switches to JDK 17" "got: $sdk_switch"

mvn_version=$(run mvn --version | head -1)
assert '[[ "$mvn_version" == *"Maven"* ]]' "Maven installed" "got: $mvn_version"

gradle_version=$(run gradle --version 2>/dev/null | grep -i "^Gradle" | head -1)
assert '[[ "$gradle_version" == *"Gradle"* ]]' "Gradle installed" "got: $gradle_version"

# ── 6. Python / pyenv ─────────────────────────────────────────────────────

echo ""
echo "=== Python / pyenv ==="

python_version=$(run python3 --version)
assert '[[ "$python_version" == *"3.12"* ]]' "Default Python is 3.12" "got: $python_version"

pyenv_versions=$(run pyenv versions --bare)
assert '[[ "$pyenv_versions" == *"3.11"* ]]' "Python 3.11 installed" "versions: $pyenv_versions"
assert '[[ "$pyenv_versions" == *"3.13"* ]]' "Python 3.13 installed" "versions: $pyenv_versions"

pyenv_switch=$(run 'pyenv shell 3.11 && python3 --version')
assert '[[ "$pyenv_switch" == *"3.11"* ]]' "pyenv shell 3.11 switches to 3.11" "got: $pyenv_switch"

uv_version=$(run uv --version)
assert '[[ "$uv_version" == *"uv"* ]]' "uv installed" "got: $uv_version"

# ── 7. Workspace / git init ───────────────────────────────────────────────

echo ""
echo "=== Workspace ==="

run 'cd /workspace/repo && git init && git config user.email "test@test.com" && git config user.name "test" && echo "hello" > test.txt && git add . && git commit -m "init"' >/dev/null 2>&1
commit_sha=$(run 'cd /workspace/repo && git rev-parse HEAD')
assert '[[ ${#commit_sha} -eq 40 ]]' "Can init repo, commit, and resolve HEAD" "sha: $commit_sha"

run 'cd /workspace/repo && echo "console.log(1)" > index.js && node index.js' >/dev/null 2>&1
node_run=$(run 'cd /workspace/repo && node index.js')
assert '[[ "$node_run" == "1" ]]' "Can run Node script in /workspace/repo" "got: $node_run"

# ── Results ────────────────────────────────────────────────────────────────

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
