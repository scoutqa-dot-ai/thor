from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs

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
    normalize_host,
    normalize_path,
    resolve_headers,
)

HEALTH_HOST = "__health.thor"
SLACK_POST_MESSAGE_PATH = "/api/chat.postMessage"
THOR_META_KEY = "thor-meta-key"


def _response(status: int, text: str) -> Any:
    return http.Response.make(
        status,
        text.encode("utf-8"),
        {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
        },
    )


def _get_request_text(request: Any) -> str:
    getter = getattr(request, "get_text", None)
    if callable(getter):
        try:
            text = getter()
            if isinstance(text, str):
                return text
        except Exception:
            pass

    text = getattr(request, "text", None)
    if isinstance(text, str):
        return text

    content = getattr(request, "content", b"")
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    return str(content)


def _get_response_text(response: Any) -> str:
    getter = getattr(response, "get_text", None)
    if callable(getter):
        try:
            text = getter()
            if isinstance(text, str):
                return text
        except Exception:
            pass

    content = getattr(response, "content", b"")
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    return str(content)


def _set_response_text(response: Any, text: str) -> None:
    setter = getattr(response, "set_text", None)
    if callable(setter):
        setter(text)
        return

    if isinstance(response, dict):
        response["content"] = text.encode("utf-8")
        return

    response.content = text.encode("utf-8")


def _extract_request_thread_ts(request: Any) -> str | None:
    headers = getattr(request, "headers", {})
    content_type = str(headers.get("content-type", headers.get("Content-Type", ""))).lower()
    body = _get_request_text(request)

    if "application/json" in content_type:
        try:
            parsed = json.loads(body)
            thread_ts = parsed.get("thread_ts") if isinstance(parsed, dict) else None
            if isinstance(thread_ts, str) and thread_ts.strip():
                return thread_ts.strip()
        except Exception:
            return None

    if "application/x-www-form-urlencoded" in content_type or body:
        try:
            params = parse_qs(body, keep_blank_values=True)
            values = params.get("thread_ts")
            if values and isinstance(values[0], str) and values[0].strip():
                return values[0].strip()
        except Exception:
            return None

    return None


class ThorMitmAddon:
    def __init__(self, config_path: str = "/workspace/config.json"):
        self._store = RuleStore(config_path=config_path)

    def http_connect(self, flow: Any) -> None:
        host = normalize_host(getattr(flow.request, "pretty_host", None) or flow.request.host)
        if host == HEALTH_HOST:
            return

        if not self._store.get().allows_host(host):
            flow.response = _response(403, f"thor proxy denied host: {host}")

    def request(self, flow: Any) -> None:
        request = flow.request
        host = normalize_host(getattr(request, "pretty_host", None) or request.host)
        path = normalize_path(getattr(request, "path", "/"))

        if host == HEALTH_HOST:
            flow.response = _response(200, "ok")
            return

        decision = self._store.get().classify(host, path)

        if decision.action == "deny":
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

    def response(self, flow: Any) -> None:
        request = flow.request
        response = getattr(flow, "response", None)
        if response is None:
            return

        host = normalize_host(getattr(request, "pretty_host", None) or request.host)
        path = normalize_path(getattr(request, "path", "/"))
        method = str(getattr(request, "method", "")).upper()

        if host != "slack.com" or path != SLACK_POST_MESSAGE_PATH or method != "POST":
            return

        try:
            payload = json.loads(_get_response_text(response))
        except Exception:
            return

        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return

        thread_ts = _extract_request_thread_ts(request)
        if thread_ts:
            alias_ts = thread_ts
        else:
            ts = payload.get("ts")
            alias_ts = ts.strip() if isinstance(ts, str) else ""

        if not alias_ts:
            return

        payload[THOR_META_KEY] = f"slack:thread:{alias_ts}"
        _set_response_text(response, json.dumps(payload, separators=(",", ":")))


addons = [ThorMitmAddon()]
