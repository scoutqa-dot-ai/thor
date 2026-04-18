"""Unit tests for addon.py — deny-by-default policy, credential injection, health endpoint."""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from mitmproxy.test import taddons
from mitmproxy.test import tflow as tflow_mod

import addon as _addon_mod
from rules import Rule, RuleSet


def _rs(rules=None, passthrough=None):
    return RuleSet(rules=rules or [], passthrough_hosts=passthrough or [], mtime=0.0)


def _flow(host, method="GET", req_headers=None):
    req = tflow_mod.treq(host=host, method=method.encode())
    if req_headers:
        for k, v in req_headers.items():
            req.headers[k] = v
    return tflow_mod.tflow(req=req)


class TestHealthEndpoint(unittest.TestCase):
    def setUp(self):
        self._ctx = taddons.context().__enter__()
        _addon_mod._ruleset = None
        _addon_mod._config_mtime = -1.0

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_ok_returns_200_with_rule_count(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={}, readonly=False)
        _addon_mod._ruleset = _rs(rules=[rule])
        f = _flow("__health.thor")
        _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 200)
        body = json.loads(f.response.text)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["rules"], 1)

    def test_degraded_returns_503_when_no_ruleset(self):
        _addon_mod._ruleset = None
        f = _flow("__health.thor")
        _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 503)
        body = json.loads(f.response.text)
        self.assertEqual(body["status"], "degraded")
        self.assertEqual(body["rules"], 0)


class TestProxyAuthStripping(unittest.TestCase):
    """Proxy-Authorization must be stripped unconditionally — before any branch."""

    def setUp(self):
        self._ctx = taddons.context().__enter__()
        _addon_mod._ruleset = None

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_stripped_before_health_intercept(self):
        _addon_mod._ruleset = _rs()
        f = _flow("__health.thor", req_headers={"Proxy-Authorization": "Basic abc"})
        _addon_mod._handle(f)
        self.assertNotIn("Proxy-Authorization", f.request.headers)

    def test_stripped_on_ipv6_deny(self):
        f = _flow("[::1]", req_headers={"Proxy-Authorization": "Bearer token"})
        _addon_mod._handle(f)
        self.assertNotIn("Proxy-Authorization", f.request.headers)

    def test_stripped_on_host_deny(self):
        rs = _rs(rules=[], passthrough=[])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("denied.example.com", req_headers={"Proxy-Authorization": "Bearer token"})
            _addon_mod._handle(f)
        self.assertNotIn("Proxy-Authorization", f.request.headers)
        self.assertEqual(f.response.status_code, 403)


class TestDenyByDefault(unittest.TestCase):
    def setUp(self):
        self._ctx = taddons.context().__enter__()

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_ipv6_literal_denied(self):
        f = _flow("[2001:db8::1]")
        _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 403)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_host_denied")

    def test_config_unavailable_returns_502(self):
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=None):
            f = _flow("api.example.com")
            _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 502)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_config_unavailable")
        self.assertNotEqual(body["hint"], "")

    def test_unlisted_host_denied(self):
        rs = _rs(rules=[], passthrough=["api.openai.com"])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("unlisted.example.com")
            _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 403)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_host_denied")

    def test_passthrough_host_allowed(self):
        rs = _rs(passthrough=["api.openai.com"])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.openai.com")
            _addon_mod._handle(f)
        self.assertIsNone(f.response)
        self.assertEqual(f.metadata.get("thor_rule"), "passthrough:api.openai.com")

    def test_prefix_of_passthrough_host_denied(self):
        """evil-api.openai.com must not match passthrough for api.openai.com."""
        rs = _rs(rules=[], passthrough=["api.openai.com"])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("evil-api.openai.com")
            _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 403)


class TestInjectRules(unittest.TestCase):
    def setUp(self):
        self._ctx = taddons.context().__enter__()

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_inject_literal_header(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={"X-Api-Key": "secret"}, readonly=False)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.example.com")
            _addon_mod._handle(f)
        self.assertIsNone(f.response)
        self.assertEqual(f.request.headers.get("X-Api-Key"), "secret")
        self.assertEqual(f.metadata.get("thor_rule"), "inject:api.example.com")

    def test_inject_env_var_header(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={"Authorization": "${__TEST_TOKEN__}"}, readonly=False)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs), \
             patch.dict(os.environ, {"__TEST_TOKEN__": "Bearer xyz"}):
            f = _flow("api.example.com")
            _addon_mod._handle(f)
        self.assertEqual(f.request.headers.get("Authorization"), "Bearer xyz")

    def test_inject_missing_env_returns_502(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={"Authorization": "${__MISSING_TEST_VAR_XYZ__}"}, readonly=False)
        rs = _rs(rules=[rule])
        env = {k: v for k, v in os.environ.items() if k != "__MISSING_TEST_VAR_XYZ__"}
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs), \
             patch.dict(os.environ, env, clear=True):
            f = _flow("api.example.com")
            _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 502)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_missing_env")

    def test_readonly_rule_rejects_post(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={}, readonly=True)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.example.com", method="POST")
            _addon_mod._handle(f)
        self.assertEqual(f.response.status_code, 405)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_readonly_violation")

    def test_readonly_rule_allows_get(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={}, readonly=True)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.example.com", method="GET")
            _addon_mod._handle(f)
        self.assertIsNone(f.response)
        self.assertEqual(f.metadata.get("thor_rule"), "inject:api.example.com")

    def test_readonly_rule_allows_head(self):
        rule = Rule(host="api.example.com", host_suffix=None, headers={}, readonly=True)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.example.com", method="HEAD")
            _addon_mod._handle(f)
        self.assertIsNone(f.response)

    def test_suffix_rule_matches_subdomain(self):
        rule = Rule(host=None, host_suffix=".example.com", headers={"X-Org": "acme"}, readonly=False)
        rs = _rs(rules=[rule])
        with patch.object(_addon_mod, "_refresh_ruleset", return_value=rs):
            f = _flow("api.example.com")
            _addon_mod._handle(f)
        self.assertEqual(f.request.headers.get("X-Org"), "acme")
        self.assertEqual(f.metadata.get("thor_rule"), "inject:api.example.com")


class TestResponseHook(unittest.TestCase):
    def setUp(self):
        self._ctx = taddons.context().__enter__()

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_sets_x_thor_proxy_rule_header(self):
        f = _flow("api.example.com")
        f.metadata["thor_rule"] = "inject:api.example.com"
        f.response = tflow_mod.tresp()
        _addon_mod.response(f)
        self.assertEqual(f.response.headers.get("x-thor-proxy-rule"), "inject:api.example.com")

    def test_skips_when_no_thor_rule_metadata(self):
        f = _flow("api.example.com")
        f.response = tflow_mod.tresp()
        _addon_mod.response(f)
        self.assertNotIn("x-thor-proxy-rule", f.response.headers)


class TestRequestHookExceptionSafety(unittest.TestCase):
    def setUp(self):
        self._ctx = taddons.context().__enter__()

    def tearDown(self):
        self._ctx.__exit__(None, None, None)

    def test_unhandled_exception_returns_500_with_hint(self):
        with patch.object(_addon_mod, "_handle", side_effect=RuntimeError("boom")):
            f = _flow("api.example.com")
            _addon_mod.request(f)
        self.assertEqual(f.response.status_code, 500)
        body = json.loads(f.response.text)
        self.assertEqual(body["error"], "thor_proxy_internal_error")
        self.assertNotEqual(body["hint"], "")
