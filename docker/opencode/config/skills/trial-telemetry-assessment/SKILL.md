---
name: trial-telemetry-assessment
description: Slack channel C0ASEKELZ1C only: analyze Katalon Studio and True Platform trial telemetry for a user email or company domain. Use ONLY when the inbound Slack routing or event context shows channel C0ASEKELZ1C and someone asks to assess breadth, outcome, and usage lifetime, identify directly observed and implied gaps, return a scored tier, behavioral pattern label, next action, and targeted learning resources.
---

# Trial Telemetry Assessment

Use this skill to inspect warehouse telemetry for a trial user or domain, score them on breadth and outcome, factor in how long they have been active, identify the pattern driving their results, infer the implied bad practices that pattern typically carries, and recommend specific resources to close both the observed and implied gaps.

This skill is intentionally channel-scoped. Only use it when the Slack routing or Slack event payload in the prompt shows channel `C0ASEKELZ1C`.

---

## When to Use This Skill

- The active Slack context is channel `C0ASEKELZ1C`
- Someone asks what features or workflows a user is using
- Someone asks whether a trial user or domain is active, exploratory, or effective
- Someone asks for likely issues or blockers based on telemetry
- Someone gives an email address or company domain and wants a fast usage assessment, coaching recommendation, and learning resources

Do not use this skill for other Slack channels unless Thor's configuration is intentionally widened.

---

## Data Sources

Name the tables used at the top of every reply. Use only what is needed.

| Table | Use for |
|---|---|
| `dm_products.stg_users` | Identity, account mapping, and **account creation date** for lifetime calculation. Always check first. |
| `dm_products.fact_trial_user_core_actions` | High-level Studio action counts (create, exec, edit). Volume proxy. Action counts ≠ distinct test case counts. |
| `dm_products.fact_ks_user_event_feature_usage` | Granular feature events: web_spy, save_captured_web_object, edit_test_object, ksu_ksu_studioassist_chat, ksu_open_self_healing_insights, ksu_edit_script, ksu_execute_test_suite, ksu_fix_broken_to_saved_to_object_repository, etc. Primary source for breadth scoring. |
| `dm_products.fact_true_platform_user_usage` | True Platform: automation runs, manual TC creation, analytics views, release dashboard, live monitor, AI interactions. |
| `dw_events.ksu_execute_test_case` | Execution history: PASSED / FAILED / ERROR, self_healing_triggered, enable_self_healing, root_cause. Primary source for outcome scoring. root_cause is usually null. |
| `dw_events.ksu_new_test_case` | Raw test case creation events. GUIDs may not match execution history — always note the discrepancy. |
| `dw_events.ksu_tracks` | Granular event stream. Use to confirm repair sequences and first/last active dates for lifetime calculation. |
| `dm_support.fact_case` | Support ticket history. Absence = "not observed in accessible warehouse data." |

---

## Workflow

### Step 1 · Identify Scope

- **Email input** → assess that user directly.
- **Domain input** → enumerate users from `stg_users`, pick the strongest representative by highest combined breadth + pass rate signal — NOT raw execution volume alone. Name the representative and state why. List all other domain users with their tiers.

---

### Step 2 · Establish Account vs. Telemetry vs. Usage

Three distinct states — never collapse them:

- **Account exists** — user appears in `stg_users` with a mapped user_id
- **Telemetry exists** — events appear in warehouse tables
- **Meaningful usage exists** — Studio workflow depth is observable

A user with platform-only signals is not inactive — they may be a TestOps/platform-consumer persona. A user with a mapped account but no telemetry is **non-activated**, not low-skill.

---

### Step 3 · Assess Usage Lifetime and Apply Context

Calculate usage lifetime as: **days between first observed event and assessment date** (use `ksu_tracks` first/last timestamps, or `stg_users` account creation date as fallback).

| Lifetime | Hypothesis | Scoring adjustment |
|---|---|---|
| **< 14 days** (New user) | Learning phase. Low scores are expected and normal. | Apply **New User flag**. Append "(New — expected low scores)" to tier label. If scores are high despite short tenure, flag as **Early Outlier**. |
| **14–60 days** (Active trial) | Product explored meaningfully. Scores reflect genuine current capability. | Standard scoring. No adjustment. |
| **> 60 days** (Established user) | Sufficient time to develop habits. Low scores now signal an entrenched gap, not a learning curve. | Increase urgency in next action. Add **⚠️ Established** flag if Combined < 4. |

**Early Outlier rule:** If a user under 14 days scores Breadth ≥ 4/5 OR Combined ≥ 7/10, flag explicitly — likely an experienced engineer with pre-existing automation skills. Do not treat expert scores in a new user as a data error.

