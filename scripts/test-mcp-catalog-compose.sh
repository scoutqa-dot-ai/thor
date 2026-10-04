#!/usr/bin/env bash
# Dummy-only real broker check. Prebuilt cached images + current dist; no deployment data, builds or downloads.
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="neo-mcp-catalog-test-${UID}-$$"
compose=(docker compose --env-file /dev/null -f docker/mcp-test/compose.yml)
cleanup() { local status=$?; if [[ $status != 0 ]]; then "${compose[@]}" logs --no-color remote-cli >&2 || true; fi; "${compose[@]}" down --volumes --remove-orphans --timeout 3 >/dev/null 2>&1 || true; }
trap cleanup EXIT
for image in "${MCP_TEST_BROKER_IMAGE:-thor-remote-cli:latest}" "${MCP_TEST_RUNNER_IMAGE:-thor-mcp-test-runner:latest}" "${MCP_TEST_EXECUTOR_IMAGE:-thor-mcp-test-executor:latest}" node:24-slim; do
  docker image inspect "$image" >/dev/null || { echo "Prepare the fixture image $image before running this offline check" >&2; exit 1; }
done
[[ -f packages/remote-cli/dist/index.js ]] || { echo 'Run pnpm build before this check' >&2; exit 1; }
"${compose[@]}" up --no-build --pull never -d --wait --wait-timeout 60
connections=$("${compose[@]}" exec -T remote-cli node -e 'fetch("http://fixture:8000/health").then(r=>r.json()).then(r=>console.log(r.connections))')
"${compose[@]}" exec -T remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog validate
"${compose[@]}" exec -T remote-cli node -e 'fetch("http://fixture:8000/health").then(r=>r.json()).then(r=>{if(r.connections!==Number(process.argv[1]))throw Error("local validation connected");console.log("local validation made no connection")})' "$connections"
"${compose[@]}" exec -T remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog check localdocs
"${compose[@]}" exec -T remote-cli node /app/packages/remote-cli/mcp-child-isolation.mjs
for service in runner executor; do
  "${compose[@]}" exec -T "$service" node -e 'const fs=require("fs");for(const p of ["/etc/thor/mcp-catalog/catalog.json","/run/secrets/thor-mcp/dummy-token","/workspace/repos/catalog-fixture/private-link"]){try{fs.readFileSync(p);throw Error("private mount exposed")}catch(e){if(e.message==="private mount exposed")throw e}}console.log("private mounts inaccessible")'
done
"${compose[@]}" exec -T remote-cli node -e '
(async()=>{for(const args of [["localdocs","echo",JSON.stringify({text:"fixture-call"})],["localdocs","hidden_mutation",JSON.stringify({text:"denied"})]]){
const r=await fetch("http://localhost:3004/exec/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({args,directory:"/workspace/repos/catalog-fixture"})});const b=await r.json();if(b.exitCode!==(args[1]==="echo"?0:1))throw Error("catalog dispatch policy failed")}
for(const path of ["/run/secrets/thor-mcp/dummy-token","/workspace/repos/catalog-fixture/private-link","/proc/1/environ"]){
const r=await fetch("http://localhost:3004/internal/exec",{method:"POST",headers:{"content-type":"application/json","x-thor-internal-secret":"dummy-internal-secret"},body:JSON.stringify({bin:"git",args:["diff","--no-index","/dev/null",path],cwd:"/workspace/repos/catalog-fixture"})});const b=await r.json();if(b.stdout.includes("dummy-private-file-sentinel")||b.stdout.includes("dummy-broker-env-sentinel"))throw Error("private broker file/proc exposed")}
const result=await (await fetch("http://fixture:8000/health")).json();if(result.effects!==1)throw Error("hidden tool effected");console.log("real HTTP broker effects and file/proc policy passed")})().catch(e=>{console.error(e.message);process.exit(1)})'
"${compose[@]}" stop remote-cli
"${compose[@]}" run --rm --no-deps --pull never init node /init.mjs remove
"${compose[@]}" up --no-build --no-deps --pull never -d --wait remote-cli
if "${compose[@]}" exec -T remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog check localdocs; then echo 'removed alias still available' >&2; exit 1; fi
"${compose[@]}" stop remote-cli
"${compose[@]}" run --rm --no-deps --pull never init node /init.mjs missing
"${compose[@]}" up --no-build --no-deps --pull never -d --wait remote-cli
"${compose[@]}" exec -T remote-cli node -e 'fetch("http://localhost:3004/health").then(r=>r.json()).then(r=>{if(r.mcp.configured!==6)throw 1;console.log("missing optional catalog boots six defaults")})'
"${compose[@]}" stop remote-cli
"${compose[@]}" run --rm --no-deps --pull never init node /init.mjs malformed
"${compose[@]}" up --no-build --no-deps --force-recreate --pull never -d remote-cli
sleep 2
id=$("${compose[@]}" ps --all --quiet remote-cli)
[[ $(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id") == 'exited 1' ]] || { echo 'malformed catalog did not fail before listen' >&2; exit 1; }
if docker logs "$id" 2>&1 | grep -q remote_cli_listening; then echo 'malformed catalog listened' >&2; exit 1; fi
"${compose[@]}" run --rm --no-deps --pull never init node /init.mjs foreign-owner
if "${compose[@]}" run --rm --no-deps --pull never --entrypoint node remote-cli /app/packages/remote-cli/dist/index.js mcp-catalog validate; then echo 'foreign-owned enabled token accepted' >&2; exit 1; fi
"${compose[@]}" up --no-build --no-deps --force-recreate --pull never -d remote-cli
sleep 2
id=$("${compose[@]}" ps --all --quiet remote-cli)
[[ $(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id") == 'exited 1' ]] || { echo 'foreign token ownership did not fail before listen' >&2; exit 1; }
if docker logs "$id" 2>&1 | grep -q remote_cli_listening; then echo 'foreign token ownership listened' >&2; exit 1; fi
echo 'MCP catalog Compose acceptance passed; fixture cleanup follows'
