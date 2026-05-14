from __future__ import annotations

from typing import Any

try:
    from mitmproxy import http
except Exception:  # pragma: no cover - test fallback when mitmproxy isn't installed
    class _FallbackResponse:
        @staticmethod
        def make(status_code: int, content: bytes, headers: dict[str, str]) -> Any:
            return {
                "status_code": status_code,
                "content": content,
                "headers": headers,
            }

    class _FallbackHTTP:
        Response = _FallbackResponse

    http = _FallbackHTTP()  # type: ignore[assignment]

from rules import (
    MissingEnvVarError,
    RuleStore,
    is_readonly_method,
    normalize_path,
    resolve_headers,
)

HEALTH_HOST = "__health.thor"


def _response(status: int, text: str) -> Any:
    return http.Response.make(
        status,
        text.encode("utf-8"),
        {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
        },
    )


class ThorMitmAddon:
    def __init__(self, config_path: str = "/workspace/config.json"):
        self._store = RuleStore(config_path=config_path)

    def http_connect(self, flow: Any) -> None:
        host = getattr(flow.request, "pretty_host", None) or flow.request.host
        if host == HEALTH_HOST:
            return

        if not self._store.get().allows_host(host):
            flow.response = _response(403, f"thor proxy denied host: {host}")

    def request(self, flow: Any) -> None:
        request = flow.request
        host = getattr(request, "pretty_host", None) or request.host
        path = normalize_path(getattr(request, "path", "/"))

        if host == HEALTH_HOST:
            flow.response = _response(200, "ok")
            return

        decision = self._store.get().classify(host, path, method=request.method)

        if decision.action == "deny":
            if host == "slack.com" and path == "/api/chat.postMessage":
                flow.response = _response(
                    403,
                    "thor proxy denied slack.com/api/chat.postMessage; use slack-post-message instead",
                )
                return
            flow.response = _response(403, f"thor proxy denied host/path: {host}{path}")
            return

        if decision.action == "passthrough":
            return

        if decision.rule is None:
            flow.response = _response(500, "invalid proxy rule state")
            return

        if decision.rule.readonly and not is_readonly_method(request.method):
            flow.response = _response(
                403,
                f"thor proxy readonly rule blocked method {request.method} for host: {host}",
            )
            return

        try:
            resolved_headers = resolve_headers(decision.rule.headers)
        except MissingEnvVarError as exc:
            flow.response = _response(502, str(exc))
            return

        for name, value in resolved_headers.items():
            request.headers[name] = value


addons = [ThorMitmAddon()]