Always state lifetime and flag clearly in output:
> `Usage lifetime: 9 days → 🆕 New User (learning phase — low scores expected)`
> `Usage lifetime: 8 days → 🌟 Early Outlier (expert-level scores in first week)`

---

### Step 4 · Score Usage Breadth (0–5)

Award one point for each criterion met:

| Criterion | Threshold | Why it matters |
|---|---|---|
| Script-level editing | `edit_script > 10` | Post-recorder debugging. Cannot add Wait/Verify keywords without opening the script editor. |
| Suite execution | `exec_suite_ev > 0` | Organised test management. Only a positive signal if individual case pass rates are also reasonable. |
| Object Repository discipline | `web_spy > 2` OR `save_captured_web_object > 5` | **The single strongest expert signal.** Replacing recorder XPath with stable selectors eliminates the majority of locator failures. |
| Self-Healing Insights review | `ksu_open_self_healing_insights > 5` | Active debugging. Distinct from SH trigger count, which can indicate a crutch. |
| Sustained execution volume | `exec_actions > 100` | Minimum bar for an active, committed user. |

**Bonus +1 (capped at 5 total):** `edit_script > 100` OR `exec_suite > 20`

> ⚠️ **SA Chat (StudioAssist) is NOT a breadth point by itself.**
> High SA Chat + low edit_script = AI without follow-through — a gap indicator.
> The expert pattern: SA Chat surfaces the issue → user applies the fix to Object Repo + script. Most low-skill users stop after the chat.

---

### Step 5 · Score Execution Outcome (0–5)

| Component | Points | Threshold |
|---|---|---|
| Pass rate — weak | 1 pt | 10–24% |
| Pass rate — moderate | 2 pts | 25–49% |
| Pass rate — strong | 3 pts | ≥ 50% |
| Evidence bonus | +1 | `total_ev ≥ 10` |
| Trajectory bonus | +1 | `pass_ev > fail_ev + err_ev` |

Cap at 5. Always report both total lifetime pass rate and latest identifiable case status by GUID.

**Failure mode inference (root_cause is usually null — infer from patterns):**

| Signal | Most likely cause |
|---|---|
| SH triggered + XPATH substitution attempts | Locator brittleness — recorded selectors are fragile |
| `engine_disconnected` events in ksu_tracks | Recorder / agent instability — separate issue track from locator problems |
| High ERROR share, low FAILED share | Execution not reaching assertion stage — infra or config issue |
| High FAILED share, low ERROR share | Assertions running but failing — test logic or unstable app state |
| High SH trigger + low SH Insights opened | Self-healing as a crutch — locator debt growing, not resolving |

Mark all failure mode inferences as **likely, not confirmed**.

---

### Step 6 · Compute Combined Score and Tier

```
Combined = Breadth + Outcome  (0–10)
```

| Score | Tier |
|---|---|
| 8–10 | Expert / Upper-Intermediate |
| 6–7 | Intermediate |
| 4–5 | Developing |
| 2–3 | Newbie / Inefficient |
| 0–1 | Inactive / Insufficient |

Always report sub-scores separately: `"Breadth 4/5 · Outcome 1/5 → Combined 5/10 (Developing)"`

Apply lifetime context: a New User at 2/10 is "expected — 9 days in." An established user at 2/10 at 90 days is "entrenched pattern — urgent intervention."

---

### Step 7 · Assign a Behavioral Pattern Label

| Label | Signal pattern |
|---|---|
| ✅ **Expert** | Deep Object Repo + strong pass rate + suite org + iterative reruns |
| 🔄 **Stabilization gap** | Good breadth, poor pass rate — SH fires but Object Repo never updated |
| 🤖 **AI without follow-through** | High SA Chat + low edit_script — suggestions not applied to Object Repo |
| 📦 **Volume-led** | Extreme exec volume + minimal web_spy/save_obj — brute-force, not technique |
| 🔁 **Busy but broken** | High exec + near-zero pass rate — rerun loop without investigating failures |
| 🔎 **Suite before pass-gate** | `exec_suite > 0` but individual case pass rates are weak |
| 🌱 **Early recorder-heavy** | Recorder dominant, no script or object work yet |
| 🆕 **New user — learning phase** | < 14 days, low scores expected, no negative inference |
| 🌟 **Early outlier** | < 14 days, expert-level scores — likely experienced engineer |
| 💡 **Small but stable** | Low volume, clean pass rate — scale is the next step |
| 🔇 **Platform-only** | True Platform activity, no Studio breadth |
| 💤 **Non-activated** | Account exists, no meaningful telemetry |

---

### Step 8 · Infer Implied Gaps (Second Analysis Layer)

This is the critical additional layer. Beyond what the telemetry directly shows, every behavioral pattern carries a set of **implied bad practices** — things the user is almost certainly doing wrong that do not appear as a positive signal in the data, but are a predictable consequence of the observed pattern.

