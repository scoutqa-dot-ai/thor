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
