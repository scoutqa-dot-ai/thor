# codex-lb multi-subscription routing

## Goal

Route Thor's OpenCode model traffic through a self-hosted `codex-lb` service so operators can pool multiple ChatGPT/Codex subscriptions without placing their OAuth credentials in OpenCode.

## Phases

### Phase 1 — Runtime and provider wiring

- Add the pinned `codex-lb` container, persistent data volume, loopback-only direct ports, and readiness gate.
- Configure OpenCode's built-in `openai` provider to use the codex-lb Responses-compatible endpoint with the same private-CIDR placeholder-key pattern as `katalon-internal/thor`.
- Route codex-lb egress through mitmproxy with the public CA mounted, and remove direct OpenAI authentication from the documented runtime path.
- Route codex-lb dashboard paths through the existing port-8080 ingress behind Vouch and `THOR_ADMIN_EMAILS`.
- Keep Core E2E's non-production OpenCode auth fixture by removing the codex-lb provider override only inside CI, matching `katalon-internal/thor`.

Exit criteria:

- Compose renders with OpenCode depending on a healthy codex-lb service.
- OpenCode's configured provider resolves the Compose-supplied `http://codex-lb:2455/v1` endpoint and non-secret `codex-lb-local` placeholder.
- The dashboard is available at `/dashboard` through authenticated ingress without publishing port 2455 externally.
- Core E2E can boot without a codex-lb account and retain its opt-in direct-OpenAI LLM smoke.

### Phase 2 — Operator and security documentation

- Document first-run account onboarding, ingress/callback behavior, routing, backups, upgrades, and rollback.
- Update the architecture, deployment-variable, and security-boundary documentation.
- Verify formatting, Compose rendering, config parsing, and the repository's local checks.

Exit criteria:

- An operator can add multiple subscriptions through the port-8080 ingress and reconnect OpenCode using only the checked-in instructions.
- The docs identify the codex-lb volume as secret state and explain continuation affinity, ingress exposure, and the private-CIDR placeholder-key boundary.
- Required local checks pass, or environmental blockers are recorded with concrete output.

## Decision log

| #   | Decision                                                                  | Rationale                                                                                                                                                                                     | Rejected                                                                                               |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Run codex-lb as a separate Compose service from its published image       | It owns a Python/Rust/frontend runtime and persistent database independently of Thor's Node images.                                                                                           | Vendor it into Thor's multi-stage Dockerfile.                                                          |
| 2   | Pin stable `v1.24.0` and its OCI digest                                   | A tag documents the upstream release while the digest prevents silent image replacement.                                                                                                      | `latest`; beta releases; building moving `main`.                                                       |
| 3   | Use OpenCode's built-in `openai` provider with a `baseURL` override       | This keeps the Responses API path and preserves encrypted reasoning state across turns, as required by codex-lb's OpenCode guide.                                                             | `@ai-sdk/openai-compatible`, which uses Chat Completions and loses reasoning state.                    |
| 4   | Use a non-secret placeholder key plus private-CIDR proxy access           | This copies `katalon-internal/thor`: OpenCode's client requires a non-empty key, while codex-lb admits private Docker callers without provisioning a real key.                                | Putting subscription OAuth tokens in OpenCode; maintaining a separate client-key bootstrap flow.       |
| 5   | Keep direct ports on loopback and expose dashboard routes through ingress | Port 8080 already owns office access, Vouch, and the admin-email gate; publishing 2455 directly would bypass that boundary.                                                                   | Bind 2455 to `0.0.0.0`; move ingress off 8080.                                                         |
| 6   | Route codex-lb upstream traffic through mitmproxy                         | This matches the referenced deployment's centralized egress policy. Mounting the public CA handles mitmproxy's intercepted TLS.                                                               | Direct codex-lb egress.                                                                                |
| 7   | Remove the codex-lb provider override only in Core E2E                    | CI has no pooled accounts and already owns a non-production OpenCode OAuth fixture. This keeps model smoke working without static rotating codex-lb account tokens.                           | Ephemeral codex-lb account imports; separately operated CI codex-lb.                                   |
| 8   | Generate a strict-X.509-compatible mitmproxy CA                           | codex-lb's Python/OpenSSL runtime requires critical CA basic constraints and key-cert-sign usage during intercepted OAuth/token TLS.                                                          | Disable TLS verification; bypass centralized egress for OAuth.                                         |
| 9   | Enable codex-lb's live model registry                                     | OpenAI emits plan identifiers such as `self_serve_business_prolite` that v1.24.0's bundled model metadata does not recognize; per-account catalogs provide authoritative capability evidence. | Keep the static registry and reject otherwise valid subscriptions; patch codex-lb's database or image. |

## Out of scope

- Scaling codex-lb beyond one replica or migrating it to PostgreSQL.
- Enabling codex-lb's own dashboard password/TOTP in addition to ingress Vouch.
- Automating production account onboarding.
- Guaranteeing failover for account-bound continuation state; fresh sessions can use another healthy subscription, while hard-affinity continuations may fail closed.
- Changing Thor's model-selection or per-session reasoning policy beyond the existing GPT-5.6 configuration.
