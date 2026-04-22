from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

ENV_PATTERN = re.compile(r"\$\{(\w+)\}")
READONLY_METHODS = {"GET", "HEAD", "OPTIONS"}


class MissingEnvVarError(Exception):
    pass


@dataclass(frozen=True)
class InjectRule:
    headers: dict[str, str]
    readonly: bool = False
    host: str | None = None
    host_suffix: str | None = None
    path_prefix: str | None = None

    def matches_host(self, host: str) -> bool:
        host = normalize_host(host)
        if self.host is not None:
            return host == normalize_host(self.host)
        if self.host_suffix is not None:
            return host.endswith(self.host_suffix.lower())
        return False

    def matches(self, host: str, path: str = "/") -> bool:
        if not self.matches_host(host):
            return False
        if self.path_prefix is None:
            return True
        return normalize_path(path).startswith(self.path_prefix)


@dataclass(frozen=True)
class PolicyDecision:
    action: str
    rule: InjectRule | None = None


@dataclass(frozen=True)
class RuleSet:
    rules: list[InjectRule]
    passthrough: list[str]

    def classify(self, host: str, path: str = "/") -> PolicyDecision:
        host = normalize_host(host)
        for rule in self.rules:
            if rule.matches(host, path):
                return PolicyDecision(action="inject", rule=rule)
        for entry in self.passthrough:
            if entry.startswith("."):
                if host.endswith(entry.lower()):
                    return PolicyDecision(action="passthrough")
            elif host == normalize_host(entry):
                return PolicyDecision(action="passthrough")
        return PolicyDecision(action="deny")

    def allows_host(self, host: str) -> bool:
        host = normalize_host(host)
        for rule in self.rules:
            if rule.matches_host(host):
                return True
        for entry in self.passthrough:
            if entry.startswith("."):
                if host.endswith(entry.lower()):
                    return True
            elif host == normalize_host(entry):
                return True
        return False


BUILTIN_RULES = [
    InjectRule(
        host="api.atlassian.com",
        headers={"Authorization": "${ATLASSIAN_AUTH}"},
        readonly=True,
    ),
    InjectRule(
        host_suffix=".atlassian.net",
        headers={"Authorization": "${ATLASSIAN_AUTH}"},
        readonly=True,
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/chat.postMessage",
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/conversations.replies",
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/conversations.history",
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/files.info",
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/files.getUploadURLExternal",
    ),
    InjectRule(
        host="slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/api/files.completeUploadExternal",
    ),
    InjectRule(
        host="files.slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/upload/v1/",
    ),
    InjectRule(
        host="files.slack.com",
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}"},
        path_prefix="/files-pri/",
        readonly=True,
    ),
]

BUILTIN_PASSTHROUGH = [
    "api.media.atlassian.com",
    "openai.com",
    ".openai.com",
    "chatgpt.com",
    ".chatgpt.com",
]


EMPTY_RULESET = RuleSet(rules=BUILTIN_RULES.copy(), passthrough=BUILTIN_PASSTHROUGH.copy())


def normalize_host(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):
        # [ipv6]:port
        end = host.find("]")
        if end != -1:
            host = host[1:end]
    elif ":" in host:
        host = host.split(":", 1)[0]
    if host.endswith("."):
        host = host[:-1]
    return host


def normalize_path(path: str) -> str:
    path = path.strip()
    if not path:
        return "/"

    if "://" in path:
        split = urlsplit(path)
        path = split.path or "/"

    if "?" in path:
        path = path.split("?", 1)[0]

    if not path.startswith("/"):
        path = "/" + path

    return path


def is_readonly_method(method: str) -> bool:
    return method.upper() in READONLY_METHODS


def interpolate_env(value: str, env: Mapping[str, str] | None = None) -> str:
    env = env or os.environ

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        resolved = env.get(key)
        if resolved is None:
            raise MissingEnvVarError(f"Environment variable {key} is not set")
        return resolved

    return ENV_PATTERN.sub(replace, value)


def resolve_headers(headers: Mapping[str, str], env: Mapping[str, str] | None = None) -> dict[str, str]:
    return {name: interpolate_env(value, env=env) for name, value in headers.items()}


