# Neo Slack activity artwork — design review and reproduction

## Reference and scope

The user supplied `DS —Katalon  v2.0 (1).zip`, a docs-only reference extracted
under `/tmp/neo-katalon-design-review/gemini-katalon-ds` (10 Markdown/CSS files;
no executable component or GIF/PNG). `08-KATALON-AI.md` specifies a locked mark,
one moving mark per surface, truthful states, adjacent text, light Forest ink,
assembled reduced-motion fallback and stopping when output/work ends. Do not
replace it with a generic spinner or a dotted approximation of the final mark.
The requested completion check emoji is a Slack adaptation, not a DS web icon.

The authoritative motion source is
[`thinking-mark.jsx`](https://github.com/MinhTranKatalon/katalon-ds-2-0/blob/9af9aca730f24fd6cf880e2838a7646b64094f91/thinking-mark.jsx),
commit `9af9aca730f24fd6cf880e2838a7646b64094f91`, SHA-256
`b7b9ce28728fb94f24cb311a79b1db5ea9f25db09863c329f3a438052bc3d3d7`.
The complete 1,597-line source was read before implementation. Its original
839 baked points, seats, projection, radii, ink, mode options and canvas painter
are evaluated only after exact checksum verification. The exporter extracts the
original render closure, including its `0.78` → `1` smooth crossfade, rather than
reimplementing that logic. No React/DOM/theme hooks run. The original `MARK_LEAF`,
`MARK_SPARK`, `MARK_BOX` and SVG viewBox preserve the solid artwork's alignment.
SVG circles merely transport the original painter instructions to rasterization;
they are not new mark geometry.

No LICENSE/COPYING file or explicit license grant was found in the pinned checkout,
source header, README or supplied reference. Attribution is retained in
`docker/ingress/static/NOTICE`; these derivatives are **not** claimed as original
Neo artwork or relicensed. The historical Mjölnir CC BY-SA attribution applies
only to the historical assets it already described. User-provided reference use
is not a general redistribution grant; confirm rights before external publication.
No archive, full component/design system, unrelated assets or dependencies are
vendored.

## Selected Slack adaptation

| Public path            | Actual source mode                           | Export                                  |
| ---------------------- | -------------------------------------------- | --------------------------------------- |
| `/neo-thinking-v1.gif` | `frameLogoTorus` / original `MODES.thinking` | 64×64, 66 frames, 10 fps, infinite loop |
| `/neo-working-v1.gif`  | `frameLogoWork` / original `MODES.working`   | 64×64, 66 frames, 10 fps, infinite loop |
| `/neo-ai-still-v1.png` | Original solid leaf + spark at 4.8s          | 64×64 PNG                               |

Both GIFs sample the original 3s dwell + 1.8s assembly + 1.8s return = **6.6s**
beat, starting at t=0. Each frame has a 100ms delay. Ten fps bounds size while
retaining the slow shape/ink motion. The GIF repeats that sampled beat (including
its time-dependent pulse); no custom seamless-loop math or seam redraw is added.
Rasterization is 2× supersampled then reduced to 64px, matching the component's
maximum DPR. Full 839-point detail is retained at this source size.

White `--k-bg-page` / `--k-gray-0` is a fixed, opaque DS light substrate; the
original light tint is `#0F8461`, with solid spark `#032118`. The raster cannot
infer Slack's theme and is identical on both themes. The light tile is intentional
so the near-black spark remains visible on dark Slack. Text labels/alt text must
always accompany the compact context image. Slack controls GIF playback and
reduced-motion behavior: a PNG fallback is available, but these exports cannot
detect client preferences. Phase 2 removes animation on output, auth wait or
terminal states; these assets alone do not implement lifecycle/completion logic.

## Offline reproduction

Use an explicitly supplied, already available pinned source. The script never
fetches, downloads or installs. Existing runner `sharp` and installed ImageMagick
`magick` are build-time tools only; no new runtime dependency or environment
variable is required. Wrong/mutated sources fail before evaluation, dependency
loading, temporary rendering or output creation. VM evaluation disables generated
code and has a per-evaluation time limit. Frame count/dimensions, source/output
bytes and ImageMagick memory/time are bounded; temporary frames are cleaned up.

```sh
export PATH=/home/s4ukk/.local/share/mise/installs/node/24.21.0/bin:/tmp/thor-pi-tools:$PATH
SOURCE=/home/s4ukk/.cache/checkouts/github.com/MinhTranKatalon/katalon-ds-2-0/thinking-mark.jsx
node scripts/generate-slack-progress-assets.mjs --source "$SOURCE" \
  --preview /tmp/neo-slack-progress-preview
node scripts/test-slack-progress-assets.mjs --source "$SOURCE"
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs \
  scripts/test-gws-ingress-browser.mjs "$(command -v chromium)"
```

`--output /tmp/asset-output` redirects just the three generated assets.
`--preview` optionally writes a small 384×128 contact sheet and accessible HTML
with frame labels (thinking row, working row; 0, 1.5, 3, 3.9, 4.8, 5.7s). The
preview is review-only and not committed or publicly routed. It was inspected:
torus and angular plate resolve to the identical original solid leaf/spark.
Reproducing bytes across different native renderer/encoder versions is not
promised; verify the rendered contract before intentionally regenerating v1.

## Publication and validation

The existing `docker/ingress/Dockerfile` copies `static/` into
`/usr/share/nginx/thor-brand/`. Rebuild/redeploy the ingress image with these files
and the changed `nginx.conf.template`; no new mount/config/credential is needed.
All three paths are exact public locations, served before Vouch login with
`image/gif` or `image/png`. Unknown names still pass through the existing SSO
boundary. Phase 2 may append these root paths to the existing public viewer base
URL; do not use a private runner service URL. Production ingress must be publicly
reachable by Slack's image fetcher and return the actual image bytes without
login; ingress proxies/CDNs/firewalls must preserve that contract.

Static verification decodes every GIF frame: 66 frames, **63 unique frames** per
mode, exact 6.6s duration, infinite loop, distinct initial mode silhouettes, white
substrate and assembled-frame match to the still PNG despite GIF quantization.
It also proves hostile wrong-checksum source rejection without execution/output
and byte-for-byte offline regeneration. Frame/beat verification lives in that
export check, not duplicated inside the Chromium/shipped-Nginx fixture. The
browser fixture verifies real MIME/exact bytes before login, 64px browser image
decoding in light/dark preferences, unknown-path SSO, unchanged
historical/current branding and cold Google OAuth/cookie/owner flow.

Observed artifact sizes and SHA-256:

- Thinking: 129,553 bytes; `00cfe77aac3cf52cd942d12e7f500c94110c45d3ec29efe04de7a9e94679e0d5`.
- Working: 133,619 bytes; `870eefbfda160a4608c05a9f152cae206f422bf3494cde3f01e1d64d54b202a2`.
- Still: 1,395 bytes; `2de9d2945e1a409ffb8756a26392e9591d2ba51aa13788698351e144cad0f527`.

Local checks are not proof of live Slack rendering/playback or production-host
publication. Those remain operator acceptance, along with rights confirmation.