For each user, use the pattern label assigned in Step 7 to look up the implied gaps below. Report them as "implied from pattern — not directly confirmed" and recommend resources for each.

---

#### Implied Gap Map by Pattern

**Pattern: 🔄 Stabilization gap (high SH trigger, low pass rate, Object Repo work present)**

Directly observed gap: SH fires but Object Repo locators are not being updated after review.

Implied gaps (very likely even if not visible in telemetry):
- **Not using Wait for Element / Verify Element keywords** — users in the stabilization gap almost never add timing stabilizers. They rely on self-healing to handle dynamic elements rather than guarding the steps with explicit wait keywords. The SH trigger pattern is consistent with timing failures that wait steps would prevent.
- **Using absolute XPath from the recorder as the default locator** — even when Web Spy and Object Repo are being used, new objects captured under time pressure often retain the recorder-generated XPath rather than being switched to stable id/name/data-* attributes before saving.
- **Not using the SH Insights "Approve" action to permanently update the Object Repo** — SH Insights shows a working alternative locator but has an explicit "Approve" button that updates the Object Repo record permanently. Most users review the insight but miss this button, meaning the alternative runs transiently rather than becoming the new default.

Docs reference: [Self-healing tests in Katalon Studio](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio) — the approve/update flow is documented in the "Approve self-healing locators" section.

---

**Pattern: 🔁 Busy but broken (high exec volume, near-zero pass rate, minimal Object Repo work)**

Directly observed gap: Rerun loop without investigation. No Object Repo discipline.

Implied gaps:
- **No Wait for Element steps at all** — this user's test steps are executing immediately against elements that may not be loaded, visible, or clickable yet. Every interaction step is a potential timing failure. Without a single Wait keyword in the flow, even a fully stabilized locator will fail on a slow page load.
- **Recorded locators are raw absolute XPath** — the absence of any save_captured_web_object activity confirms the recorder's output has never been touched. Recorder-generated XPath like `//div[3]/table/tbody/tr[2]/td[1]` will break on any DOM change including routine UI updates.
- **No use of the Test Case debugger** — users in this pattern execute full runs and interpret the outcome as pass/fail without stepping through the case to identify the exact failing step. The Katalon Studio debugger (breakpoints, step-through, variable inspector) would locate the failure in minutes. Not using it is why the rerun loop is so long.
- **No use of the Console log or Execution Log viewer** — same root cause as above. The execution log shows which step failed and what the element state was. Users in this pattern typically look at the final PASSED/FAILED status and miss the per-step detail.

