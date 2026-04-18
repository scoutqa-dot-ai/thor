"""Unit tests for rules.py — no mitmproxy dependency required."""
import json
import os
import tempfile
import unittest

from rules import (
    Rule,
    RuleSet,
    canonicalize_host,
    find_rule,
    interpolate,
    load_ruleset,
    DEFAULT_PASSTHROUGH,
)


class TestCanonicalizeHost(unittest.TestCase):
    def test_lowercase(self):
        self.assertEqual(canonicalize_host("API.Example.COM"), "api.example.com")

    def test_strips_trailing_dot(self):
        self.assertEqual(canonicalize_host("api.example.com."), "api.example.com")

    def test_strips_port(self):
        self.assertEqual(canonicalize_host("api.example.com:443"), "api.example.com")

    def test_strips_non_standard_port(self):
        self.assertEqual(canonicalize_host("api.example.com:8443"), "api.example.com")

    def test_rejects_ipv6(self):
        self.assertIsNone(canonicalize_host("[::1]"))
        self.assertIsNone(canonicalize_host("[2001:db8::1]"))

    def test_empty_after_strip(self):
        self.assertIsNone(canonicalize_host("."))

    def test_plain_hostname(self):
        self.assertEqual(canonicalize_host("example.com"), "example.com")


class TestFindRule(unittest.TestCase):
    def _rule(self, host=None, host_suffix=None, readonly=False):
        return Rule(host=host, host_suffix=host_suffix, headers={}, readonly=readonly)

    def test_exact_match(self):
        rules = [self._rule(host="api.example.com")]
        self.assertIsNotNone(find_rule(rules, "api.example.com"))

    def test_no_exact_match(self):
        rules = [self._rule(host="api.example.com")]
        self.assertIsNone(find_rule(rules, "other.example.com"))

    def test_suffix_match(self):
        rules = [self._rule(host_suffix=".example.com")]
        self.assertIsNotNone(find_rule(rules, "sub.example.com"))
        self.assertIsNotNone(find_rule(rules, "deep.sub.example.com"))

    def test_suffix_matches_bare_domain(self):
        # ".example.com" should match "example.com" itself
        rules = [self._rule(host_suffix=".example.com")]
        self.assertIsNotNone(find_rule(rules, "example.com"))

    def test_suffix_no_match(self):
        rules = [self._rule(host_suffix=".example.com")]
        self.assertIsNone(find_rule(rules, "notexample.com"))

    def test_first_match_wins(self):
        r1 = self._rule(host="api.example.com")
        r2 = self._rule(host_suffix=".example.com")
        result = find_rule([r1, r2], "api.example.com")
        self.assertIs(result, r1)

    def test_empty_rules(self):
        self.assertIsNone(find_rule([], "api.example.com"))

    def test_readonly_flag_accessible(self):
        rules = [self._rule(host="api.example.com", readonly=True)]
        rule = find_rule(rules, "api.example.com")
        self.assertTrue(rule.readonly)


class TestInterpolate(unittest.TestCase):
    def test_replaces_env_var(self):
        os.environ["_TEST_TOKEN"] = "secret123"
        try:
            self.assertEqual(interpolate("Bearer ${_TEST_TOKEN}"), "Bearer secret123")
        finally:
            del os.environ["_TEST_TOKEN"]

    def test_multiple_vars(self):
        os.environ["_A"] = "foo"
        os.environ["_B"] = "bar"
        try:
            self.assertEqual(interpolate("${_A}-${_B}"), "foo-bar")
        finally:
            del os.environ["_A"]
            del os.environ["_B"]

    def test_no_placeholders(self):
        self.assertEqual(interpolate("plain string"), "plain string")

    def test_missing_var_raises(self):
        os.environ.pop("_MISSING_VAR_12345", None)
        with self.assertRaises(ValueError) as ctx:
            interpolate("${_MISSING_VAR_12345}")
        self.assertIn("_MISSING_VAR_12345", str(ctx.exception))

    def test_crlf_in_env_value_raises(self):
        """CR/LF in env values must be rejected to prevent header smuggling.

        (NUL can't be inserted into os.environ — Python rejects it at the C layer.)
        """
        for bad in ("secret\r\ninjected: header", "secret\nheader"):
            os.environ["_CRLF_TEST"] = bad
            try:
                with self.assertRaises(ValueError) as ctx:
                    interpolate("${_CRLF_TEST}")
                self.assertIn("control", str(ctx.exception).lower())
            finally:
                del os.environ["_CRLF_TEST"]


