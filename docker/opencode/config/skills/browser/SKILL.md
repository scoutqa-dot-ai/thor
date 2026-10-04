---
name: browser
description: Orchestrate real browser interaction, screenshots, recordings, and UI evidence without encoding app-specific flows.
---

## When to use

Use this skill when:

- the task needs real browser navigation or DOM state, not just HTTP fetches
- you need screenshots, video, console errors, network observations, or visual evidence
- you need to choose between existing UI automation, lightweight interactive browsing, deterministic visible capture, or command-only tooling
- you need a repeatable verification pattern for UI work

---

## Overview

This skill covers the technical browser orchestration layer: selecting a browser capability, capturing evidence, and verifying that evidence. Product URLs, selectors, fixture-user names, and business assertions belong in repo docs, runbooks, or the task prompt. Credential values never belong in Slack or a task prompt.

Run browser tooling in the sandbox when local dependencies are missing or when you need headed display, recording, or installable runtimes. Common sandbox tools include `agent-browser`, Chrome for Testing, `ffmpeg`, `xvfb`, and ImageMagick among others — choose by capability first.

For a 1Password-backed SaaS login, use the dedicated MCP integration instead of sandbox browser tooling. Find Login choices for the destination, request an authenticated browser, then use only the returned session/snapshot refs:

With native MCP tools available, discover `onepassword-browser` with `mcp_search`, then pass each selected `toolRef` and business-argument object to `mcp_call`. The operation sequence and returned plan/session refs below still apply. With the legacy CLI, use:

```bash
mcp onepassword-browser find_login_items '{"url":"https://approved.example/dashboard"}'
mcp onepassword-browser browser_open_authenticated '{"login_plan_id":"<login-plan-id-from-find>","item_id":"<matching-item-id>"}'
mcp onepassword-browser browser_open_authenticated '{"login_plan_id":"<login-plan-id-from-find>","item_id":"<matching-item-id>","automate_totp":true}'
mcp onepassword-browser browser_snapshot '{"browser_session_id":"<browser-session-id>"}'
```

`find_login_items` performs credential-free route discovery and returns an opaque short-lived `login_plan_id`, the application/credential/callback origins, and safe matching Login metadata. Pass that plan ID and one returned item ID to the open call; do not invent or alter origins. The open call requires human approval. Set `automate_totp` to true only when the task calls for a Login item containing 1Password TOTP, and verify the approval card shows the expected complete origin chain and **Automated TOTP: Enabled**. The broker obtains and injects credentials only at the approved credential origin, permits only the approved callback, and retains browsing only on the application origin. Credential and MFA values stay outside Slack and agent context. Continue with `browser_click`, `browser_type`, `browser_navigate`, and `browser_close`; refresh the snapshot before each ref action because click/type consumes all current refs. The authenticated browser expires after inactivity.

---

## Core workflows

### Inspect UI state

- Use existing repo automation when it already reaches the state you need.
- Use a lightweight browser session for quick navigation, accessibility snapshots, screenshots, or simple clicks.
- Refresh the page/snapshot before retrying an action when element references or handles go stale.

Minimal pattern:

```bash
sandbox agent-browser --session <name> open <url>
```

### Interact with UI

- Prefer deterministic scripts or tests for repeated flows.
- Use ad-hoc browser control for one-off exploration or short validation.
- Stop after a repeated identical failure and report the blocking symptom instead of masking it with more retries.

### Capture evidence

- Screenshots are enough for static state or quick assertions.
- Video is appropriate for user-visible flows, animations, or handoff evidence.
- Console and network output are useful when debugging client errors or request failures.
- Store temporary inspection artifacts in `/tmp`; store artifacts that must be uploaded or synced in the worktree.

### Verify recordings

- Do not trust a recording only because the file exists.
- Check duration and extract at least one representative frame from the meaningful section.
- If a recording is short, blank, or shows the wrong window, switch to deterministic visible capture: start a headed browser in a virtual display, record that display, run the flow, then verify duration and frame content.

---

## Execution strategy

Choose the lightest reliable path:

1. **Existing repo automation** — Playwright, Cypress, Puppeteer, or app-provided scripts/tests that already cover the target behavior.
2. **Lightweight interactive browser** — quick navigation, snapshots, screenshots, and simple actions (for example `agent-browser`).
3. **Deterministic visible capture** — headed browser in a virtual display with display-level recording when evidence quality matters or lighter recording is unreliable.
4. **Command-only tooling** — browser-adjacent inspection, image/video processing, or artifact checks that do not need interactive control.

When reporting back, include the capability used, artifact paths, and how important evidence was verified. Use neutral, descriptive filenames such as `<flow-name>.webm`, `<flow-name>-check.png`, and `<flow-name>-console.txt`.

---

## Constraints

- Avoid destructive UI actions unless the user explicitly asked for them.
- Do not enter secrets into untrusted or ambiguous sites.
- Do not persist browser profiles or session data longer than needed unless persistence is part of the task.
- Treat screenshots, recordings, console logs, and network logs as potentially sensitive.
- Keep app-specific flow steps and business expectations out of this skill.

---

## Gotchas

- Browser handles, snapshots, and accessibility refs can go stale; refresh before retrying.
- Password-save bubbles, cookie banners, modals, popovers, and onboarding overlays can invalidate screenshots or recordings.
- Headless behavior can differ from headed behavior; use headed capture when visual evidence is the deliverable.
- Failed sandbox commands do not sync partial artifacts back; write important artifacts where a successful verification command can pull them into the worktree.
- Runtime/display startup failures usually mean you should move the flow into the sandbox or use a virtual display rather than repeatedly retrying locally.
