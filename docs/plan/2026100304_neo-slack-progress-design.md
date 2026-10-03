# Neo — Slack activity footer and completion check

## Goal

Review the supplied `DS —Katalon  v2.0 (1).zip` and implement the user's requested animation/icon while Neo is thinking or working, plus a check-mark emoji when a request task finishes. Preserve existing model routing, Google auth continuation, actors, private results and deployment.

## Design review

The archive is 117,501 bytes, 10 bounded Markdown/CSS reference files (344,095 uncompressed bytes), with no bitmap/GIF assets or executable motion component. Reviewed foundations/token/icon/AI-state guidance: one moving AI mark per active surface, distinct actual states, adjacent plain-text label, Forest action-600 `#0F8461` on light surfaces, motion stops when output begins or work ends, and reduced motion remains readable. This is a locked brand mark, not a license to substitute a spinner or redraw it. The requested Slack completion emoji is an intentional chat-platform adaptation of the DS's web-icon rules.

The archive points to `MinhTranKatalon/katalon-ds-2-0`. Read-only checkout at `9af9aca730f24fd6cf880e2838a7646b64094f91` contains authoritative `thinking-mark.jsx` and two-tone mark geometry. Source SHA-256: `b7b9ce28728fb94f24cb311a79b1db5ea9f25db09863c329f3a438052bc3d3d7`. Preserve provenance; do not vendor the archive, unrelated components or silently claim a license not supplied by the source. Only task-specific pre-rendered mark assets and reproducible tooling belong in this change.

Slack Block Kit cannot execute CSS, React or canvas. Its compact `context` block accepts public image URLs and text, so pre-render the official thinking/working modes to GIF, plus a still PNG. GIF playback/reduced-motion behavior is controlled by Slack/client preferences; keep labels and accessible alt text regardless. Never promise live Slack animation acceptance from local fixtures.

## Phases

1. **Design assets and public static serving.** Reproducible, source-checksum-pinned offline export of original 839-point engine thinking/working modes with original assembled-mark handoff, common beat and token tint. No runtime/download/install dependency. A fixed light DS substrate makes ink legible on both Slack themes without inferring the user's theme. Generate compact animated GIFs and a still PNG; keep attribution/DS review, validate actual frame variation/timing/dimensions and inspect contact sheets. Add narrowly enumerated public Nginx routes. Test real Nginx asset serving before login, MIME and unchanged OAuth/brand routes; phase commit after validation.
2. **Truthful progress lifecycle and completion reaction.** Activity schema/projection maps actual Pi model preparation/tool lifecycle/output to thinking/working/responding, never raw chain-of-thought. Footer uses existing `RUNNER_BASE_URL` for fixed public assets, with safe text-only fallback if unconfigured; update every required existing-env surface when exposing it to runner. Show a compact footer for a long thinking-only request even with zero tool calls, without per-token chat updates; serialize/coalesce progress updates to avoid orphan/duplicate footer races. Stop animations on responding, auth wait, completed/error/abort/supersession. React `white_check_mark` to the exact current Slack request message on actual completion, including short/zero-tool requests. No success reaction for OAuth wait, errors, interruption or stale/superseded streams. Propagate/freeze current requester message timestamp and request identity through gateway/admission/OAuth/progress; new fields remain optional for historical compatibility. Real interface tests cover footer payload/image state, current-message targeting, stale same-session streams, no double counting, races, failed transport, cancellation/auth waits, short runs and cleanup. Full tests/types/builds, Pi/GWS container/browser regressions and phase commit.

## Decisions

| Decision                                                                                                                | Reason                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render the authoritative DS mark, not a generic spinner                                                                 | The supplied reference makes mark identity and motion semantic constraints.                                                                                                                      |
| Evaluate only checksum-pinned, completely reviewed pure engine and original render closure from an explicit source path | Offline reproducibility without vendoring the 88KB component or running React/DOM/theme hooks; checksum precedes source parsing/evaluation and dependency loading.                               |
| 64px, 66 frames at 100ms, exact 6.6s repeated beat                                                                      | Retains all 839 source points, original state math and solid crossfade with compact GIF sizes; no custom seam redraw or mode retiming.                                                           |
| Fixed white DS page substrate, original light Forest tint and near-black spark                                          | Keeps the assembled artwork legible on both Slack themes without guessing client theme.                                                                                                          |
| Preserve attribution without assuming a source license                                                                  | No source/repository/reference license grant was found; derivatives are not original Neo artwork or covered by historical brand licensing. External redistribution requires rights confirmation. |
| GIF/PNG assets with fixed public routes                                                                                 | Slack cannot run the component; animation itself needs no repeated Slack API calls or new credentials.                                                                                           |
| Existing public viewer base URL                                                                                         | No new secret/config family. Safe fixed asset paths disclose no task, user, OAuth capability or private data.                                                                                    |
| Label-based accessible fallback                                                                                         | Slack controls image playback and theme; text must still communicate the state when motion/images are disabled.                                                                                  |
| Completed request reaction independent of footer threshold                                                              | Fast requests need a visible finish marker even if no progress message was posted.                                                                                                               |
| Actual source message and request identity                                                                              | Thread ownership/session ID alone cannot identify follow-ups or reject late events within a reused Pi session.                                                                                   |
| Interrupted is not successful                                                                                           | The old abort-to-Done shortcut cannot justify a green check on unfinished work.                                                                                                                  |
| Native observable activity only                                                                                         | Model phase is not a claim to expose or classify private reasoning content.                                                                                                                      |
| Phase commits only/no push                                                                                              | Existing delivery discipline and live/CI verification gates remain separate.                                                                                                                     |

