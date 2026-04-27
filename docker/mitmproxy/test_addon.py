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
    path: str = "/"
    pretty_host: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    content: bytes = b""

    def get_text(self) -> str:
        return self.content.decode("utf-8")


@dataclass
class FakeResponse:
    status_code: int = 200
    content: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)

    def get_text(self) -> str:
        return self.content.decode("utf-8")

    def set_text(self, text: str) -> None:
        self.content = text.encode("utf-8")


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
    assert "thor proxy denied host/path: example.com/" == _response_text(flow.response)


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


def test_builtin_missing_env_fails_closed_with_502(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"channel=C123&text=hello",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 502


def test_connect_slack_host_with_path_scoped_rule_is_allowed(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="slack.com", method="CONNECT"))
    addon.http_connect(flow)

    assert flow.response is None


def test_connect_slack_files_host_with_path_scoped_rule_is_allowed(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="files.slack.com", method="CONNECT"))
    addon.http_connect(flow)

    assert flow.response is None


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


def test_builtin_atlassian_rule_blocks_non_read_method(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("ATLASSIAN_AUTH", "Basic test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="api.atlassian.com", method="POST"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked" in _response_text(flow.response)


def test_disallowed_builtin_slack_update_returns_403(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="slack.com", path="/api/chat.update"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert _response_text(flow.response) == "thor proxy denied host/path: slack.com/api/chat.update"


def test_builtin_slack_rule_sets_headers(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"channel=C123&text=hello",
        )
    )
    addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer xoxb-test"


def test_slack_chat_post_message_accepts_json_allowed_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"Content-Type": "application/json"},
            content=b'{"channel":"C123","text":"hello"}',
        )
    )
    addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer xoxb-test"


def test_slack_chat_post_message_blocks_unconfigured_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"channel=C999&text=hello",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert _response_text(flow.response) == "thor proxy denied Slack channel: C999"
    assert "Authorization" not in flow.request.headers


def test_slack_chat_post_message_requires_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"text=hello",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert _response_text(flow.response) == "thor proxy Slack write requires an allowed channel"
    assert "Authorization" not in flow.request.headers


def test_slack_chat_post_message_response_injects_thread_alias_for_reply(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"channel=C123&thread_ts=1710000000.001&text=hello",
        ),
        response=FakeResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"ok":true,"ts":"1710000000.999","channel":"C123"}',
        ),
    )

    addon.response(flow)

    assert flow.response is not None
    assert (
        _response_text(flow.response)
        == '{"ok":true,"ts":"1710000000.999","channel":"C123","thor-meta-key":"slack:thread:1710000000.001"}'
    )


def test_slack_chat_post_message_response_injects_thread_alias_for_new_thread(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"channel=C123&text=hello",
        ),
        response=FakeResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"ok":true,"ts":"1710000000.999","channel":"C123"}',
        ),
    )

    addon.response(flow)

    assert flow.response is not None
    assert (
        _response_text(flow.response)
        == '{"ok":true,"ts":"1710000000.999","channel":"C123","thor-meta-key":"slack:thread:1710000000.999"}'
    )


def test_slack_chat_post_message_response_injects_alias_from_json_request_body(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/chat.postMessage",
            headers={"Content-Type": "application/json"},
            content=b'{"channel":"C123","thread_ts":"1710000000.111","text":"hello"}',
        ),
        response=FakeResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"ok":true,"ts":"1710000000.999","channel":"C123"}',
        ),
    )

    addon.response(flow)

    assert flow.response is not None
    assert (
        _response_text(flow.response)
        == '{"ok":true,"ts":"1710000000.999","channel":"C123","thor-meta-key":"slack:thread:1710000000.111"}'
    )


def test_slack_chat_post_message_response_does_not_inject_on_non_ok_payload(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(host="slack.com", method="POST", path="/api/chat.postMessage"),
        response=FakeResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"ok":false,"error":"not_in_channel"}',
        ),
    )

    addon.response(flow)

    assert flow.response is not None
    assert _response_text(flow.response) == '{"ok":false,"error":"not_in_channel"}'


def test_slack_chat_post_message_response_does_not_inject_for_other_paths(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(host="slack.com", method="POST", path="/api/chat.update"),
        response=FakeResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"ok":true,"ts":"1710000000.999","channel":"C123"}',
        ),
    )

    addon.response(flow)

    assert flow.response is not None
    assert _response_text(flow.response) == '{"ok":true,"ts":"1710000000.999","channel":"C123"}'


def test_builtin_slack_file_download_rule_is_readonly(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="files.slack.com",
            method="POST",
            path="/files-pri/T1-F1/download/report.txt",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked" in _response_text(flow.response)


def test_builtin_slack_file_upload_rule_allows_post(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({"repos": {}}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="files.slack.com",
            method="POST",
            path="/upload/v1/abc123",
        )
    )
    addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer xoxb-test"


def test_slack_complete_upload_allows_allowed_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/files.completeUploadExternal",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"files=%5B%5D&channel_id=C123",
        )
    )
    addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer xoxb-test"


def test_slack_complete_upload_blocks_unconfigured_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/files.completeUploadExternal",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"files=%5B%5D&channel_id=C999",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert _response_text(flow.response) == "thor proxy denied Slack channel: C999"
    assert "Authorization" not in flow.request.headers


def test_slack_complete_upload_requires_channel(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"repos": {"repo": {"channels": ["C123"]}}}),
        encoding="utf-8",
    )
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="slack.com",
            method="POST",
            path="/api/files.completeUploadExternal",
            headers={"content-type": "application/x-www-form-urlencoded"},
            content=b"files=%5B%5D",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert _response_text(flow.response) == "thor proxy Slack write requires an allowed channel"
    assert "Authorization" not in flow.request.headers


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
