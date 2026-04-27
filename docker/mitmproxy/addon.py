from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

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
SLACK_COMPLETE_UPLOAD_PATH = "/api/files.completeUploadExternal"
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


def _request_content_type(request: Any) -> str:
    headers = getattr(request, "headers", {})
    return str(headers.get("content-type", headers.get("Content-Type", ""))).lower()


def _merge_fields(
    target: dict[str, list[str]],
    source: dict[str, list[str]],
) -> None:
    for key, values in source.items():
        target.setdefault(key, []).extend(values)


def _parse_request_fields(request: Any) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    raw_path = str(getattr(request, "path", ""))
    query = urlsplit(raw_path).query
    if query:
        _merge_fields(fields, parse_qs(query, keep_blank_values=True))

    content_type = _request_content_type(request)
    body = _get_request_text(request)

    if "application/json" in content_type:
        try:
            parsed = json.loads(body)
        except Exception:
            return fields

        if not isinstance(parsed, dict):
            return fields

        for key, value in parsed.items():
            if isinstance(key, str) and isinstance(value, str):
                fields.setdefault(key, []).append(value)
            elif isinstance(key, str) and isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        fields.setdefault(key, []).append(item)
        return fields

    if "application/x-www-form-urlencoded" in content_type or body:
        try:
            _merge_fields(fields, parse_qs(body, keep_blank_values=True))
        except Exception:
            return fields

    return fields


def _request_field_values(fields: dict[str, list[str]], *names: str) -> list[str]:
    values: list[str] = []
    for name in names:
        values.extend(fields.get(name, []))
    return values


def _split_channel_values(values: list[str]) -> list[str]:
    channels: list[str] = []
    for value in values:
        for channel in value.split(","):
            channel = channel.strip()
            if channel:
                channels.append(channel)
    return channels


def _extract_request_thread_ts(request: Any) -> str | None:
    values = _request_field_values(_parse_request_fields(request), "thread_ts")
    if values and values[0].strip():
        return values[0].strip()
    return None


def _slack_write_channel_error(
    path: str,
    request: Any,
    allowed_channels: frozenset[str],
) -> str | None:
    if path == SLACK_POST_MESSAGE_PATH:
        channel_fields = ("channel",)
    elif path == SLACK_COMPLETE_UPLOAD_PATH:
        channel_fields = ("channel_id", "channel", "channels", "channel_ids")
    else:
        return None

    fields = _parse_request_fields(request)
    channels = _split_channel_values(_request_field_values(fields, *channel_fields))
    if not channels:
        return "thor proxy Slack write requires an allowed channel"

    for channel in channels:
        if channel not in allowed_channels:
            return f"thor proxy denied Slack channel: {channel}"

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

        ruleset = self._store.get()
        decision = ruleset.classify(host, path)

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

        if host == "slack.com":
            channel_error = _slack_write_channel_error(
                path,
                request,
                ruleset.allowed_slack_channels,
            )
            if channel_error is not None:
                flow.response = _response(403, channel_error)
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
