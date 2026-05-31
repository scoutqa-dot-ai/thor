# Profiles

Stable contract for Thor routing profiles. Profiles choose integration credential targets; they are not agent-facing commands, work-routing policy, or per-profile tool policy.

For Slack admission details, see [`../slack.md`](../slack.md). For the remote-cli trust boundary, see [`security-model.md`](./security-model.md).

## Invariants

- A profile must define `channels[]`, `repos[]`, or both.
- Profile names use uppercase ASCII letters and underscores only. The name is also the environment suffix, such as `POSTHOG_API_KEY_QA`.
- Each Slack channel id and each repo name can belong to only one profile.
- `channels[]` selects a credential profile and admits gated Slack surfaces: private channels, DMs, group DMs, and Slack Connect/shared channels.
- `repos[]` selects a credential profile from the trigger-stamped repo alias. It never admits a gated Slack surface.
- Profile resolution reads only session-bound aliases: `slack.thread` aliases and runner-stamped `repo` aliases. MCP request bodies and current working directory are not trusted profile inputs. Per-channel repo override files can influence future runner-stamped repo aliases, but MCP does not re-read them live.
- Slack channel profile is authoritative. A repo may fill in only when the Slack channel signal is silent or unprofiled under the rules below.
- Channel/repo disagreement fails closed instead of choosing one side.

## Config

```json
{
  "profiles": {
    "QA": {
      "channels": ["C0123456789"],
      "repos": ["qa-sandbox"]
    },
    "CRON": {
      "repos": ["nightly-jobs"]
    },
    "SUPPORT": {
      "channels": ["G0123456789"]
    }
  }
}
```

Single-value integrations check the profile-suffixed environment variable first, then the unsuffixed global. For example, `POSTHOG_API_KEY_QA` is preferred over `POSTHOG_API_KEY` for profile `QA`. Grafana is a bundle: if any `GRAFANA_*_<PROFILE>` value is set, the profile URL and token must both be set.

Atlassian profile support is not first class yet. MCP calls can resolve `ATLASSIAN_AUTH_<PROFILE>` before falling back to `ATLASSIAN_AUTH`, but direct Jira/Atlassian HTTP egress through mitmproxy still uses the unsuffixed global `ATLASSIAN_AUTH` because mitmproxy is not profile-aware. Treat Atlassian profile suffixes as best-effort MCP routing until a later mitmproxy profile-routing update lands.

## Resolution

1. Resolve the session anchor from `x-thor-session-id`.
2. Enumerate all `slack.thread` aliases on the anchor.
3. Enumerate all `repo` aliases stamped on the anchor at trigger time.
4. Collapse each dimension independently. Multiple profiles, or a mix of profiled and unprofiled values in the same dimension, fail closed.
5. If a Slack channel profile exists, use it.
6. If a repo profile also exists and differs from the Slack profile, fail closed.
7. If no Slack binding exists, use the repo profile when present. This covers cron and other non-Slack sessions.
8. If Slack bindings exist but none are in a profile, allow repo fallback only when the repo resolves to a repo-only profile.
9. If Slack bindings exist but none are in a profile, block repo fallback into a mixed `channels[]` + `repos[]` profile.

## Profile Shapes

| Shape                    | Intended use                                          | Slack behavior                                                                                                             | Non-Slack behavior                       |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `channels[]` only        | Slack team or surface profile                         | Listed channels select the profile; unlisted gated channels are dropped                                                    | Cannot be selected by repo               |
| `repos[]` only           | Repo-scoped convenience profile, including cron       | Public unlisted channels may use it through their stamped repo; gated channels still need `channels[]` admission elsewhere | Sessions in that repo select the profile |
| `channels[]` + `repos[]` | Team profile tied to both Slack surface and repo work | Listed channels select it; unlisted public channels cannot borrow it through repo fallback                                 | Sessions in that repo select the profile |

## Expected Outcomes

| Scenario                                                                        | Outcome                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Public channel outside profiles, no profiled repo                               | Accepted by Slack gate; MCP uses unsuffixed globals         |
| Public channel outside profiles, repo-only profile                              | Accepted by Slack gate; MCP uses the repo profile           |
| Public channel outside profiles, mixed channel+repo profile                     | Accepted by Slack gate; MCP profile resolution fails closed |
| Public channel listed in a mixed profile, same repo profile                     | Uses that profile                                           |
| Public channel listed in one profile, repo in another                           | Fails closed as a channel/repo conflict                     |
| Private channel, DM, group DM, or shared channel outside all `channels[]` lists | Dropped at Slack admission before runner starts             |
| Cron or other non-Slack session in a profiled repo                              | Uses that repo profile, including mixed profiles            |

## Abuse Cases

- Public channel self-selects a repo-only team-like profile: expected if the profile is repo-only. Use a mixed profile when the Slack surface matters.
- Public channel borrows a mixed profile through an agent-writable repo override: blocked at profile resolution because the channel is not listed in the profile.
- Agent-created cron hop into a profiled repo: expected. Repo-based profile selection exists to support cron and non-Slack sessions.
- Denial via conflict: by design. If an anchor accumulates channels or repos that imply different profiles, MCP fails closed until the session is separated or the profile config changes.
- Repo profile leaks beyond the intended team surface: avoid repo-only profiles for team-scoped credentials. Put the intended Slack channels in the same mixed profile so public unlisted channels cannot borrow it through repo fallback.

## Non-Goals

- Profiles do not choose the working repo. Slack work routing still comes from `SLACK_DEFAULT_REPO` and the per-channel repo override.
- Profiles do not create per-profile MCP tool allowlists or approval policy.
- Profiles do not admit gated Slack surfaces through `repos[]`.
- Profiles are not exposed as a direct agent argument.
