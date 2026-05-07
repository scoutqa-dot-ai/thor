# Docker Build Cache Optimization

**Date**: 2026-05-06
**Status**: Implemented pending review

## Goal

Optimize the root multi-target Dockerfile so normal monorepo code changes reuse expensive Docker/BuildKit layers more reliably while preserving correct images for `gateway`, `admin`, `runner`, `remote-cli`, `opencode`, and `mitmproxy`.

Primary cache wins to pursue:

- Keep dependency resolution/install layers stable when only source files change.
- Reuse pnpm's package store across cold-ish BuildKit builds.
- Narrow source `COPY` boundaries so unrelated file changes do not invalidate every build input.
- Avoid rebuilding every package when a target only needs a subset, where this can be done without making the Dockerfile brittle.
- Keep service image behavior unchanged unless a later benchmark justifies a runtime-image split.

## Current cache hotspots

- The Dockerfile prepares `pnpm@9.15.4` while `package.json` declares `packageManager: pnpm@10.33.1`; this can produce different install behavior than local development and weakens reproducibility.
- `deps` copies the root manifests and package manifests before `pnpm install`, which is good, but it uses no BuildKit cache mount for the pnpm store, so fresh builders re-download packages.
- `build` runs `COPY packages/ packages/` followed by `pnpm -r build`; any source change in any package invalidates the whole build layer for all service targets.
- The `opencode` target depends on `build` only to copy `packages/opencode-cli/dist/remote-cli.mjs`, so gateway/runner/admin source edits can unnecessarily invalidate the opencode image path.
- `remote-cli` target copies wrapper scripts and `entrypoint.sh` after the full build, but it installs apt/npm global tooling in layers that are independent of app source and should remain that way.
- `.dockerignore` already excludes docs, scripts, `.git`, `node_modules`, and `dist`; this is good for context size, but Dockerfile `COPY` boundaries can still be more precise.

## Phase 1 — Baseline and benchmark harness

Establish repeatable measurements before changing the Dockerfile.

- In sandbox, start Docker/BuildKit and record versions/capabilities (`docker version`, `docker buildx version`, BuildKit availability).
- Build representative targets from the current Dockerfile with plain progress and timing:
  - cold-ish target builds: `gateway`, `remote-cli`, `opencode`, and optionally `mitmproxy` for non-Node regression coverage;
  - warm rebuild with no changes;
  - warm rebuild after touching a leaf source file such as `packages/gateway/src/...`;
  - warm rebuild after touching `packages/common/src/...`;
  - warm rebuild after changing a non-copied file to confirm `.dockerignore`/context behavior.
- Capture which Dockerfile steps are cache hits/misses and where wall time is spent.
- Save benchmark notes in the run directory (for example `baseline.md`) and link them from the run README.

Exit criteria:

- Baseline timing table exists for at least `gateway`, `remote-cli`, and `opencode`.
- The slowest invalidated steps for normal source changes are identified.

## Phase 2 — Dependency layer correctness and pnpm store reuse

Make dependency layers more reproducible and cheaper to rebuild.

- Align the Dockerfile's Corepack preparation with root `packageManager` (`pnpm@10.33.1`) or use Corepack's package-manager metadata directly if supported cleanly by Node 24/Corepack.
- Prefer a two-step pnpm dependency flow with BuildKit cache mount:
  - `pnpm fetch --frozen-lockfile` after copying only lockfile/workspace/root package metadata needed for resolution;
  - `pnpm install --frozen-lockfile --offline` after copying package manifests;
  - use `--mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store` or an explicitly configured `PNPM_HOME`/store path so repeated sandbox/local builds reuse downloaded tarballs.
- Keep install scripts behavior unchanged unless a measured and reviewed production-safety reason exists to change it.
- Ensure the layer still invalidates when any relevant `package.json`, `pnpm-lock.yaml`, workspace file, root build config, or TypeScript config changes.

Exit criteria:

- `pnpm install` remains frozen/reproducible and matches the repository's declared pnpm major version.
- Dependency-only rebuilds are at least no worse than baseline and fresh-build package download time improves when BuildKit cache is present.

## Phase 3 — Narrow build-stage inputs and package rebuild scope

Reduce source-change invalidation for service builds.

- Replace broad `COPY packages/ packages/` where practical with package-scoped copies ordered by dependency fan-out:
  - copy/build `packages/common` first because every Node service depends on it;
  - copy/build leaf packages in separate layers where target reuse benefits are measurable (`gateway`, `runner`, `admin`, `remote-cli`, `opencode-cli`).