## Exit criteria and non-goals

Actual multi-frame exports follow DS source/beat/assembled mark, compact Slack context payloads match observable activity, source-message completion checks are correct, and wait/cancel/error/stale streams cannot claim success. Tests prove behavior through native Pi, real Slack SDK/local HTTP and shipped Nginx rather than only string construction. Preserve signature/credentials/storage/auth/model choices and historical interfaces. No whole design-system import, new frontend framework, live account/profile use, private `.env` or mounted-data edits, Slack workspace admin emoji upload, new Slack app or broad auth-policy changes. Live Slack rendering/preferences and production-host serving remain operator acceptance.

## Phase 1 implementation and isolated evidence

**Implemented, locally verified and approved for the phase commit; no push.** Phase 2 lifecycle, runner,
gateway, deployment environment and private data were not modified. See
[`docs/design-review/neo-slack-progress-assets.md`](../design-review/neo-slack-progress-assets.md)
for the source review, reproduction, artifact hashes and publication contract.

- `scripts/generate-slack-progress-assets.mjs` requires an explicit `--source`
  matching the pinned SHA-256. It uses the source's actual math, 839 baked points,
  original canvas painter, render crossfade and solid leaf/spark paths, with
  existing runner Sharp and installed ImageMagick. No fetch/install/network,
  runtime dependency, archive/component vendoring or inferred Slack theme.
  Source/output size, frame count, dimensions, VM evaluation and native encoder
  resources/time are bounded; temporary rendering files are removed.
- Task-specific static exports are **`/neo-thinking-v1.gif`** (129,553 bytes),
  **`/neo-working-v1.gif`** (133,619 bytes), **`/neo-ai-still-v1.png`** (1,395 bytes).
  GIFs are 64×64, 66 frames at 100ms, exact 6.6s, loop=0 (infinite), **63 unique
  frames each**. Their assembled 4.8s frames match the original solid PNG within
  palette quantization tolerance. Distinct torus/plate silhouettes and fixed
  white substrate are verified. The optional accessible HTML/contact sheet in
  `/tmp/neo-slack-progress-preview` was inspected, not committed/publicly routed.
- `docker/ingress/nginx.conf.template` enumerates only those three new public
  exact locations using existing `/usr/share/nginx/thor-brand`; unknown names
  still reach SSO. Historical/current Neo brand routes and attribution remain.
  Rebuild/redeploy the **ingress image** to publish both `static/` and template
  changes (existing Dockerfile already copies this directory). No new config or
  mount. Phase 2 can append these root paths to the existing public viewer base
  URL; production must allow Slack to retrieve actual image bytes before login.
- `scripts/test-slack-progress-assets.mjs` checks actual decoded frames, exact
  duration/loop/dimensions, mode distinction and solid handoff. It rejects a
  hostile wrong-checksum source before execution/output and, with `--source`,
  reproduces all three asset bytes offline.
- `scripts/test-gws-ingress-browser.mjs` now verifies actual shipped-Nginx public
  image MIME, exact file bytes, varying frame metadata/timing and Chromium 64px
  image decode under both theme preferences before authentication. It also
  checks unknown-name SSO and retains manifest/legacy-brand and cold Google
  OAuth/scoped-cookie/verified-owner regression checks. Fixture cleanup passed.
- `docker/ingress/static/NOTICE` separates Katalon derivative attribution from
  original Neo and historical Mjölnir art. No LICENSE/COPYING/grant was found in
  the pinned source/repo/reference; no assumed relicensing. Confirm rights
  before external redistribution. Live Slack image acceptance/playback, client
  reduced-motion behavior and production serving remain operator acceptance.

### Verification commands and results

