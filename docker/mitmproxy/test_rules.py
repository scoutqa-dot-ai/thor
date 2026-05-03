from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rules import RuleStore, interpolate_env, parse_ruleset, resolve_headers


def test_exact_and_suffix_matching() -> None:
    ruleset = parse_ruleset(
        {
            "mitmproxy": [
                {
                    "host": "api.example.com",
                    "path_prefix": "/v1/",
                    "headers": {"Authorization": "Bearer ${TOKEN}"},
                },
                {
                    "host_suffix": ".example.internal",
                    "path_prefix": "/readonly/",
                    "headers": {"X-API-Key": "${INTERNAL}"},
                    "readonly": True,
                },
            ],
            "mitmproxy_passthrough": ["api.openai.com", ".openai.com"],
        }
    )

    assert ruleset.classify("api.example.com", "/v1/users").action == "inject"
    assert ruleset.classify("service.example.internal", "/readonly/health").action == "inject"
    assert ruleset.classify("api.example.com", "/v2/users").action == "deny"
    assert ruleset.classify("service.example.internal", "/write").action == "deny"
    assert ruleset.classify("api.openai.com").action == "passthrough"
    assert ruleset.classify("foo.openai.com").action == "passthrough"


def test_env_interpolation() -> None:
    assert interpolate_env("Bearer ${TOKEN}", env={"TOKEN": "abc"}) == "Bearer abc"
    assert resolve_headers(
        {"Authorization": "Bearer ${TOKEN}", "X-Org": "${ORG}"},
        env={"TOKEN": "abc", "ORG": "acme"},
    ) == {
        "Authorization": "Bearer abc",
        "X-Org": "acme",
    }


def test_readonly_flag_and_deny_by_default() -> None:
    ruleset = parse_ruleset(
        {
            "mitmproxy": [
                {
                    "host": "readonly.example.com",
                    "headers": {"Authorization": "Bearer ${TOKEN}"},
                    "readonly": True,
                }
            ]
        }
    )

    decision = ruleset.classify("readonly.example.com", "/")
    assert decision.action == "inject"
    assert decision.rule is not None
    assert decision.rule.readonly is True
    assert ruleset.classify("unknown.example.com").action == "deny"


def test_builtins_apply_when_user_rules_empty() -> None:
    ruleset = parse_ruleset({"repos": {}})

    atlassian = ruleset.classify("api.atlassian.com")
    assert atlassian.action == "inject"
    assert atlassian.rule is not None
    assert atlassian.rule.headers["Authorization"] == "${ATLASSIAN_AUTH}"
    assert atlassian.rule.readonly is True

    slack_post = ruleset.classify("slack.com", "/api/chat.postMessage")
    assert slack_post.action == "inject"
    assert slack_post.rule is not None
    assert slack_post.rule.headers["Authorization"] == "Bearer ${SLACK_BOT_TOKEN}"

    slack_reaction = ruleset.classify("slack.com", "/api/reactions.add")
    assert slack_reaction.action == "inject"
    assert slack_reaction.rule is not None
    assert slack_reaction.rule.headers["Authorization"] == "Bearer ${SLACK_BOT_TOKEN}"

    slack_reaction_remove = ruleset.classify("slack.com", "/api/reactions.remove")
    assert slack_reaction_remove.action == "deny"

    slack_history = ruleset.classify("slack.com", "/api/conversations.history")
    assert slack_history.action == "inject"

    slack_update = ruleset.classify("slack.com", "/api/chat.update")
    assert slack_update.action == "deny"

    slack_delete = ruleset.classify("slack.com", "/api/chat.delete")
    assert slack_delete.action == "deny"

    slack_unknown = ruleset.classify("slack.com", "/api/users.list")
    assert slack_unknown.action == "deny"

    atlassian_site = ruleset.classify("foo.atlassian.net")
    assert atlassian_site.action == "inject"
    assert atlassian_site.rule is not None
    assert atlassian_site.rule.readonly is True

    slack_upload = ruleset.classify("files.slack.com", "/upload/v1/abc123")
    assert slack_upload.action == "inject"
    assert slack_upload.rule is not None
    assert slack_upload.rule.readonly is False

    slack_file = ruleset.classify("files.slack.com", "/files-pri/T1-F1/download/report.txt")
    assert slack_file.action == "inject"
    assert slack_file.rule is not None
    assert slack_file.rule.readonly is True


def test_user_rule_override_wins_over_builtin() -> None:
    ruleset = parse_ruleset(
        {
            "mitmproxy": [
                {
                    "host": "slack.com",
                    "headers": {"Authorization": "Bearer ${CUSTOM_SLACK_TOKEN}"},
                }
            ]
        }
    )

    decision = ruleset.classify("slack.com", "/api/users.list")
    assert decision.action == "inject"
    assert decision.rule is not None
    assert decision.rule.headers["Authorization"] == "Bearer ${CUSTOM_SLACK_TOKEN}"


def test_slack_files_domain_not_covered_by_builtin_slack_rules() -> None:
    ruleset = parse_ruleset({"repos": {}})

    assert ruleset.classify("slack-files.com").action == "deny"


def test_openai_and_chatgpt_are_passthrough_by_default() -> None:
    ruleset = parse_ruleset({"repos": {}})

    assert ruleset.classify("api.media.atlassian.com").action == "passthrough"
    assert ruleset.classify("openai.com").action == "passthrough"
    assert ruleset.classify("api.openai.com").action == "passthrough"
    assert ruleset.classify("chatgpt.com").action == "passthrough"
    assert ruleset.classify("chat.openai.com").action == "passthrough"


def test_user_passthrough_entries_are_ordered_before_builtins() -> None:
    ruleset = parse_ruleset(
        {
            "mitmproxy_passthrough": ["api.openai.com"],
        }
    )

    assert ruleset.passthrough[:6] == [
        "api.openai.com",
        "api.media.atlassian.com",
        "openai.com",
        ".openai.com",
        "chatgpt.com",
        ".chatgpt.com",
    ]


def test_invalid_host_suffix_and_readonly_type_are_rejected() -> None:
    try:
        parse_ruleset(
            {
                "mitmproxy": [
                    {
                        "host_suffix": "example.internal",
                        "headers": {"Authorization": "Bearer ${TOKEN}"},
                    }
                ]
            }
        )
        raise AssertionError("expected invalid host_suffix to raise")
    except ValueError as exc:
        assert "host_suffix must start with '.'" in str(exc)

    try:
        parse_ruleset(
            {
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "path_prefix": "v1",
                        "headers": {"Authorization": "Bearer ${TOKEN}"},
                    }
                ]
            }
        )
        raise AssertionError("expected invalid path_prefix to raise")
    except ValueError as exc:
        assert "path_prefix must start with '/'" in str(exc)

    try:
        parse_ruleset(
            {
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "headers": {"Authorization": "Bearer ${TOKEN}"},
                        "readonly": "false",
                    }
                ]
            }
        )
        raise AssertionError("expected invalid readonly type to raise")
    except ValueError as exc:
        assert "readonly must be a boolean" in str(exc)


def test_rule_store_uses_last_good_on_invalid_reload(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "repos": {},
                "mitmproxy": [
                    {
                        "host": "api.example.com",
                        "headers": {"Authorization": "Bearer ${TOKEN}"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    store = RuleStore(str(config_path))
    assert store.get().classify("api.example.com").action == "inject"

    config_path.write_text("not-json", encoding="utf-8")
    assert store.get().classify("api.example.com").action == "inject"