class TestLoadRuleset(unittest.TestCase):
    def _write(self, data: dict) -> str:
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(data, f)
        f.close()
        return f.name

    def test_empty_mitmproxy_block(self):
        path = self._write({"repos": {}})
        rs = load_ruleset(path)
        self.assertEqual(rs.rules, [])
        self.assertEqual(rs.passthrough_hosts, DEFAULT_PASSTHROUGH)

    def test_host_rule(self):
        path = self._write(
            {
                "mitmproxy": [
                    {"host": "api.example.com", "headers": {"Authorization": "${TOKEN}"}}
                ]
            }
        )
        rs = load_ruleset(path)
        self.assertEqual(len(rs.rules), 1)
        self.assertEqual(rs.rules[0].host, "api.example.com")
        self.assertEqual(rs.rules[0].headers, {"Authorization": "${TOKEN}"})
        self.assertFalse(rs.rules[0].readonly)

    def test_host_suffix_rule(self):
        path = self._write({"mitmproxy": [{"host_suffix": ".acme.example"}]})
        rs = load_ruleset(path)
        self.assertEqual(rs.rules[0].host_suffix, ".acme.example")

    def test_readonly_flag(self):
        path = self._write({"mitmproxy": [{"host": "api.example.com", "readonly": True}]})
        rs = load_ruleset(path)
        self.assertTrue(rs.rules[0].readonly)

    def test_both_host_and_suffix_raises(self):
        path = self._write(
            {"mitmproxy": [{"host": "a.com", "host_suffix": ".a.com"}]}
        )
        with self.assertRaises(ValueError):
            load_ruleset(path)

    def test_neither_host_nor_suffix_raises(self):
        path = self._write({"mitmproxy": [{"headers": {}}]})
        with self.assertRaises(ValueError):
            load_ruleset(path)

    def test_suffix_without_leading_dot_raises(self):
        path = self._write({"mitmproxy": [{"host_suffix": "example.com"}]})
        with self.assertRaises(ValueError):
            load_ruleset(path)

    def test_extra_passthrough_appended(self):
        path = self._write({"mitmproxy_passthrough": ["custom.llm.provider"]})
        rs = load_ruleset(path)
        self.assertIn("custom.llm.provider", rs.passthrough_hosts)
        # Default ones still present
        self.assertIn("api.anthropic.com", rs.passthrough_hosts)

    def test_mtime_captured(self):
        path = self._write({})
        rs = load_ruleset(path)
        self.assertGreater(rs.mtime, 0)

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_ruleset("/nonexistent/config.json")

    def test_hot_reload(self):
        """Editing config is reflected on next load_ruleset call (mtime changes)."""
        path = self._write({"mitmproxy": [{"host": "api.example.com"}]})
        rs1 = load_ruleset(path)
        self.assertEqual(len(rs1.rules), 1)

        # Overwrite with a different config
        with open(path, "w") as f:
            json.dump(
                {"mitmproxy": [{"host": "api.example.com"}, {"host": "api.other.com"}]}, f
            )
        # Force mtime to differ (filesystem may have 1s resolution)
        import time
        time.sleep(0.01)
        os.utime(path, None)

        rs2 = load_ruleset(path)
        self.assertEqual(len(rs2.rules), 2)

    def test_config_disappearance_raises(self):
        """load_ruleset raises if file disappears."""
        with self.assertRaises(Exception):
            load_ruleset("/no/such/file.json")


if __name__ == "__main__":
    unittest.main()
