# Neo — Slack runtime completion and visible rebrand

## Goal

The user reports stale Google connection advice despite the broker's real success notification, missing Slack image reading, and requests replacing Thor branding with Neo. Complete these user-visible behaviors without resetting the existing Ubuntu deployment, encrypted Google grants or Pi history.

## Phases (one commit each)

1. **Fresh requester connection state:** give every Pi Slack turn an authenticated, current broker lookup for its trusted requester. Distinguish a stored connection from verified resource access; prior connection-required output is historical after OAuth succeeds. Failure is unknown, never connected. Recheck the original blocked command to request owner approval rather than inventing completed access or replaying an approved/uncertain effect. Test actual Pi model requests against real broker HTTP before/after OAuth, another requester and unavailable broker. Keep existing callback notification; avoid adding an unnecessary second admission channel or automatically replaying the original command.
2. **Slack image reading:** add a real remote-only `read_image` tool and advertise model image capability, using the existing credential-injecting Slack file download workflow. Downloaded images stay in the executor; model receives validated inline raster content, never Slack credentials or an arbitrary URL downloader. Enforce a documented image byte/pixel limit at bounded executor reads (not stat-after-read); identify image type from contents, deny SVG/HTML/malformed/oversized data, and display safe image markers in the viewer. Test actual Responses `input_image`, executor-only access, failure boundaries and container contract. Update Slack guidance and unsupported-capability docs.
3. **Neo visible branding:** replace user/agent-facing Thor names in prompts, skills, messages, active docs, admin/viewer pages, Slack example manifest and web assets. Preserve established technical namespaces, encrypted-state AAD/HMAC, env/header keys, package imports, host policy, deployment project/volumes, paths and history aliases. Document these as legacy compatibility identifiers, not product identity. Existing installed Slack/Google app display names are operator-owned updates, not new apps. Test actual prompts/pages/messages and compatibility contracts; inspect residual references rather than blindly replacing every byte.

## Decision log

| Decision                                                                      | Reason                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh per-turn broker status instead of automatic OAuth callback re-execution | Screenshot confirms stored connection success but model repeats prior failure; current observable state repairs stale reasoning without replaying effects or another durable routing channel. |
| A stored grant is not proof of document access                                | Google refresh/resource permissions are checked only when the owner-approved command executes.                                                                                                |
| Separate `read_image` with remote filesystem input                            | Published Durable text `read` intentionally rejects images; existing authorized Slack download workflow can remain unchanged, avoiding a second credential/download authority.                |
| Runner retains existing progress credentials; image path adds none            | Current runner legitimately owns Slack progress transport. Do not claim it is token-free; executor remains credential-free.                                                                   |
| Neo presentation with legacy technical identifiers                            | Literal renaming of crypto, volumes, project names or headers would disconnect accounts or break the user's existing server. No data reset is authorized.                                     |
| Commit only, no push                                                          | Existing delivery discipline; GitHub gates/PR remain pending, local tests do not establish live account readiness.                                                                            |

## Exit criteria

- Newly connected requester sees fresh broker evidence in the real Pi model input; another user never inherits their connection; unavailable/invalid probes remain unknown.
- Real model requests contain validated image input from an executor-only file; credentials/private URLs do not enter image messages; unsafe formats and resource-limit failures are visible.
- Neo is the visible identity; compatibility identifiers and historical records continue working, with migration guidance for operator-owned app names.
- Per-phase behavior tests pass before the next phase. Final full tests/typechecks/builds, isolated Google/Pi container checks and image/browser verification pass; report any live/CI verification not performed.

## Out of scope

- Replacing Vouch/Google authentication or weakening owner approval.
- Automatic replay of approved mutations, arbitrary image URL fetching, or automatic download of every Slack attachment.
- Renaming the GitHub repository, deployment checkout/project, env/header/package/crypto namespaces or mounted private memory without a separate migration.
- Live account credentials, private mounted deployment data, `.pi/` metadata, new Slack apps or destructive volume operations.

### Phase 1 isolated validation

34 focused real-HTTP/Pi tests and recursive typechecks pass. The real Pi→executor→wrapper→broker integration now proves fresh missing evidence before private OAuth, fresh stored-connection evidence after callback despite the historical failure remaining in the conversation, no grant inheritance for another requester, and no internal secret in model inputs. HTTP status client tests reject redirects, malformed/config/policy/storage failures and distinguish unavailable legacy negatives from current missing state. Callback automatic re-admission is intentionally unnecessary: fresh evidence is loaded on every user/model turn.

Phase 1 complete locally: 69 files / 911 tests, all recursive typechecks/builds passed. Stored broker state is observed afresh, without asserting live resource access. Live diagnostics from the Ubuntu requester are still awaiting operator output; no push/deployment or live credential use.
