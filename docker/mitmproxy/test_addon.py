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
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host=HEALTH_HOST))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 200


def test_unknown_host_is_denied(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="example.com"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "thor proxy denied host/path: example.com/" == _response_text(flow.response)


def test_connect_unknown_host_is_denied(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
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
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="slack.com", path="/api/conversations.replies"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 502


def test_connect_slack_host_with_path_scoped_rule_is_allowed(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="slack.com", method="CONNECT"))
    addon.http_connect(flow)

    assert flow.response is None


def test_connect_slack_files_host_with_path_scoped_rule_is_allowed(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="files.slack.com", method="CONNECT"))
    addon.http_connect(flow)

    assert flow.response is None


def test_readonly_rule_blocks_non_read_method(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
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
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="api.atlassian.com", method="POST"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked" in _response_text(flow.response)


def test_builtin_jira_attachment_upload_rules_inject_headers(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("ATLASSIAN_AUTH", "Basic test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flows = [
        FakeFlow(
            request=FakeRequest(
                host="foo.atlassian.net",
                method="POST",
                path="/rest/api/3/issue/ABC-1/attachments",
            )
        ),
        FakeFlow(
            request=FakeRequest(
                host="api.atlassian.com",
                method="POST",
                path="/ex/jira/cloud-id/rest/api/3/issue/ABC-1/attachments",
            )
        ),
    ]

    for flow in flows:
        addon.request(flow)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Basic test"
        assert flow.request.headers["X-Atlassian-Token"] == "no-check"


def test_builtin_jira_attachment_upload_rules_stay_path_and_method_scoped(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("ATLASSIAN_AUTH", "Basic test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flows = [
        FakeFlow(
            request=FakeRequest(
                host="foo.atlassian.net",
                method="POST",
                path="/rest/api/3/issue/ABC-1/foo/attachments",
            )
        ),
        FakeFlow(
            request=FakeRequest(
                host="api.atlassian.com",
                method="POST",
                path="/ex/jira/cloud-id/rest/api/3/project/foo/attachments",
            )
        ),
        FakeFlow(
            request=FakeRequest(
                host="foo.atlassian.net",
                method="DELETE",
                path="/rest/api/3/issue/ABC-1/attachments",
            )
        ),
    ]

    for flow in flows:
        addon.request(flow)
        assert flow.response is not None
        assert _status_code(flow.response) == 403
        assert "readonly rule blocked" in _response_text(flow.response)
        assert flow.request.headers == {}


def test_builtin_slack_reaction_add_is_denied(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(request=FakeRequest(host="slack.com", method="POST", path="/api/reactions.add"))
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked method POST" in _response_text(flow.response)
    assert "Authorization" not in flow.request.headers


def test_builtin_slack_file_upload_post_is_blocked_by_readonly_rule(
    tmp_path, monkeypatch
) -> None:
    # Uploads run server-side in remote-cli (slack-post-message --file); the
    # sandbox no longer uploads directly, so the readonly rule blocks POST.
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    config = tmp_path / "config.json"
    config.write_text(json.dumps({}), encoding="utf-8")
    addon = ThorMitmAddon(str(config))

    flow = FakeFlow(
        request=FakeRequest(
            host="files.slack.com",
            method="POST",
            path="/upload/v1/abc123",
        )
    )
    addon.request(flow)

    assert flow.response is not None
    assert _status_code(flow.response) == 403
    assert "readonly rule blocked method POST" in _response_text(flow.response)


def test_inject_rule_sets_headers(tmp_path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
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
