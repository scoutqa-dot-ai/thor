from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from addon import HEALTH_HOST, ThorMitmAddon


@dataclass
class FakeRequest:
    host: str
    method: str = "GET"
    pretty_host: str | None = None
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class FakeFlow:
    request: FakeRequest
    response: object | None = None


def _status_code(response: object) -> int:
    if isinstance(response, dict):
        return int(response["status_code"])
    return int(getattr(response, "status_code"))


def _response_text(response: object) -> str:
    if isinstance(response, dict):
        return response["content"].decode("utf-8")
    content = getattr(response, "content", b"")
    if isinstance(content, bytes):
        return content.decode("utf-8")
    return str(content)


def test_health_endpoint_returns_200(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host=HEALTH_HOST))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 200


def test_unknown_host_is_denied(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="example.com"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403


def test_connect_unknown_host_is_denied(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="example.com", method="CONNECT"))
    addon.http_connect(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403


def test_missing_env_fails_closed_with_502(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "repos": {},
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "headers": {"Authorization": "Bearer ${MISSING_TOKEN}"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="api.example.com"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 502


def test_readonly_rule_blocks_non_read_method(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "repos": {},
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "headers": {"Authorization": "Bearer static"},
                        "readonly": True,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="api.example.com", method="POST"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked" in _response_text(flow.response)


def test_inject_rule_sets_headers(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "repos": {},
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "headers": {"Authorization": "Bearer static"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="api.example.com"))
    addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer static"
