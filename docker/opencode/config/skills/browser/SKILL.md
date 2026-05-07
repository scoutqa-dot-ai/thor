---
name: browser
description: Orchestrate browser automation, recording, screenshots, and verification across sandbox/browser tools while keeping app-specific flows in runbooks.
---

## When to use

Use this skill when:

- the task needs real browser navigation or DOM state, not just HTTP fetches
- you need screenshots, video, console errors, network observations, or visual evidence
- you need to choose between browser-driving approaches such as `agent-browser`, headed Chrome plus CDP, or repo-provided browser scripts
- you need a repeatable verification pattern for UI work

Do **not** put product-specific flows in this skill. Keep URLs, credentials, tenant IDs, selectors, seeded users, and business assertions in repo docs, runbooks, or the task prompt.

---

## Operating model

1. **Read the app-specific instructions first**
   - If the repo or memory already has a browser runbook, read it before inventing a flow.
   - Use this skill for the technical orchestration layer, not as the source of product knowledge.

2. **Choose the lightest viable browser path**
   - **Repo script / existing Playwright test**: prefer this first when it already covers the task.
   - **`agent-browser`**: good for quick navigation, snapshots, screenshots, and simple actions.
   - **Headed Chrome + CDP + `ffmpeg`/`xvfb`**: use when you need upload-quality video, deterministic visible capture, or `agent-browser record` is unreliable.
   - **Plain `sandbox` command only**: use for browser-adjacent tooling that does not need interactive control.

3. **Run browser tooling in the sandbox when local tools are insufficient**
   - Browser dependencies usually belong in `sandbox`, especially for headed runs, video capture, or runtime/tool installs.
   - Reuse an existing prepared sandbox when speed matters.

4. **Capture evidence as part of the flow**
   - Screenshots for quick assertions.
   - Video for user-visible flows.
   - Console or network output when debugging.
   - A small number of extracted verification frames for important recordings.

5. **Return reproducible evidence**
   - Report what path you used, what artifact was produced, and what verified the result.

---

## Tool selection guide

### Prefer `agent-browser` when

- you need a quick browser session
- you want accessibility snapshots or lightweight interaction
- you only need screenshots or short validation steps

Typical pattern:

```bash
sandbox bash -lc '
  agent-browser --session qa open <app-url> &&
  agent-browser --session qa snapshot -i &&
  agent-browser --session qa screenshot /tmp/page.png
'
```

### Prefer headed Chrome + CDP + `ffmpeg` when

- you need a reliable visible recording
- you need to guarantee the recorded window matches the driven browser
- `agent-browser record` produced short, blank, or misleading video

High-level pattern:

```bash
sandbox bash -lc '
  export DISPLAY=:99
  Xvfb :99 -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  ffmpeg -y -video_size 1440x900 -framerate 10 -f x11grab -i :99.0 ./flow.webm >/tmp/ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
  # launch headed Chrome and drive it via CDP or repo script
  # ...perform flow...
  kill -INT "$FFMPEG_PID" && wait "$FFMPEG_PID" || true
  kill "$XVFB_PID" || true
'
```

### Prefer repo-provided browser scripts when

- the repo already has a Playwright/Cypress/Puppeteer workflow for the target behavior
- the task is better expressed as code than as ad-hoc clicks

Example:

```bash
sandbox pnpm playwright test <spec>
```

---

## Recording rules

- Do not assume a `.webm` is good just because the file exists.
- Verify important recordings with at least one extracted frame from the meaningful section.
- For upload-quality evidence, favor the deterministic path over the shortest path.
- If a large modal, popover, password-save bubble, or onboarding overlay covers the UI, clear it before trusting the capture.

Frame-check pattern:

```bash
sandbox bash -lc '
  ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 ./flow.webm &&
  ffmpeg -y -ss 10 -i ./flow.webm -frames:v 1 ./flow-check.png >/dev/null 2>&1 &&
  test -s ./flow-check.png
'
```

---

## Generic retry and fallback policy

- If browser startup fails because of missing display/runtime deps, move to sandbox or add `xvfb`.
- If `agent-browser` refs go stale, take a fresh snapshot before retrying.
- If the recorder produces a short/blank file, switch to headed Chrome + deterministic capture instead of repeatedly retrying the same recorder.
- If the app returns a transient upstream/auth error, retry once with a fresh profile/session before concluding the flow is broken.
- If a second attempt fails for the same reason, stop and report the exact blocking symptom.

---

## Artifacts and paths

- Use `/tmp` for temporary screenshots or inspection-only files.
- Use the worktree when artifacts need to sync back reliably or be uploaded later.
- Keep filenames explicit enough to identify the flow, for example:
  - `./login-flow.webm`
  - `./login-flow-check.png`
  - `./console-errors.txt`

When reporting back, include:

- artifact path
- capture method used
- verification method used

---

## Safety boundaries

- Avoid destructive UI actions unless the user explicitly asked for them.
- Do not enter secrets into untrusted or ambiguous sites.
- Do not persist browser profiles or session data longer than needed unless persistence is part of the task.
- Be careful with screenshots and logs that may include tokens, PII, or customer data.

---

## Relationship to runbooks

This skill is the technical playbook.

- Put app-specific steps in runbooks.
- Put product URLs, auth flows, fixture users, and expected business outcomes in repo docs or task prompts.
- Keep this skill focused on combining browser tools, capture methods, verification, retries, and artifacts.