- Consider target-specific build stages, for example:
  - `common-build` from deps that copies/builds common;
  - `gateway-build`, `runner-build`, `admin-build`, `remote-cli-build`, `opencode-cli-build` that copy only their package source plus built common as needed;
  - or a simpler middle ground that keeps one `build` target but separates copy/build commands enough for Docker to reuse leaf-package layers.
- Validate tsup/workspace resolution still works with TypeScript source exports from `@thor/common`; if package-specific builds need built common artifacts or source files, make that dependency explicit in the stage design.
- Avoid over-sharding if benchmarks show Dockerfile complexity outweighs rebuild savings.

Exit criteria:

- A gateway-only source edit does not invalidate unrelated leaf package build layers when building the `gateway` target.
- An opencode-cli-only edit invalidates only the opencode-cli/app layers needed for the `opencode` target.
- A common source edit correctly invalidates all dependent service build layers.

## Phase 4 — Target-specific image path cleanup

Preserve or improve cache reuse for service-specific image layers.

- Decouple `opencode` from the full `build` stage if Phase 3 shows it only needs `opencode-cli` output; keep its expensive npm/apt/pip/tool layers independent from app source.
- Keep `remote-cli` apt/GitHub CLI/global npm installs after the app build only if benchmarks show no source invalidation; otherwise reorder into a stable base/tooling stage and copy app output last.
- Leave `mitmproxy` mostly separate; only verify it still builds because the root Dockerfile contains the target.
- Evaluate, but do not automatically implement, production runtime stages that copy only `dist` plus pruned production dependencies. This can shrink images but may be a larger behavior change than cache optimization.

Exit criteria:

- Service targets still start with the same commands/users/ports/env defaults.
- Expensive OS/global-tool install layers are cache hits after normal TypeScript source edits.

## Phase 5 — Verification and comparison

Prove the optimized Dockerfile is correct and faster on the intended paths.

- Re-run the Phase 1 benchmark matrix in sandbox against the optimized Dockerfile.
- Compare baseline vs optimized wall times and cache-hit/miss patterns.
- Run local repository checks that are relevant to Dockerfile/package changes:
  - `pnpm -r build`
  - `docker build --target gateway .`
  - `docker build --target runner .`
  - `docker build --target admin .`
  - `docker build --target remote-cli .`
  - `docker build --target opencode .`
  - `docker build --target mitmproxy .`
- If compose behavior is touched, run the narrowest feasible `docker compose build`/service smoke check.

Exit criteria:

- Benchmark comparison shows material improvement for no-op/source-edit rebuilds or documents why an apparent optimization was rejected.
- All service targets build successfully.
- Any changed package-manager or Docker behavior is documented in this plan's decision log.

## Decision log

| Decision | Rationale |
| --- | --- |
| Use a durable repo plan | This change crosses the root Dockerfile, package manager behavior, service image paths, and benchmark artifacts; repo conventions prefer `docs/plan/` for this scope. |
| Benchmark before and after in sandbox | Docker layer-cache changes are easy to overfit by inspection; BuildKit timing and cache-hit evidence should drive which complexity is worth keeping. |
| Align Dockerfile pnpm with `packageManager` first | Cache improvements should not preserve a package-manager mismatch that can change lockfile/install semantics between local and image builds. |
| Treat runtime image slimming as optional/out-of-scope unless measured | Pruned runtime images may be worthwhile, but they risk changing workspace dependency/runtime behavior and are not required for layer-cache reuse. |
| Split pnpm fetch/install with a BuildKit store cache | Sandbox evidence showed dependency download/install was one of the expensive cold-build steps; `pnpm fetch` plus offline install keeps resolution reproducible while letting BuildKit reuse tarballs across rebuilds. |
| Use package-scoped build stages instead of broad service builds | `@thor/common` is source-exported and leaf packages can build directly from common source; package-scoped stages kept gateway edits from invalidating opencode and unrelated leaf builds without adding new tooling. |
| Move remote-cli OS/global CLI tooling into a stable base stage | The remote-cli image still copies the built app into the final target, but apt/npm global tooling no longer depends on normal TypeScript source layers. |

## Out of scope

- Replacing pnpm or changing workspace package topology.
- Adding new app dependencies solely for build orchestration.
- Changing service commands, ports, environment contracts, or volume assumptions.
- Solving Docker Compose integration/runtime health issues unrelated to Dockerfile build-cache behavior.
- Optimizing the separate `docker/cron` image unless a benchmark identifies it as part of the requested main Dockerfile path.
