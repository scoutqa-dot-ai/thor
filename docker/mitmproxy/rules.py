"""Pure rule matching and interpolation — no mitmproxy dependency, unit-testable."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

DEFAULT_PASSTHROUGH: list[str] = [
    "api.anthropic.com",
    "api.openai.com",
]

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_IPV6_RE = re.compile(r"^\[")


@dataclass
class Rule:
    host: Optional[str]
    host_suffix: Optional[str]
    headers: dict[str, str]
    readonly: bool


@dataclass
class RuleSet:
    rules: list[Rule]
    passthrough_hosts: list[str]
    mtime: float


def canonicalize_host(raw: str) -> Optional[str]:
    """Lowercase, strip port, strip trailing dot. Returns None for IPv6 literals."""
    if _IPV6_RE.match(raw):
        return None
    host = raw.lower()
    # Strip port — only if there's exactly one colon and it's not an IPv6 address
    colon = host.rfind(":")
    if colon > 0 and not _IPV6_RE.match(host):
        host = host[:colon]
    host = host.rstrip(".")
    return host or None


def find_rule(rules: list[Rule], host: str) -> Optional[Rule]:
    """First matching rule in declaration order. Returns None if no match."""
    for rule in rules:
        if rule.host is not None:
            if host == rule.host:
                return rule
        elif rule.host_suffix is not None:
            suffix = rule.host_suffix  # always starts with "."
            if host.endswith(suffix) or host == suffix.lstrip("."):
                return rule
    return None


def interpolate(value: str) -> str:
    """Expand ${VAR} references. Raises ValueError if any var is missing."""

    def _sub(m: re.Match) -> str:
        name = m.group(1)
        v = os.environ.get(name)
        if v is None:
            raise ValueError(f"environment variable {name!r} is not set")
        return v

    return _ENV_RE.sub(_sub, value)


def load_ruleset(config_path: str) -> RuleSet:
    """Parse config.json into a RuleSet. Raises on IO/JSON/validation errors."""
    p = Path(config_path)
    mtime = p.stat().st_mtime
    data = json.loads(p.read_text())

    raw_rules = data.get("mitmproxy") or []
    if not isinstance(raw_rules, list):
        raise ValueError(f"config.json 'mitmproxy' must be a list, got {type(raw_rules).__name__}")
    rules: list[Rule] = []
    for entry in raw_rules:
        h = entry.get("host")
        hs = entry.get("host_suffix")
        has_host = h is not None and h != ""
        has_suffix = hs is not None and hs != ""
        if has_host == has_suffix:
            raise ValueError(
                f"Each mitmproxy rule must have exactly one of 'host' or 'host_suffix': {entry!r}"
            )
        if has_suffix and not hs.startswith("."):
            raise ValueError(f"host_suffix must start with '.': {hs!r}")
        rules.append(
            Rule(
                host=h if has_host else None,
                host_suffix=hs if has_suffix else None,
                headers=dict(entry.get("headers", {})),
                readonly=bool(entry.get("readonly", False)),
            )
        )

    extra_pt = data.get("mitmproxy_passthrough") or []
    if not isinstance(extra_pt, list):
        raise ValueError(f"config.json 'mitmproxy_passthrough' must be a list, got {type(extra_pt).__name__}")
    passthrough = list(DEFAULT_PASSTHROUGH) + [
        h for h in (canonicalize_host(str(x)) for x in extra_pt) if h is not None
    ]

    return RuleSet(rules=rules, passthrough_hosts=passthrough, mtime=mtime)
