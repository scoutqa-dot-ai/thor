# Admin control-plane internal-secret gate

Close the gap where the untrusted `opencode` agent, sharing the default Docker network, can POST directly to `admin:3005` and rewrite `/workspace/config/thor.json` (mitmproxy passthrough + credential-injection rules), bypassing the ingress Vouch SSO gate. The admin app currently trusts the network and only reads `X-Vouch-User` for audit — it never authenticates the caller.

## Goal

`admin` re-validates every `/admin/*` request against `THOR_INTERNAL_SECRET` (the same timing-safe shared secret already gating gateway↔remote-cli). `ingress` injects that secret on the `/admin/` location **after** Vouch + `THOR_ADMIN_EMAILS` have passed, so the operator's browser save keeps working while a direct hit from `opencode` (which has neither the secret nor a Vouch cookie) is rejected with `401`.

Net behavior after the change:

- **Operator, logged in** → browser → ingress (Vouch ✓ + admin-email ✓) → nginx injects secret → admin accepts. Save works.
- **Agent → `admin:3005` directly** → no secret → `401`.
- **Agent → ingress `/admin/`** → blocked at `auth_request` (no cookie), and nginx would overwrite any forged header anyway.

## Decisions

| #   | Decision                                                                                       | Rationale                                                                                                                                                                  | Rejected                                                                               |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Reuse `THOR_INTERNAL_SECRET` + `matchesInternalSecret` + the `x-thor-internal-secret` header   | Identical primitive already protects runner e2e helpers and gateway↔remote-cli; timing-safe; no new secret to provision or rotate.                                         | A new admin-only secret; mTLS between containers (heavier, no existing tooling)        |
| 2   | `ingress` injects the secret via `proxy_set_header` only on the `/admin/` location             | `proxy_set_header` replaces any client value (same mechanism that protects `X-Vouch-User`), and the header is set only after `auth_request` + admin-email map pass.        | Injecting globally (would leak the secret to opencode/codex-lb upstreams)              |
| 3   | Gate **all** `/admin/*` routes, not just the mutating POST                                     | Simpler model ("admin requires the secret, period"); also stops the agent reading the config's host/rule structure. The operator's GET always carries the injected header. | Gating only `POST /admin/config` (leaves config contents readable to a direct caller)  |
| 4   | `loadAdminEnv` reads `THOR_INTERNAL_SECRET` as **required** (`envString`, throws when missing) | Fail-closed: admin must not boot ungated. Matches `loadGatewayEnv`/`loadRemoteCliInternalEnv`.                                                                             | Optional/empty default (would silently disable the gate, recreating the vulnerability) |
| 5   | `/health` stays ungated                                                                        | The compose healthcheck calls `localhost:3005/health` with no header; gating it would wedge the container.                                                                 | Gating everything (breaks the healthcheck)                                             |

## File-level impact

| Path                                      | Change                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/service-env.ts`      | `loadAdminEnv` returns `thorInternalSecret` (required via `envString`)                                                        |
| `packages/admin/src/app.ts`               | `AdminAppConfig.internalSecret`; `app.use("/admin", …)` middleware rejecting non-matching `x-thor-internal-secret` with `401` |
| `packages/admin/src/index.ts`             | Pass `internalSecret: config.thorInternalSecret` into `createAdminApp`                                                        |
| `docker/ingress/nginx.conf.template`      | `location /admin/`: `proxy_set_header X-Thor-Internal-Secret "${THOR_INTERNAL_SECRET}";` after the auth_request               |
| `docker-compose.yml`                      | Add `THOR_INTERNAL_SECRET` to the `admin` and `ingress` environment blocks                                                    |
| `.env.example`                            | Broaden the `THOR_INTERNAL_SECRET` comment to cover admin/ingress                                                             |
| `README.md`                               | Update the `THOR_INTERNAL_SECRET` row: add `admin`, `ingress`; note it gates admin config writes                              |
| `docs/feat/security-model.md`             | Note admin re-validates the internal secret (network membership alone is not sufficient to write config)                      |
| `packages/common/src/service-env.test.ts` | `loadAdminEnv` test expects `thorInternalSecret`; add a missing-secret throw case                                             |
| `packages/admin/src/app.test.ts`          | Thread the secret through existing requests; add `401`-without-secret and accepted-write-with-secret cases                    |

## Out of scope

- The `codex-lb` instance of the same bug class (`CODEX_LB_DASHBOARD_AUTH_MODE: disabled` + RFC1918 unauthenticated-client CIDRs, reachable by the agent that must call `codex-lb:2455` for models). Tracked separately — it cannot be closed by this secret gate or by network segmentation.
- Network segmentation (isolating `admin` onto an ingress-only network) — useful defense-in-depth but a separate change; this plan makes the app fail-closed regardless of topology.
- The audit log already records writes; no change to attribution.

## Exit criteria

- `POST /admin/config` and every `/admin/*` route return `401` without a matching `x-thor-internal-secret` header, and behave as before with it.
- `GET /health` works with no header.
- `ingress` injects the secret on `/admin/` after Vouch passes; a forged client header is overwritten.
- `loadAdminEnv` throws when `THOR_INTERNAL_SECRET` is unset.
- `@thor/common` and `@thor/admin` typecheck; admin + service-env suites green.
- Push checks green (core-e2e exercises the live ingress→admin path), then PR against `main`.
