---
name: trial-telemetry-assessment
description: Use ONLY when the inbound Slack prompt is from channel C0ASEKELZ1C and someone asks to analyze Katalon Studio or True Platform trial telemetry for a user email or company domain. Identify top features and workflows used during trial, choose the strongest representative in a domain, judge execution effectiveness, infer likely adoption blockers, and classify the account as inactive, exploratory, capable-but-inconsistent, or high-signal from Metabase warehouse data.
---

# Trial Telemetry Assessment

Use this skill to inspect warehouse telemetry for a trial user or domain, separate usage breadth from execution effectiveness, and return a concise classification with evidence.

## When to use

- The inbound Slack prompt is from channel `C0ASEKELZ1C`
- Someone asks what features or workflows a trial user is using
- Someone asks whether a trial user or domain is active, exploratory, effective, or inactive
- Someone asks for likely issues or blockers based on trial telemetry
- Someone gives an email address or company domain and wants a fast usage assessment

Do not use this skill for other Slack channels unless the configuration is intentionally widened in Thor.

## Data sources

Name the source in the first useful reply. Typical source set:

- Metabase `dm_products.stg_users`
- Metabase `dm_products.fact_trial_user_core_actions`
- Metabase `dm_products.fact_ks_user_event_feature_usage`
- Metabase `dm_products.fact_true_platform_user_usage`
- Metabase `dw_events.ksu_execute_test_case`
- Metabase `dw_events.ksu_new_test_case`
- Metabase `dw_events.ksu_tracks`
- Metabase `dm_support.fact_case`

Use only the tables needed for the specific case. Do not imply direct product access when the evidence comes from warehouse tables.

## Workflow

1. **Identify scope**
   - If input is an email, assess that user directly.
   - If input is a domain, enumerate users from `stg_users`, then pick the strongest representative based on observable Studio or True Platform activity.

2. **Establish existence vs activity**
   - Confirm whether the user or domain appears in `stg_users`.
   - Distinguish clearly between:
     - account exists
     - telemetry exists
     - meaningful usage exists

3. **Measure usage breadth**
   - Pull Studio core actions from `fact_trial_user_core_actions`.
   - Pull feature and workflow signals from `fact_ks_user_event_feature_usage` and, when useful, `dw_events.ksu_tracks`.
   - Call out concrete workflow clusters such as:
     - StudioAssist / AI
     - recorder / playback
     - Web Spy / object maintenance
     - script or test-case editing
     - self-healing
     - test data / variable management
   - For True Platform, summarize runs, AI interactions, analytics views, release dashboard views, live monitor views, automation runs, or manual test creation.

4. **Measure execution effectiveness**
   - Use `ksu_execute_test_case` history to separate `PASSED`, `FAILED`, and `ERROR` outcomes.
   - Prefer both total outcome counts and latest identifiable outcomes.
   - Note self-healing volume when present.
   - Interpretation rules:
     - many `ERROR` results usually mean execution instability
     - many `FAILED` results usually mean assertions are running but not passing
     - no execution history means effectiveness is not measurable, not automatically poor

5. **Check support signal**
   - Look for support cases in `dm_support.fact_case`.
   - Phrase absence carefully: `I do not see support cases in accessible warehouse data.`

6. **Classify**
   - Separate two axes:
     - **breadth / expertise**: none, low, low-to-moderate, intermediate, intermediate-to-high, high
     - **effectiveness / success**: not measurable, low, low-to-intermediate, intermediate-low, intermediate, high
   - Common summary labels:
     - inactive / no measurable usage
     - very early exploratory
     - AI-heavy exploration
     - recorder-heavy but unstable
     - active and reasonably broad, but weak pass convergence
     - capable but not yet consistently effective
     - high-signal / high-success benchmark

7. **Infer likely issues carefully**
   - Base the inference on the telemetry pattern, not guesswork.
   - Safe examples:
     - heavy playback + edit loops + low pass rate -> stabilization gap
     - high `ERROR` share + low `FAILED` share -> executions often do not run cleanly end-to-end
     - AI interactions without execution history -> exploration has not converted into repeatable runs yet
   - Mark these as likely issues, not confirmed defects.

## Output shape

Start with source provenance, then give the conclusion first.

Suggested structure:

1. **One-sentence overall read**
2. **Usage breadth**
3. **Run success / effectiveness**
4. **True Platform side** if relevant
5. **Support signal** if checked
6. **Classification**
7. **What this suggests / likely next improvement**

## Response rules

- Be concise but evidence-backed.
- Use exact counts when they materially support the conclusion.
- If signal is thin, say that early and do not over-classify.
- When assessing a domain, explicitly name the representative user and why they were chosen.
- Distinguish:
  - `not observed`
  - `not measurable`
  - `inactive`
- Do not collapse those into the same statement.

## Example labels

- `light-to-moderate exploratory user with some AI-assisted activity, but very little proven execution success`
- `active recorder-heavy Studio user with moderate breadth, but weak execution effectiveness overall`
- `low-signal / inactive domain in accessible telemetry`
- `active and reasonably broad Studio usage, but weak pass convergence`

## Common pitfalls

- Do not treat missing warehouse signal as proof of no real-world usage.
- Do not infer quality from breadth alone.
- Do not infer inactivity when the account merely maps in `stg_users` but telemetry is absent.
- Do not mix Studio and True Platform evidence without labeling which system each claim comes from.
- Do not call someone a power user if breadth is high but pass convergence remains poor.
