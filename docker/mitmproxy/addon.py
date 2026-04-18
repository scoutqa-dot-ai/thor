"""Thor mitmproxy addon — per-host credential injection and deny-by-default policy."""
from __future__ import annotations

import json
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Optional

# Ensure rules.py is importable when mitmdump loads this script from any cwd
sys.path.insert(0, str(Path(__file__).parent))

from rules import (  # noqa: E402
    RuleSet,
    canonicalize_host,
    find_rule,
    interpolate,
    load_ruleset,
    DEFAULT_PASSTHROUGH,
)
from mitmproxy import ctx, http  # noqa: E402
from mitmproxy.http import HTTPFlow  # noqa: E402

_HEALTH_HOST = "__health.thor"
_DEFAULT_CONFIG_PATH = "/workspace/config.json"

_ruleset: Optional[RuleSet] = None
_config_mtime: float = -1.0
# Last reload error message (cleared on successful reload). Surfaced via /__health
# so operators can detect a broken config edit without tailing logs.
_last_config_error: Optional[str] = None


# ── mitmproxy lifecycle hooks ────────────────────────────────────────────────


def load(loader) -> None:  # type: ignore[type-arg]
    loader.add_option("config_path", str, _DEFAULT_CONFIG_PATH, "Path to config.json")
    # Set passthrough from hard-coded defaults so CONNECT tunneling works from first boot
    _apply_passthrough(DEFAULT_PASSTHROUGH)


def running() -> None:
    _refresh_ruleset()


# ── request hook ─────────────────────────────────────────────────────────────


def request(flow: HTTPFlow) -> None:
    try:
        _handle(flow)
    except Exception:
        ctx.log.error(f"thor-proxy: unhandled exception:\n{traceback.format_exc()}")
        flow.response = _make_error(500, "internal_error", flow.request.host)


def _handle(flow: HTTPFlow) -> None:
    host_raw = flow.request.pretty_host

    # Strip Proxy-Authorization before forwarding (AD12) — unconditional, before any branch
    flow.request.headers.pop("Proxy-Authorization", None)

    # Health intercept — synthetic response, no upstream connection.
    # Refresh the ruleset first so a broken config edit surfaces as degraded,
    # rather than hiding behind a cached last-known-good.
    if host_raw == _HEALTH_HOST:
        rs = _refresh_ruleset()
        degraded = rs is None or _last_config_error is not None
        status = 503 if degraded else 200
        body = {
            "status": "degraded" if degraded else "ok",
            "rules": len(rs.rules) if rs else 0,
            "mtime": rs.mtime if rs else None,
        }
        if _last_config_error is not None:
            body["config_error"] = _last_config_error
        flow.response = http.Response.make(
            status, json.dumps(body), {"content-type": "application/json"}
        )
        return

    host = canonicalize_host(host_raw)
    if host is None:
        flow.response = _make_error(403, "host_denied", host_raw)
        _log(flow.request.method, host_raw, None, "deny:ipv6")
        return

    rs = _refresh_ruleset()
    if rs is None:
        flow.response = _make_error(502, "config_unavailable", host)
        _log(flow.request.method, host, None, "deny:no_config")
        return

    rule = find_rule(rs.rules, host)

    if rule is not None:
        # Readonly enforcement
        if rule.readonly and flow.request.method not in {"GET", "HEAD", "OPTIONS"}:
            resp = _make_error(405, "readonly_violation", host)
            resp.headers["x-thor-proxy-rule"] = host
            flow.response = resp
            _log(flow.request.method, host, 405, f"deny:readonly:{host}")
            return

        # Header injection
        for name, tpl in rule.headers.items():
            try:
                flow.request.headers[name] = interpolate(tpl)
            except ValueError as exc:
                resp = _make_error(502, "missing_env", host)
                resp.headers["x-thor-proxy-rule"] = host
                flow.response = resp
                _log(flow.request.method, host, 502, f"deny:missing_env:{host} — {exc}")
                return

        # Mark for response hook to add x-thor-proxy-rule header
        flow.metadata["thor_rule"] = f"inject:{host}"
        return

    # Passthrough: HTTPS handled by ignore_hosts (addon never sees it).
    # If we reach here it's an HTTP request to a passthrough host — allow through.
    if host in rs.passthrough_hosts:
        flow.metadata["thor_rule"] = f"passthrough:{host}"
        return

    # Deny everything else
    flow.response = _make_error(403, "host_denied", host)
    _log(flow.request.method, host, 403, f"deny:not_allowed:{host}")


# ── response hook ─────────────────────────────────────────────────────────────


def response(flow: HTTPFlow) -> None:
    rule = flow.metadata.get("thor_rule", "")
    if rule:
        flow.response.headers["x-thor-proxy-rule"] = rule
        _log(flow.request.method, flow.request.pretty_host, flow.response.status_code, rule)


# ── helpers ───────────────────────────────────────────────────────────────────


def _refresh_ruleset() -> Optional[RuleSet]:
    global _ruleset, _config_mtime, _last_config_error
    try:
        path = ctx.options.config_path
        mtime = Path(path).stat().st_mtime
        if _ruleset is None or mtime != _config_mtime:
            new_rs = load_ruleset(path)
            _ruleset = new_rs
            _config_mtime = mtime
            _apply_passthrough(new_rs.passthrough_hosts)
        _last_config_error = None
    except Exception as exc:
        _last_config_error = f"{type(exc).__name__}: {exc}"
        if _ruleset is not None:
            ctx.log.warn(f"thor-proxy: config reload failed (using last good): {exc}")
        else:
            ctx.log.error(f"thor-proxy: config unavailable: {exc}")
    return _ruleset


def _apply_passthrough(hosts: list[str]) -> None:
    """Update mitmproxy ignore_hosts with anchored regex patterns for each host.

    mitmproxy matches ignore_hosts against the CONNECT target (host:port) for
    HTTPS, and against the Host header for HTTP. The optional port suffix lets
    a bare host match both forms.
    """
    ctx.options.ignore_hosts = [f"^{re.escape(h)}(?::\\d+)?$" for h in hosts]


def _make_error(status: int, code: str, host: str) -> http.Response:
    _hints = {
        "host_denied": "Add a rule to config.json#mitmproxy[] or config.json#mitmproxy_passthrough[]",
        "missing_env": "Set the referenced environment variable in the mitmproxy container",
        "readonly_violation": "Host is configured read-only; use GET or HEAD",
        "malformed_rule": "Fix the mitmproxy rule syntax in config.json",
        "config_unavailable": "Ensure config.json is mounted at /workspace/config.json",
        "internal_error": "Check mitmproxy container logs for a traceback",
    }
    body = json.dumps(
        {
            "error": f"thor_proxy_{code}",
            "host": host,
            "code": status,
            "hint": _hints.get(code, ""),
        }
    )
    return http.Response.make(
        status,
        body,
        {"content-type": "application/json", "x-thor-proxy-error": code},
    )


def _log(method: str, host: str, status: Optional[int], rule: str) -> None:
    print(
        json.dumps(
            {"ts": time.time(), "host": host, "method": method, "status": status, "rule": rule}
        ),
        flush=True,
    )