def parse_ruleset(config: object) -> RuleSet:
    if not isinstance(config, dict):
        raise ValueError("workspace config must be a JSON object")

    raw_rules = config.get("mitmproxy", [])
    raw_passthrough = config.get("mitmproxy_passthrough", [])

    if raw_rules is None:
        raw_rules = []
    if raw_passthrough is None:
        raw_passthrough = []

    if not isinstance(raw_rules, list):
        raise ValueError('"mitmproxy" must be an array')
    if not isinstance(raw_passthrough, list):
        raise ValueError('"mitmproxy_passthrough" must be an array')

    rules: list[InjectRule] = []
    for idx, raw in enumerate(raw_rules):
        if not isinstance(raw, dict):
            raise ValueError(f"mitmproxy[{idx}] must be an object")

        host = raw.get("host")
        host_suffix = raw.get("host_suffix")
        path_prefix = raw.get("path_prefix")
        has_host = isinstance(host, str) and len(host) > 0
        has_suffix = isinstance(host_suffix, str) and len(host_suffix) > 0
        if has_host == has_suffix:
            raise ValueError(
                f"mitmproxy[{idx}] must set exactly one of 'host' or 'host_suffix'"
            )
        if has_suffix and not host_suffix.startswith("."):
            raise ValueError(
                f"mitmproxy[{idx}].host_suffix must start with '.'"
            )
        if path_prefix is not None:
            if not isinstance(path_prefix, str) or not path_prefix.startswith("/"):
                raise ValueError(
                    f"mitmproxy[{idx}].path_prefix must start with '/'"
                )

        headers = raw.get("headers")
        if not isinstance(headers, dict) or not headers:
            raise ValueError(f"mitmproxy[{idx}].headers must be a non-empty object")
        for key, value in headers.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise ValueError(f"mitmproxy[{idx}].headers must be string:string map")

        readonly_raw = raw.get("readonly", False)
        if not isinstance(readonly_raw, bool):
            raise ValueError(f"mitmproxy[{idx}].readonly must be a boolean")
        readonly = readonly_raw

        rule = InjectRule(
            headers=dict(headers),
            readonly=readonly,
            host=normalize_host(host) if has_host else None,
            host_suffix=host_suffix.lower() if has_suffix else None,
            path_prefix=normalize_path(path_prefix) if isinstance(path_prefix, str) else None,
        )
        rules.append(rule)

    passthrough: list[str] = []
    for idx, raw in enumerate(raw_passthrough):
        if not isinstance(raw, str) or not raw:
            raise ValueError(f"mitmproxy_passthrough[{idx}] must be a non-empty string")
        if raw.startswith("."):
            if len(raw) < 2:
                raise ValueError(f"mitmproxy_passthrough[{idx}] suffix is invalid")
            passthrough.append(raw.lower())
        else:
            if "/" in raw or ":" in raw:
                raise ValueError(
                    f"mitmproxy_passthrough[{idx}] must be an exact host or .suffix"
                )
            passthrough.append(normalize_host(raw))

    merged_rules = rules + BUILTIN_RULES
    merged_passthrough = passthrough + BUILTIN_PASSTHROUGH

    return RuleSet(rules=merged_rules, passthrough=merged_passthrough)


class RuleStore:
    def __init__(self, config_path: str):
        self._path = Path(config_path)
        self._last_mtime: float | None = None
        self._last_good = EMPTY_RULESET

    def get(self) -> RuleSet:
        try:
            stat = self._path.stat()
            mtime = stat.st_mtime
        except FileNotFoundError:
            return self._last_good

        if self._last_mtime is not None and mtime == self._last_mtime:
            return self._last_good

        try:
            parsed = json.loads(self._path.read_text(encoding="utf-8"))
            ruleset = parse_ruleset(parsed)
        except Exception as exc:  # pragma: no cover - log side effect only
            print(f"mitmproxy: invalid config at {self._path}: {exc}")
            return self._last_good

        self._last_mtime = mtime
        self._last_good = ruleset
        return ruleset