```sh
export PATH=/home/s4ukk/.local/share/mise/installs/node/24.21.0/bin:/tmp/thor-pi-tools:$PATH
SOURCE=/home/s4ukk/.cache/checkouts/github.com/MinhTranKatalon/katalon-ds-2-0/thinking-mark.jsx
node scripts/generate-slack-progress-assets.mjs --source "$SOURCE" --preview /tmp/neo-slack-progress-preview
node scripts/test-slack-progress-assets.mjs --source "$SOURCE"
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-ingress-browser.mjs "$(command -v chromium)"
pnpm exec prettier --check scripts/generate-slack-progress-assets.mjs scripts/test-slack-progress-assets.mjs scripts/test-gws-ingress-browser.mjs docs/design-review/neo-slack-progress-assets.md docs/plan/2026100304_neo-slack-progress-design.md
git diff --check
```

Asset safety/reproduction and real Chromium/Nginx fixture passed (exit 0).
Toolchain: Node **24.21.0**, Sharp **0.34.5** / libvips **8.17.3** /
librsvg **2.61.2**, ImageMagick **7.1.2-31 Q16-HDRI**; only existing local tools
and cached `nginx:alpine` were used. Formatting/diff checks passed. Logs:
`/tmp/neo-slack-assets-test.log`, `/tmp/neo-slack-assets-browser.log`,
`/tmp/neo-slack-assets-style.log`. SBX preflight observed v0.46.0 and an approved
Node base image, but no prepared repository/dependency image; these are the
explicitly requested host/local-fixture checks, not sandbox-audit, live Slack,
production deployment or CI claims. Parent reviewed the exact public-route diff,
source-pinned exporter, frame/handoff safety tests, decoded contact sheet and
real-Nginx fixture additions; independently reran all asset/reproduction checks.
Phase 1 exit criteria passed; Phase 2 can now proceed after the phase commit.

## Phase 2 implementation and local evidence

**Implemented and verified through parent review, full local tests and rebuilt
container/browser gates; approved for the phase commit, no push.** Phase 1
generator, artwork and public routes are unchanged.

- Common progress now renders adjacent Neo thinking/working/responding labels
  and the fixed public GIF/still assets. A 1.5s grace reveals long model-only
  work with zero tools; the existing three-completed-call shortcut remains.
  Native model preparation/start, tool start/end and visible text output drive
  phase transitions. Reasoning content is neither classified nor forwarded to
  progress; repeated text deltas emit only one responding transition.
- Each session serializes its footer sends and coalesces the latest desired
  payload. Finish/supersession synchronously stops timers/pending updates,
  drains in-flight posts/updates (including an initial short waiting post),
  replaces motion with a still and deletes retired footers. Failed transport
  operations remain best-effort, use safe diagnostics and never fail the task.
  Failed terminal static updates attempt removal; failed deletes retain retry
  registry evidence rather than knowingly leaving a moving mark. Complete
  transport unavailability cannot guarantee a remote Slack edit/delete.
- All Pi progress and text frames carry receipt `requestId` and `sessionId`;
  every progress variant rejects stale request/session scope, including reused
  sessions and events arriving after terminal cleanup. Duplicate/replayed
  scoped starts are ignored. Historical unscoped callers remain compatible.
  Native tool-call IDs deduplicate completed calls; starts never count.
- Successful requests react `white_check_mark` independently of footer/tool
  thresholds. Gateway selects the newest queued human message of its already
  trusted actor, excluding bots/bystanders/rendered history, and freezes optional
  validated `messageTs` with the actual retry payload. Pi admission fingerprints
  and receipts retain it; OAuth continuation copies the original receipt, so
  its distinct continuation request reacts to the original human source.
  Historical missing timestamps fall back to the existing thread root.
  Wait/error/abort/interruption/supersession do not claim success; SDK
  `already_reacted` idempotence is retained.
- Reused `RUNNER_BASE_URL` is exposed to runner in Compose, Pi CI and dummy
  container fixtures, parsed as optional configuration and used only for fixed
  root-relative asset paths. HTTP(S) bases with credentials/query/fragment, or
  invalid/blank bases, produce safe text-only footers. `.env.example` and README
  Deployment Configuration now describe this existing variable's extra consumer.
  No new env, dependency, model/approval/auth policy or OpenCode persisted schema.
- Behavior tests cover delayed/coalesced posts, completion/new-start races,
  same-session stale variants, duplicate tool completion, error/fallback cleanup,
  short success, static waiting, safe public bases, exact-source selection and
  accepted-but-lost frozen retries. Actual native Pi/Responses/executor/SQLite
  plus Slack SDK/local HTTP prove image/label payloads, private reasoning
  exclusion, output coalescing, short/one-tool checks, failed model/no check,
  interruption and original-source OAuth resume. SDK reaction errors and
  `already_reacted` do not alter successful native completion.
- The existing container gate now records bounded dummy Slack deliveries and
  asserts native zero-tool grace, static output, completion/source timestamps,
  same-session signed follow-ups, and unauthenticated public image retrieval.
  These new container assertions are **not yet executed by this delegated
  implementation session**; the parent will run them with the existing cached
  fixture build, plus the Google/ingress Chromium regression.

