# mitmproxy Default Injection Rules — 2026-04-22-01

> Extends `docs/plan/2026041706_mitmproxy-outbound.md`. The mitmproxy addon
> already supports per-host header injection driven by `config.json`. Thor
> installs always have `ATLASSIAN_AUTH` and `SLACK_BOT_TOKEN` set, so
> opencode should be able to hit Atlassian and Slack URLs (API + file
> downloads) out of the box without every operator copy-pasting the same
> three rules into their workspace config.

## Motivation

Right now opencode can only reach Atlassian/Slack if the operator adds
rules to `/workspace/config.json`. That's:

- Redundant — the env vars are already required by the stack; no install
  works without them. The rules would be identical across every deployment.
- Failure-prone for file downloads — LLMs often hit
  `files.slack.com/...` or `<tenant>.atlassian.net/secure/attachment/...`,
  which only succeed with the auth header. Without a default rule, the
  proxy returns `403 thor_proxy_host_denied` and the LLM has no way to fix
  it.
- Bad DX — contributors shouldn't have to learn `config.json#mitmproxy[]`
  syntax to do basic things.

## Scope

**In scope:**

- Ship a baked-in `DEFAULT_RULES` list in `docker/mitmproxy/rules.py`,
  loaded alongside `DEFAULT_PASSTHROUGH`.
- Rules injected:
  - `host: "api.atlassian.com"` → `Authorization: ${ATLASSIAN_AUTH}`
  - `host_suffix: ".atlassian.net"` → `Authorization: ${ATLASSIAN_AUTH}`
  - `host_suffix: ".slack.com"` → `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- User-defined rules from `config.json` take precedence over defaults
  (first-match-wins, same semantics as today).
- Unit tests in `docker/mitmproxy/test_rules.py` covering:
  - Default rules apply when `config.json#mitmproxy[]` is empty.
  - User rule for the same host overrides the default.
  - Missing env var yields 502 (delegated to existing `interpolate` code).
- Update `docs/examples/workspace-config.example.json` to drop the
  Atlassian example (now a default) and keep the `${ACME_API_KEY}` example
  for "adding your own host."
- README "Adding Credential Rules" section: note which hosts are wired
  by default so operators don't duplicate them.

**Out of scope:**

- `slack-files.com` (signed URLs, no header needed — injecting Bearer
  could confuse the CDN).
- Baking GitHub / any other host. GitHub auth is handled by the `git`/`gh`
  wrappers in `remote-cli`, not by mitmproxy.
- Per-install opt-out flag. Operators who don't want the default can add
  a user rule with the same host and empty headers, or just don't set the
  env var (fails closed with 502 `missing_env`).
- Wildcarding IP literals or non-standard TLDs.

## Target shape

### `docker/mitmproxy/rules.py`

```python
DEFAULT_RULES: list[dict] = [
    {"host": "api.atlassian.com",
     "headers": {"Authorization": "${ATLASSIAN_AUTH}"}},
    {"host_suffix": ".atlassian.net",
     "headers": {"Authorization": "${ATLASSIAN_AUTH}"}},
    {"host_suffix": ".slack.com",
     "headers": {"Authorization": "Bearer ${SLACK_BOT_TOKEN}"}},
]
```

`load_ruleset()` parses user rules from `config.json#mitmproxy[]`, then
appends the default rules (which also go through `Rule` construction for
uniform validation). First-match-wins means user rules for the same host
win — defaults are a fallback, not a mandate.

### Interaction with passthrough

None. Passthrough hosts (Anthropic, OpenAI) are disjoint from the default
injection hosts — no overlap, no conflict.

### Failure modes

- `ATLASSIAN_AUTH` unset and something hits `*.atlassian.net` → 502
  `missing_env` (existing behavior; no new code path).
- `SLACK_BOT_TOKEN` unset and something hits `*.slack.com` → same.
- User adds their own `.slack.com` rule with different auth → their rule
  wins (default is skipped on first match).

## Decision log

| #   | Decision                                                               | Rationale                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Bake defaults in `rules.py` (Python), not a JSON file mounted in       | Parity with `DEFAULT_PASSTHROUGH`. Image is the source of truth for policy that every install wants; `config.json` is for per-install overrides and additions.             |
| D2  | User rules come first in the combined ruleset (first-match-wins)       | Matches the existing ordering semantics. An operator who wants to override Atlassian auth (e.g. a second tenant) writes their own rule; today's behavior stays consistent. |
| D3  | `host_suffix: ".atlassian.net"` over `host: "<tenant>.atlassian.net"`  | Tenant is per-install; suffix covers every tenant. Security scope is identical — ATLASSIAN_AUTH is already tenant-specific.                                                |
| D4  | `host_suffix: ".slack.com"` (covers api/files/hooks/etc.)              | Slack's domains all use `.slack.com`. Suffix catches files.slack.com, api.slack.com, hooks.slack.com, etc. without enumerating.                                            |
| D5  | Skip `slack-files.com` (signed URL host)                               | Signed URLs authenticate via query string. Injecting a Bearer header is a no-op at best and a CDN error at worst.                                                          |
| D6  | Defaults run through `Rule` validation + `interpolate` at request time | No special-casing. If validation logic changes later (readonly semantics, env escaping), defaults inherit it for free.                                                     |

## Phases

### Phase 1 — Default rules + tests + docs

**Tasks:**

- Add `DEFAULT_RULES` constant to `docker/mitmproxy/rules.py`.
- Extend `load_ruleset()` to append defaults after user rules.
- Add unit tests to `docker/mitmproxy/test_rules.py`:
  - Empty config → defaults match for `api.atlassian.com`,
    `foo.atlassian.net`, `files.slack.com`.
  - User rule for `api.atlassian.com` wins over default.
  - `slack-files.com` is NOT covered (deny-by-default still applies).
- Update `docs/examples/workspace-config.example.json` — drop the
  redundant Atlassian rule, keep the acme/posthog examples as-is.
- Update README "Adding Credential Rules" with a "Built-in rules" note.

**Exit criteria:**

- `python3 -m unittest discover docker/mitmproxy/ -v` passes all tests
  including the three new ones.
- `docker compose up -d --force-recreate mitmproxy opencode` starts
  cleanly with an empty `config.json#mitmproxy[]` and
  `docker exec <opencode> node -e 'fetch("https://api.atlassian.com/oauth/me",
{headers:{Accept:"application/json"}}).then(r=>console.log(r.status))'`
  gets a non-403 (i.e. request reaches upstream with auth).
- Same test for `https://slack.com/api/auth.test` returns 200 with the
  bot's own info (confirms Bearer injection).

## Open questions

- Should we also default-inject for `bitbucket.org` / `bitbucket.atlassian.com`?
  No — Bitbucket is not a required Thor dep today. Add later if needed.
- Is there a privacy concern with auto-injecting ATLASSIAN_AUTH on every
  `*.atlassian.net` call including tenants the operator doesn't own? No —
  ATLASSIAN_AUTH is a user-scoped API token, it only authenticates the
  caller's own tenant. Sending it to an unrelated tenant just fails.