Docs reference: [Debug a test case in Katalon Studio](https://docs.katalon.com/katalon-studio/debug-a-test-case/debug-a-test-case-in-katalon-studio)

---

**Pattern: 🤖 AI without follow-through (high SA Chat, low edit_script)**

Directly observed gap: SA Chat used but suggestions not applied to Object Repo or script.

Implied gaps:
- **Applying SA Chat fixes at the test step level only, not the object/script level** — the most common failure mode. SA Chat suggests replacing a locator; the user edits the test step directly rather than updating the Object Repository. The test step fix is temporary — it applies to one step in one test case. The Object Repo fix is permanent — it propagates to every test case using that object.
- **Not using SA Chat for "explain this failure" prompts** — SA Chat can analyze a failed step and explain why it failed with a suggested fix. Most users in this pattern use SA Chat to generate or modify code but not to analyze failures. This is the highest-ROI SA Chat use case for a struggling user.
- **Not using the "Generate test case from description" feature** — users with low breadth who rely heavily on SA Chat often don't know about the test case generation capability, which would reduce recorder dependency and produce more maintainable test structures.

Academy reference: [Unlocking AI power with Katalon StudioAssist: Use cases and best practices](https://academy.katalon.com/courses/katalon-studioassist-use-cases-and-best-practices/) — specifically the section on using SA Chat for failure analysis, not just code generation.

---

**Pattern: 🌱 Early recorder-heavy (recorder dominant, no script/object work)**

Directly observed gap: No post-recorder stabilization. No Object Repo work. No script editing.

Implied gaps:
- **Treating recorder output as production-ready** — the recorder is a drafting tool. Every professional Katalon workflow treats the recorder output as a starting point that requires editing. Users who run recorder output directly as tests will accumulate failures as the application changes.
- **No understanding of test object management** — recorder-heavy users typically do not know that Katalon separates test logic (the test case) from element definitions (Object Repository). This is a conceptual gap, not just a feature gap. They edit the test step when they should be editing the object.
- **Not using Spy Web at all** — Web Spy is the correct tool for capturing elements that need to be stable across test runs. Recorder-heavy users capture elements implicitly during recording; they do not capture them deliberately for maintenance purposes.
- **Likely not setting up Execution Profiles** — users who have not moved beyond recording typically run all tests against one environment (their own machine, one URL, hardcoded credentials). As they scale, the absence of Execution Profiles for dev/staging/prod environments will cause credential and URL management failures.

Academy reference: [Boosting test efficiency with execution profiles in Katalon Studio](https://academy.katalon.com/courses/execution-profiles-in-katalon-studio/) — addresses the environment management gap that recorder-heavy users hit when they scale.

---

**Pattern: 🔎 Suite before pass-gate (suite execution with weak individual case pass rates)**

Directly observed gap: Running suites of fragile cases — amplifying failure count without improving stability.

Implied gaps:
- **No pass-gate discipline** — the user has not established a rule for when a test case is "ready" to enter a suite. Without an explicit criterion (e.g., two consecutive clean passes without SH firing), fragile cases enter suites and corrupt suite-level reporting.
- **Not using Test Suite Collection for parallel vs. sequential execution control** — users running suites often run them in the wrong mode. Parallel execution on fragile tests multiplies failures and makes root-cause analysis much harder. Sequential execution should be the default until cases are stable.
- **Suite reports are masking case-level failure detail** — suite-level pass/fail statistics hide which individual case is failing and on which step. The user may be interpreting suite results without drilling into per-case execution logs.
- **Not using Test Listeners to capture teardown state** — when a suite run fails partway through, the browser/app may be left in a broken state that causes the next case to fail for reasons unrelated to its own test logic. Test Listeners with proper teardown prevent this cascade.

Academy reference: [Enhancing test execution efficiency with Test Listener in Katalon Studio](https://academy.katalon.com/courses/test-listener/) — addresses teardown and state management in suite execution.

---

**Pattern: 📦 Volume-led (extreme exec volume, minimal Object Repo / Spy work)**

Directly observed gap: Brute-force execution without technique. Scale without stability.

Implied gaps:
- **No locator strategy** — at high exec volume, the absence of any save_captured_web_object activity means every test case is using whatever the recorder generated. At this scale, even a minor UI update cascades into hundreds of locator failures with no systematic way to fix them.
- **No test data separation** — high-volume users who have never touched Execution Profiles or data-driven testing are almost certainly hardcoding test data (URLs, usernames, passwords, IDs) in test steps. This creates a maintenance debt that grows with scale.
- **No CI/CD integration awareness** — users at this execution volume are typically ready for CI/CD integration but have not set it up. They are running tests manually at a frequency that would justify a pipeline. The Katalon Runtime Engine and TestOps integration would transform this workflow.
- **Not using Test Suite Collections for parallel execution** — at this exec volume, running sequentially is a bottleneck. Parallel execution via Test Suite Collections or TestCloud would significantly reduce execution time.

Academy reference: [Extending Test Executions with Katalon Runtime Engine & Command Line Interface](https://academy.katalon.com/courses/katalon-runtime-engine/) — the natural next step for a high-volume user who is still running tests manually.

---

**Pattern: ✅ Expert (high breadth + strong pass rate)**

Directly observed: Strong on both axes. No acute gaps.

Implied gaps / growth opportunities (frame as "what comes next," not deficiencies):
- **Not yet using BDD / Cucumber integration** — expert-level Studio users who have not adopted BDD are missing a collaboration layer that connects test cases to business requirements. This becomes relevant at scale when QA needs to communicate test coverage to non-technical stakeholders.
- **Not yet connecting Studio to True Platform analytics** — even expert Studio users often have low True Platform analytics engagement. The Release Dashboard and Test Planning views provide the ROI visibility that supports a purchase decision.
- **Not yet using Custom Keywords for repeated test logic** — experts who are editing scripts extensively but have not created custom keywords yet are duplicating logic across test cases. Custom keywords reduce maintenance surface significantly at scale.
- **Certification not yet formalised** — the Katalon Certification Program provides a verifiable credential for the skills already demonstrated in the telemetry. Frame this as career benefit, not remediation.

---

**Pattern: 🆕 New User — Learning Phase**

Implied gaps (educational gaps, not bad habits — frame constructively):
- **May not know that Object Repository exists as a separate concept from test cases** — new users coming from manual testing or simpler tools often do not understand the separation between test logic and element definitions. Explain this as a feature, not a correction.
- **May be recording every test from scratch instead of using Call Test Case for reuse** — duplication of recorded logic is invisible in the telemetry but is a near-universal new-user pattern. Reusability concepts should be introduced early.
- **Likely has not installed the browser extension correctly or verified agent version** — engine_disconnected events in new users are almost always setup issues, not app issues. Point them to the setup verification checklist before any troubleshooting.

Academy reference: [A hands-on guide to kickstart your test automation journey](https://academy.katalon.com/courses/hands-on-guide-to-kickstart-test-automation/) — covers setup, first recording, and Object Repository concepts in one beginner session.

---

### Step 9 · Determine Next Action

Select the primary action based on tier + lifetime + pattern:

| Condition | Action |
|---|---|
| New user, any score | `🆕 Onboard` — do not push coaching. Share the New User learning path. Verify agent/browser setup. Goal: first stable passing test case. |
| Early outlier | `🌟 Fast-track` — skip onboarding content. Jump to Object Repo and script editing resources. |
| Expert / Upper-Intermediate | `🔴 Convert` — near purchase-ready. Frame ROI around current pass rate trend and True Platform analytics value. |
| Intermediate, breadth strong, outcome weak | `🟠 Stabilize → Convert` — Object Repo locator debt review + SH Insights approve loop + pass-gate discipline. 1–2 sessions. |
| Intermediate, outcome strong, breadth weak | `🟠 Scale → Convert` — introduce suite organisation, Object Repo, script editing. |
| Intermediate, both moderate | `🟠 Coach → Convert` — identify the lower dimension and target it first. |
| Developing, breadth strong, outcome weak | `🚨 Rescue — Technique` — stop re-running, open SH Insights, approve the better selector to Object Repo, add Wait/Verify steps. |
| Developing, both weak | `🟡 Build Fundamentals` — record → stabilize one case → pass-gate → suite. No feature breadth push before stability. |
| Newbie / Inefficient, high volume | `🚨 Rescue — Volume with no return` — stop mass re-execution. Open the debugger. Fix one case completely before creating another. |
| Inactive / Insufficient | `♻️ Re-activate` — guided first-session + agent/browser setup verification. Not a coaching case yet. |

Always include: (a) the specific Katalon mechanic (menu, keyword, workflow step), and (b) a measurable target (e.g., "reduce SH trigger count by 50%" or "first clean PASSED run on case X").

---

### Step 10 · Recommend Learning Resources

Recommend **2–4 resources per gap layer** — one set for the directly observed gap, one set for the implied gaps. Total recommendation cap: 6 resources. Always include a one-line reason why each resource addresses the specific gap observed.

#### Resource Map by Skill Gap

**First steps / new user**
- 📘 [Leveling up from a manual tester to an automation beginner](https://academy.katalon.com/learning-path/fresher-automation-engineer/) — Learning Path · Beginner · 10h 35m · 13 courses · The structured entry point for anyone new to Katalon Studio
- 📘 [A hands-on guide to kickstart your test automation journey](https://academy.katalon.com/courses/hands-on-guide-to-kickstart-test-automation/) — Course · Beginner · 55m · Fast first-session guide covering setup, recording, and first run
- 📘 [Overcoming common challenges for test automation beginners](https://academy.katalon.com/courses/common-challenges-for-test-automation-beginners/) — Course · Beginner · 1h 55m · Directly addresses the exact failure patterns new users encounter

**Object Repository / locator management** ← most common gap
- 📘 [Test Authoring With Katalon: Creating and Maintaining Test Objects](https://academy.katalon.com/courses/creating-test-objects/) — Course · covers Spy Web, Object Repo, and self-healing together in one course
- 📘 [Test Authoring with Katalon: Parameterizing Test Objects](https://academy.katalon.com/courses/parameterize-test-objects/) — Course · Intermediate · 1h 05m · Dynamic locators and runtime object management
- 📘 [Creating and Modifying Test Objects During Runtime](https://academy.katalon.com/courses/creating-and-modifying-test-object-during-runtime/) — Course · Intermediate · 1h 15m · Advanced object techniques
- 📗 [Creating reliable test objects in Katalon Studio](https://docs.katalon.com/katalon-studio/test-objects/creating-reliable-test-objects-in-katalon-studio) — Docs · Best practices for stable locators (id, name, data-* vs brittle XPath)
- 📗 [Web test objects — manage and edit](https://docs.katalon.com/katalon-studio/test-objects/web-test-objects/manage-web-test-objects) — Docs · Reference for managing and editing web test objects

**Self-healing — using it as a diagnostic, not a crutch**
- 📘 [Self-Healing Mechanism in Test Automation](https://academy.katalon.com/courses/self-healing-testing/) — Course · covers SH Insights review, the Approve flow for permanent Object Repo updates, and locator priority configuration
- 📘 [Katalon Recorder: Handling Test Objects with Minimal Maintenance](https://academy.katalon.com/courses/katalon-recorder-self-healing/) — Course · Beginner · 1h 05m · Self-healing in the recorder context
- 📗 [Self-healing tests in Katalon Studio](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio) — Docs · Classic SH and AI Self-Healing (v11+), locator priority, and the approve/update flow
- 📗 [Fix broken web test objects with Time Capsule](https://docs.katalon.com/katalon-studio/maintain-tests/fix-broken-web-test-objects-with-time-capsule-in-katalon-studio) — Docs · Time Capsule for reverting to a working test object state

**Script editing / post-recorder stabilization / debugging**
- 📘 [Katalon Studio: Debugging and handling errors effectively](https://academy.katalon.com/courses/debugging-and-handling-error/) — Course · Intermediate · 1h 35m · The direct fix for users who edit steps but not scripts; covers the debugger, breakpoints, and execution log
- 📘 [Creating more effective test scripts with Statements in Katalon Studio](https://academy.katalon.com/courses/statements-in-katalon-studio/) — Course · Intermediate · 2h 30m · Control flow, loops, exception handling in scripts
- 📘 [Creating more effective test scripts with Statements (Part 2)](https://academy.katalon.com/courses/statements-in-katalon-studio-part-2/) — Course · Intermediate · 1h 10m
- 📘 [Programming fundamentals for Script Mode in Katalon Studio](https://academy.katalon.com/courses/programming-fundamentals-for-script-mode-in-katalon-studio/) — Course · Intermediate · 2h 05m · For users moving from visual/manual editing to script mode
- 📗 [Debug a test case in Katalon Studio](https://docs.katalon.com/katalon-studio/debug-a-test-case/debug-a-test-case-in-katalon-studio) — Docs · Breakpoints, step-through, variable inspection

**Test flakiness / stability / 'busy but broken' pattern**
- 📘 [Minimizing flakiness for reliable test automation with Katalon Studio](https://academy.katalon.com/courses/minimizing-test-flakiness/) — Course · Intermediate · 1h 12m · 6 chapters · Directly addresses the flaky test and rerun loop problem
- 📗 [Introduction to test maintenance](https://docs.katalon.com/katalon-studio/maintain-tests/introduction-to-test-maintenance) — Docs · Overview of all maintenance tools in Studio
- 📗 [Suggested solutions for keyword errors](https://docs.katalon.com/katalon-studio/maintain-tests/suggested-solutions-for-keyword-errors) — Docs · Per-error guidance for the most common failure types

**Suite organisation, test listeners, teardown**
- 📘 [Enhancing test execution efficiency with Test Listener in Katalon Studio](https://academy.katalon.com/courses/test-listener/) — Course · Intermediate · 1h 30m · Teardown, state management, and cascading failure prevention in suite runs
- 📘 [Increasing Test Reusability for Better Productivity and Reduced Maintenance](https://academy.katalon.com/courses/test-reusability/) — Course · test reuse patterns that enable stable suite organisation
- 📗 [Execute tests](https://docs.katalon.com/katalon-studio/execute-tests/how-to-execute-test-cases) — Docs · Test suite and test suite collection execution reference

**Execution profiles / environment management**
- 📘 [Boosting test efficiency with execution profiles in Katalon Studio](https://academy.katalon.com/courses/execution-profiles-in-katalon-studio/) — Course · Beginner · 35m · Environment switching, hardcoded value elimination — the highest-ROI 35-minute course for scaling users
- 📗 [Data-driven testing with Katalon Studio](https://docs.katalon.com/katalon-studio/data-driven-testing/data-driven-testing-with-katalon-studio) — Docs

**Data-driven testing**
- 📘 [Data-driven testing with Katalon: Advanced use cases](https://academy.katalon.com/courses/data-driven-testing-advanced/) — Course · Intermediate · 1h 35m

**StudioAssist / AI — using it with follow-through (not just code generation)**
- 📘 [Katalon StudioAssist: Accelerating daily automation with an AI assistant](https://academy.katalon.com/courses/ai-assistant/) — Course · All levels · 1h 10m · Core SA Chat usage patterns including failure analysis prompts
- 📘 [Unlocking AI power with Katalon StudioAssist: Use cases and best practices](https://academy.katalon.com/courses/katalon-studioassist-use-cases-and-best-practices/) — Course · Intermediate · 1h 55m · 514 enrollments · Specifically covers the gap between AI suggestion and Object Repo application
- 📗 [Katalon AI Assistant (StudioAssist) overview](https://docs.katalon.com/katalon-studio/studioassist/studioassist-overview) — Docs · Feature reference including MCP server integration (v11+)

**Dynamic elements / frames / complex UI**
- 📘 [Handling Frames and iFrames Using Katalon Studio](https://academy.katalon.com/courses/frames-and-iframes/) — Course · Beginner · 45m · A common cause of locator failures not visible in the data
- 📘 [Test Authoring With Katalon: Handling Alert Popups, Dialog Boxes, and Dropdown Lists](https://academy.katalon.com/courses/alert-popups-dialog-boxes-dropdown-lists/) — Course · Beginner · 1h 10m

**Custom keywords / advanced scripting**
- 📘 [Custom keywords in Katalon Studio: Automate smarter, scale faster](https://academy.katalon.com/courses/custom-keywords-in-katalon-studio/) — Course · All levels · 1h 38m · Addresses duplicated logic across test cases in high-volume users
- 📗 [Introduction to custom keywords](https://docs.katalon.com/katalon-studio/keywords/custom-keywords/introduction-to-custom-keywords-in-katalon-studio) — Docs

**CI/CD integration / Runtime Engine (volume-led users ready to scale)**
- 📘 [Extending Test Executions with Katalon Runtime Engine & Command Line Interface](https://academy.katalon.com/courses/katalon-runtime-engine/) — Course · Intermediate · 48m · The natural next step for high-volume users still running tests manually
- 📘 [Tips to speed up test executions in Katalon Studio](https://academy.katalon.com/courses/speed-up-test-executions-in-katalon-studio/) — Course · Intermediate · 57m

**BDD / Cucumber (expert users moving to requirements-linked testing)**
- 📘 [Boosting test automation efficiency with Behavior-Driven Development (BDD)](https://academy.katalon.com/courses/behavior-driven-development/) — Course · All levels · 1h 10m
- 📘 [Implementing the BDD framework seamlessly with Katalon Studio](https://academy.katalon.com/courses/implement-behavior-driven-development-bdd/) — Course · All levels · 1h 25m
- 📘 [Boosting BDD efficiency and scalability in Katalon Studio](https://academy.katalon.com/courses/efficient-bdd/) — Course · All levels · 1h 22m

**True Platform adoption (platform-only users or Studio users not using TestOps)**
- 📘 [Getting started with Katalon True Platform](https://academy.katalon.com/courses/getting-started-with-katalon-true-platform/) — Course · All levels · 50m · The entry point for any Studio user not yet using the platform
- 📘 [Katalon TestOps: Understanding the administration structure](https://academy.katalon.com/courses/katalon-testops-admin-structure/) — Course · All levels · 30m

**Certification (Expert users ready to formalise)**
- 📘 [Fast track to achieve the Katalon Practitioner Certification](https://academy.katalon.com/learning-path/practitioner-certification-fast-track/) — Learning Path · Beginner · 2h 15m
- 📘 [Fast track to achieve the Katalon Professional Certification](https://academy.katalon.com/learning-path/professional-certification-fast-track/) — Learning Path · Intermediate · 7h 06m
- 📘 [Fast track to achieve the AI-skilled practitioner certification](https://academy.katalon.com/learning-path/ai-practitioner-certification-fast-track/) — Learning Path · All levels · 10h 26m
- 📘 [Katalon Certification Program](https://academy.katalon.com/certifications/) — Overview of all certification tracks

---

### Step 11 · Output the Assessment

Output these 11 fields in this order every time:

1. **VERDICT** — one sentence: tier + lifetime context + pattern label
2. **SCORES** — Breadth X/5 · Outcome Y/5 · Combined Z/10
3. **LIFETIME CONTEXT** — days active, lifetime flag (New / Active / Established / Early Outlier), what it implies for the scores
4. **BREADTH EVIDENCE** — top 5 feature signals with counts
5. **OUTCOME EVIDENCE** — pass/fail/error counts, latest case status by GUID, SH signals
6. **TRUE PLATFORM** — runs, analytics, AI interactions (omit if not observed, note explicitly)
7. **FAILURE MODE INFERENCE** — locator / agent / logic, with evidence basis and confidence level
8. **SUPPORT SIGNAL** — cases found, or: "Not observed in dm_support.fact_case."
9. **DIRECTLY OBSERVED GAPS** — gaps confirmed by telemetry signals with evidence
10. **IMPLIED GAPS** — bad practices the pattern strongly suggests but that are not directly visible in the telemetry; label each as "implied from [pattern name] — not confirmed"
11. **NEXT ACTION + RESOURCES** — action label, specific Katalon mechanic, measurable target, then 2–4 resources split across observed and implied gaps with one-line reason each

> Start every reply by naming the tables used.

---

## Behavioral Pattern: Interpretation Guides

### The Stabilization Gap
**What it looks like:** Breadth 3–5/5, Outcome 0–2/5. SH triggers high. SH Insights opened. Pass rate stuck below 30%.
**Root cause:** User opens SH Insights but skips the Approve step that permanently updates the Object Repo default locator. Same element triggers SH on every run.
**Correct loop:** SH triggers → open SH Insights → click Approve on the working alternative → Object Repo is updated → trigger stops on that element.

### Busy but Broken
**What it looks like:** High total_ev (100+), pass rate near 0%, SH triggered, SH Insights rarely opened, Object Repo near zero.
**Root cause:** Rerunning without investigating. Volume treated as progress.
**Correct intervention:** Stop re-execution. Open the debugger. Step through one failing case. Fix the locator. Add Wait/Verify. Get one clean pass before creating a second test case.

### AI Without Follow-Through
**What it looks like:** SA Chat count high (50+), edit_script low (<20), pass rate weak.
**Root cause:** SA Chat suggestions applied at the test step level rather than the Object Repository level. Step-level fixes are temporary; Object Repo fixes propagate everywhere.
**Correct intervention:** After every SA Chat locator suggestion: open Object Repository → replace the default locator → save → re-run.

### New User — Learning Phase
**What it looks like:** < 14 days. Low breadth and outcome scores.
**Hypothesis:** Expected. Do not infer persistent gaps. Look for positive micro-signals: any exec_actions, any SA Chat attempts, any Spy events. Absence of these in the first 14 days suggests a setup/onboarding problem, not a skill gap.

---

## Three-Layer Count Discrepancy

Always distinguish and report all three if they diverge:

1. **Creation action count** — `fact_trial_user_core_actions` — activity counts, not distinct cases
2. **Raw create events** — `ksu_new_test_case` — event count, may not carry usable GUIDs
3. **Identifiable executed GUIDs** — `ksu_execute_test_case` — cases with linkable execution history

Gap = created-but-never-executed or non-linkable cases. Always state as a data limitation, not a problem to diagnose.

---

## Common Pitfalls

**Do not use standard tier labels for new users (<14 days) without lifetime qualification.** A new user at Combined 2/10 is "New — learning phase." A rescue intervention on day 3 of a trial is counterproductive.

**Do not treat SA Chat volume as a breadth signal without paired edit_script depth.** High SA Chat + low edit_script = gap indicator.

**Do not treat SH trigger count as positive.** High `self_healing_triggered` without `ksu_open_self_healing_insights` = crutch pattern. Declining trigger trend is the positive signal.

**Do not infer breadth from execution volume alone.** 8,000 exec events + 0 Object Repo work = volume-led, not Expert.

**Do not collapse the three count layers.** `creation_action_count ≠ raw_create_events ≠ identifiable_executed_GUIDs`.

**Do not treat suite execution as inherently expert.** Running suites of fragile cases amplifies failure count without improving stability.

**Do not treat missing warehouse signal as inactive.** Null core Studio metrics = likely non-activated (setup issue), not low-skill.

**Do not mix Studio and True Platform evidence without labeling the source system.**

**Do not call someone Expert if pass rate is low.** Breadth 5/5 + Outcome 0/5 = Developing.

**Do not recommend advanced resources to a new user.** A user on day 3 needs the kickstart guide, not the debugging course.

**Do not present implied gaps with the same confidence as directly observed gaps.** Always label implied gaps as "implied from [pattern] — not confirmed in telemetry."

---

## Quick Reference

### Tier Map with Lifetime Notes

| Score | Tier | Lifetime note |
|---|---|---|
| 8–10 | Expert / Upper-Intermediate | Flag as Early Outlier if < 14 days |
| 6–7 | Intermediate | Achievable with 1–2 targeted sessions |
| 4–5 | Developing | Technique gaps. Standard coaching |
| 2–3 | Newbie / Inefficient | If >60 days: entrenched. If <14 days: adjust label |
| 0–1 | Inactive / Insufficient | Onboarding/re-activation first |

### Lifetime Flags

| Flag | Condition | Effect |
|---|---|---|
| 🆕 New User | < 14 days | Append to tier. Low scores expected. Onboarding action. |
| 🌟 Early Outlier | < 14 days + Breadth ≥ 4 or Combined ≥ 7 | Flag explicitly. Fast-track resources. |
| (none) | 14–60 days | Standard output |
| ⚠️ Established + low | > 60 days + Combined < 4 | Increase urgency. Rescue or fundamentals |

### Pattern Labels

| Label | One-line description |
|---|---|
| ✅ Expert | Deep Object Repo + strong pass rate + suite org + iterative reruns |
| 🔄 Stabilization gap | Breadth strong, SH fires but Object Repo Approve never clicked |
| 🤖 AI without follow-through | High SA Chat, low edit_script, fixes not applied to Object Repo |
| 📦 Volume-led | Extreme exec volume, minimal Object Repo work |
| 🔁 Busy but broken | High exec, near-zero pass rate, rerun loop without investigation |
| 🔎 Suite before pass-gate | Suite execution before individual cases are stable |
| 🌱 Early recorder-heavy | Recorder dominant, no script or object work yet |
| 🆕 New user — learning phase | < 14 days, low scores expected |
| 🌟 Early outlier | < 14 days, expert-level scores |
| 💡 Small but stable | Low volume, clean pass rate — scale is next |
| 🔇 Platform-only | True Platform activity, no Studio breadth |
| 💤 Non-activated | Account mapped, no meaningful telemetry |