### Phase 2 decision log

| Decision                                                                       | Reason                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep lifecycle ownership in common progress, project native observations in Pi | Avoid scattering send/drain/cleanup races into runtime or Slack adapters; preserve legacy transport contracts.                                             |
| Receipt request identity, not session identity alone                           | A follow-up and OAuth continuation reuse a native session but have separate stream ownership and completion.                                               |
| Optional wire fields in existing schemas/receipts                              | Preserve historical admissions/frozen retries without a schema migration or unrelated branded-ID rewrite.                                                  |
| Bounded recent start/scope evidence plus live-session guards                   | Reject replay/stale terminal events without an unbounded process-wide history; live owners remain guarded even after cache eviction.                       |
| Best-effort delivery outcomes stay inside progress                             | A Slack failure must not change successful agent work; waiting/error static-update failure attempts cleanup instead of keeping active motion deliberately. |
| Fixed root-relative paths ignore a base pathname                               | Artwork URLs cannot contain viewer/task/user/OAuth capability data; unsafe base components disable images.                                                 |
| No new Slack permissions or public-host configuration                          | Existing reaction transport and existing public ingress base already provide the required capability.                                                      |

### Phase 2 verification

Toolchain: Node **24.21.0**, existing pnpm/dependencies only; no installation,
live Slack/Google/backend requests, private mounted data or `.pi` edits.

```sh
export PATH=/home/s4ukk/.local/share/mise/installs/node/24.21.0/bin:/tmp/thor-pi-tools:$PATH
pnpm typecheck
pnpm exec vitest run packages/common/src/progress-manager.test.ts packages/common/src/progress-events.test.ts packages/runner/src/pi-runner.test.ts packages/gateway/src/batch-request.test.ts packages/gateway/src/slack-model-routing.test.ts
pnpm test
pnpm build
bash -n scripts/test-pi-e2e.sh
node --check scripts/fixtures/pi-responses.mjs
git diff --check
```

Focused tests: **151 passed**, 5 files. Full suite: **1,098 passed**, 73 files.
Workspace typecheck and build passed. Shell/fixture syntax and diff checks
passed. Initial focused runs exposed the intended old abort-as-Done assertion
and exact equality assertions that excluded new scope fields; updated behavior
assertions and an early common export fix pass through real interfaces now.
Logs: `/tmp/neo-progress-types.log`, `/tmp/neo-progress-focused.log`,
`/tmp/neo-progress-full-test.log`, `/tmp/neo-progress-full-build.log`.

Parent reviewed the complete code/diff and fixed three adjacent lifecycle
issues: native tool completion now updates the count before publishing the next
phase; failed cleanup preserves the truthful static **Done** label rather than
overwriting it with **stopped**; transport heartbeats and known retired legacy
streams cannot invent a new thinking footer. The registry now consistently uses
the canonical target key (the old doubled key made its active-owner check
ineffective). No new abstractions: the redundant cleanup forwarding helper was
removed and active/terminal send policy uses named domain values instead of a
behavior-controlling boolean. Real native/SDK and common lifecycle regressions
prove the completed-count display, static Done after failed deletion, and the
legacy heartbeat/late-event boundary with a later genuine start still accepted.

Final parent gate: **73 files / 1,099 tests**, all workspace typechecks and builds
passed. Rebuilt Pi container E2E passed the actual native/SDK image lifecycle,
zero-tool grace, static output, exact current/source follow-up checks, public
images, model routing/escalation, isolation, viewers and SIGKILL recovery.
Rebuilt Google container E2E passed requester OAuth/direct execution,
reads/writes/formatting/pagination, upstream denials and private mounts. Both
serial Chromium regressions passed: shipped Nginx serves exact GIF/PNG MIME and
bytes before login, with real frame variation/loop and both theme decodes, and
preserves narrow SSO/brand/OAuth/cookie/verified-owner behavior. Fixture runtimes
cleaned up. These are local deterministic integration checks, not GitHub CI,
production serving, real provider/account acceptance or live Slack playback.

Final logs: `/tmp/neo-progress-final-{types,tests,build,pi-container,gws-container}.log`,
`/tmp/neo-progress-parent-focused.log`, `/tmp/neo-progress-ingress-browser.log`,
`/tmp/neo-progress-cookie-browser.log`. SBX preflight confirmed runtime/base
availability but no prepared project/dependency image; this feature's explicitly
requested host/local-fixture checks are not a sandbox security-audit claim.

Operator rollout: retain the existing public `RUNNER_BASE_URL`, rebuild/redeploy
**ingress + gateway + runner**, and ensure Slack can retrieve the three fixed
images without SSO. No app/scope/credential replacement. Live Slack GIF playback
and reduced-motion acceptance remain client/operator checks.
