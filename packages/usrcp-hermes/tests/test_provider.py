"""Unit tests for UsrcpMemoryProvider.

Mirrors the structure of:
  ~/.hermes/hermes-agent/tests/plugins/memory/test_supermemory_provider.py

All MCP client calls are mocked — no subprocess is spawned.  The test
fixture injects a ``FakeMcpClient`` in place of ``UsrcpMcpClient`` so the
provider's logic can be exercised in isolation.

``agent.memory_provider`` and the ``usrcp_hermes`` package are loaded by
``conftest.py`` before this module is imported.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

# conftest.py has already registered usrcp_hermes in sys.modules
from usrcp_hermes import UsrcpMemoryProvider, _PASSTHROUGH_TOOLS
from usrcp_hermes.client import UsrcpMcpError
from usrcp_hermes.tools import (
    extract_mcp_text,
    mcp_search_to_context_text,
    mcp_state_to_system_text,
)


# ---------------------------------------------------------------------------
# FakeMcpClient
# ---------------------------------------------------------------------------


class FakeMcpClient:
    """Drop-in replacement for UsrcpMcpClient — stores call log, returns canned data."""

    def __init__(self, user_slug: str = "default", caller: str = "hermes"):
        self.user_slug = user_slug
        self.caller = caller
        self.calls: List[Dict[str, Any]] = []
        self.connected = False
        self._responses: Dict[str, Any] = {}

    def set_response(self, tool_name: str, response: Any) -> None:
        self._responses[tool_name] = response

    def connect(self) -> None:
        self.connected = True

    def close(self) -> None:
        self.connected = False

    def call_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.calls.append({"tool": tool_name, "args": args})
        if tool_name in self._responses:
            resp = self._responses[tool_name]
            if isinstance(resp, Exception):
                raise resp
            return resp
        return [{"type": "text", "text": "{}"}]

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_client():
    return FakeMcpClient()


@pytest.fixture
def provider(fake_client, monkeypatch, tmp_path):
    """UsrcpMemoryProvider with injected FakeMcpClient."""
    monkeypatch.setattr("usrcp_hermes.UsrcpMcpClient", lambda **kwargs: fake_client)
    monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: True)
    monkeypatch.setenv("USRCP_USER_SLUG", "default")
    p = UsrcpMemoryProvider()
    p.initialize("session-1", hermes_home=str(tmp_path), platform="cli")
    return p


# ---------------------------------------------------------------------------
# is_available
# ---------------------------------------------------------------------------


class TestIsAvailable:
    def test_returns_false_when_binary_missing(self, monkeypatch):
        monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: False)
        p = UsrcpMemoryProvider()
        assert p.is_available() is False

    def test_returns_true_when_available(self, monkeypatch):
        monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: True)
        p = UsrcpMemoryProvider()
        assert p.is_available() is True


# ---------------------------------------------------------------------------
# get_tool_schemas
# ---------------------------------------------------------------------------


class TestGetToolSchemas:
    def test_returns_list_of_dicts(self, provider):
        schemas = provider.get_tool_schemas()
        assert isinstance(schemas, list)
        assert len(schemas) > 0

    def test_all_schemas_have_required_keys(self, provider):
        for schema in provider.get_tool_schemas():
            assert "name" in schema
            assert "description" in schema
            assert "parameters" in schema

    def test_schemas_follow_openai_format(self, provider):
        for schema in provider.get_tool_schemas():
            params = schema["parameters"]
            assert params["type"] == "object"
            assert "properties" in params

    def test_usrcp_prefixed_names(self, provider):
        names = {s["name"] for s in provider.get_tool_schemas()}
        for name in names:
            assert name.startswith("usrcp_"), f"Tool '{name}' lacks usrcp_ prefix"

    def test_required_tools_present(self, provider):
        names = {s["name"] for s in provider.get_tool_schemas()}
        assert "usrcp_get_state" in names
        assert "usrcp_append_event" in names
        assert "usrcp_search_timeline" in names


# ---------------------------------------------------------------------------
# prefetch
# ---------------------------------------------------------------------------


class TestPrefetch:
    def test_returns_empty_when_query_blank(self, provider):
        assert provider.prefetch("") == ""
        assert provider.prefetch("   ") == ""

    def test_calls_search_timeline(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            [{"type": "text", "text": json.dumps({
                "query": "hermes",
                "result_count": 1,
                "events": [
                    {
                        "summary": "Built Hermes plugin",
                        "intent": "Add USRCP support",
                        "domain": "coding",
                        "timestamp": "2026-04-26T10:00:00Z",
                    }
                ],
            })}],
        )
        result = provider.prefetch("hermes")
        assert result
        assert "Built Hermes plugin" in result
        assert len(fake_client.calls) >= 1
        assert fake_client.calls[-1]["tool"] == "usrcp_search_timeline"

    def test_returns_empty_on_mcp_error(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            UsrcpMcpError("server died"),
        )
        result = provider.prefetch("some query")
        assert result == ""

    def test_returns_empty_when_no_events(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            [{"type": "text", "text": json.dumps({
                "query": "x",
                "result_count": 0,
                "events": [],
            })}],
        )
        result = provider.prefetch("some query")
        assert result == ""

    def test_query_truncated_to_200_chars(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            [{"type": "text", "text": "{}"}],
        )
        long_query = "x" * 500
        provider.prefetch(long_query)
        call_args = fake_client.calls[-1]["args"]
        assert len(call_args["query"]) <= 200


# ---------------------------------------------------------------------------
# sync_turn
# ---------------------------------------------------------------------------


class TestSyncTurn:
    def test_skips_short_messages(self, provider, fake_client):
        provider.sync_turn("ok", "sure")
        assert not any(c["tool"] == "usrcp_append_event" for c in fake_client.calls)

    def test_fires_append_event(self, provider, fake_client):
        provider.sync_turn(
            "Please explain how the USRCP ledger works in detail",
            "The USRCP ledger is a SQLite database encrypted with a master key",
        )
        if provider._sync_thread:
            provider._sync_thread.join(timeout=2)
        append_calls = [c for c in fake_client.calls if c["tool"] == "usrcp_append_event"]
        assert len(append_calls) == 1
        args = append_calls[0]["args"]
        assert args["domain"] == "chat"
        assert args["outcome"] == "success"
        assert "summary" in args
        assert "intent" in args

    def test_skips_when_write_disabled(self, monkeypatch, fake_client, tmp_path):
        monkeypatch.setattr("usrcp_hermes.UsrcpMcpClient", lambda **kwargs: fake_client)
        monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: True)
        p = UsrcpMemoryProvider()
        p.initialize("s1", hermes_home=str(tmp_path), agent_context="cron")
        p.sync_turn(
            "Please explain how the USRCP ledger works in detail",
            "The USRCP ledger is a SQLite database encrypted",
        )
        assert not any(c["tool"] == "usrcp_append_event" for c in fake_client.calls)

    def test_does_not_block_caller(self, provider, fake_client):
        """sync_turn returns immediately; work happens in a background thread."""
        import time

        slow_event = threading.Event()
        original_call = fake_client.call_tool

        def slow_call(tool_name, args):
            if tool_name == "usrcp_append_event":
                slow_event.set()
                time.sleep(0.05)
            return original_call(tool_name, args)

        fake_client.call_tool = slow_call

        start = time.monotonic()
        provider.sync_turn(
            "Please explain how the USRCP ledger works in detail",
            "The USRCP ledger is a SQLite database encrypted",
        )
        elapsed = time.monotonic() - start
        assert elapsed < 0.04


# ---------------------------------------------------------------------------
# system_prompt_block
# ---------------------------------------------------------------------------


class TestSystemPromptBlock:
    def test_calls_get_state(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_get_state",
            [{"type": "text", "text": json.dumps({
                "state": {
                    "core_identity": {
                        "display_name": "Frank",
                        "roles": ["founder"],
                        "communication_style": "concise",
                    },
                    "global_preferences": {"verbosity": "minimal"},
                }
            })}],
        )
        block = provider.system_prompt_block()
        assert "Frank" in block
        assert "founder" in block

    def test_returns_empty_when_state_empty(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_get_state",
            [{"type": "text", "text": json.dumps({"state": {}})}],
        )
        block = provider.system_prompt_block()
        assert block == ""

    def test_returns_empty_on_mcp_error(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_get_state",
            UsrcpMcpError("connection lost"),
        )
        block = provider.system_prompt_block()
        assert block == ""


# ---------------------------------------------------------------------------
# handle_tool_call
# ---------------------------------------------------------------------------


class TestHandleToolCall:
    def test_returns_json_string(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_status",
            [{"type": "text", "text": '{"usrcp_version": "0.1.0"}'}],
        )
        result = provider.handle_tool_call("usrcp_status", {})
        parsed = json.loads(result)
        assert isinstance(parsed, dict)

    def test_dispatches_to_mcp_client(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            [{"type": "text", "text": '{"events": []}'}],
        )
        provider.handle_tool_call("usrcp_search_timeline", {"query": "test"})
        last = fake_client.calls[-1]
        assert last["tool"] == "usrcp_search_timeline"

    def test_returns_error_for_unknown_tool(self, provider, fake_client):
        result = json.loads(provider.handle_tool_call("unknown_tool_xyz", {}))
        assert "error" in result

    def test_returns_error_when_not_connected(self, monkeypatch, tmp_path, fake_client):
        monkeypatch.setattr("usrcp_hermes.UsrcpMcpClient", lambda **kwargs: fake_client)
        monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: True)
        p = UsrcpMemoryProvider()
        p.initialize("s1", hermes_home=str(tmp_path))
        p._active = False
        result = json.loads(p.handle_tool_call("usrcp_status", {}))
        assert "error" in result

    def test_caller_tag_injected_for_search_timeline(self, provider, fake_client):
        fake_client.set_response(
            "usrcp_search_timeline",
            [{"type": "text", "text": "{}"}],
        )
        provider.handle_tool_call("usrcp_search_timeline", {"query": "hello"})
        args = fake_client.calls[-1]["args"]
        assert args.get("caller") == "hermes"

    def test_passthrough_tools_all_prefixed(self):
        for name in _PASSTHROUGH_TOOLS:
            assert name.startswith("usrcp_"), f"'{name}' missing usrcp_ prefix"


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------


class TestShutdown:
    def test_joins_sync_thread_and_closes_client(self, provider, fake_client):
        import time

        slow_event = threading.Event()
        original_call = fake_client.call_tool

        def slow_call(tool_name, args):
            slow_event.set()
            time.sleep(0.1)
            return original_call(tool_name, args)

        fake_client.call_tool = slow_call

        provider.sync_turn(
            "Please explain how the USRCP ledger works in detail",
            "The USRCP ledger is a SQLite database encrypted with a master key",
        )
        slow_event.wait(timeout=1)
        provider.shutdown()

        assert provider._sync_thread is None
        assert provider._client is None
        assert not fake_client.connected

    def test_shutdown_safe_when_never_connected(self, monkeypatch, tmp_path):
        monkeypatch.setattr("usrcp_hermes.is_usrcp_available", lambda slug: True)
        p = UsrcpMemoryProvider()
        p.shutdown()  # must not raise


# ---------------------------------------------------------------------------
# Translation helpers (tools.py)
# ---------------------------------------------------------------------------


class TestMcpSearchToContextText:
    def test_returns_empty_on_no_events(self):
        assert mcp_search_to_context_text({"events": []}) == ""

    def test_returns_empty_on_none(self):
        assert mcp_search_to_context_text(None) == ""

    def test_formats_events(self):
        response = {
            "events": [
                {
                    "summary": "Fixed the auth bug",
                    "intent": "Get login working",
                    "domain": "coding",
                    "timestamp": "2026-04-26T09:00:00Z",
                }
            ]
        }
        text = mcp_search_to_context_text(response)
        assert "Fixed the auth bug" in text
        assert "coding" in text
        assert "<usrcp-context>" in text

    def test_handles_json_string_input(self):
        payload = json.dumps({
            "events": [{"summary": "test", "intent": "x", "domain": "coding"}]
        })
        text = mcp_search_to_context_text(payload)
        assert "test" in text

    def test_skips_events_with_no_summary(self):
        response = {"events": [{"intent": "something", "domain": "coding"}]}
        text = mcp_search_to_context_text(response)
        assert isinstance(text, str)


class TestMcpStateToSystemText:
    def test_empty_state_returns_empty(self):
        assert mcp_state_to_system_text({}) == ""
        assert mcp_state_to_system_text(None) == ""

    def test_formats_identity(self):
        response = {
            "state": {
                "core_identity": {
                    "display_name": "Frank",
                    "roles": ["founder", "engineer"],
                    "communication_style": "concise",
                }
            }
        }
        text = mcp_state_to_system_text(response)
        assert "Frank" in text
        assert "founder" in text
        assert "concise" in text

    def test_formats_preferences(self):
        response = {
            "state": {
                "global_preferences": {
                    "verbosity": "minimal",
                    "output_format": "markdown",
                }
            }
        }
        text = mcp_state_to_system_text(response)
        assert "minimal" in text
        assert "markdown" in text

    def test_handles_flat_state_without_state_key(self):
        response = {
            "core_identity": {
                "display_name": "Frank",
            }
        }
        text = mcp_state_to_system_text(response)
        assert isinstance(text, str)


class TestExtractMcpText:
    def test_extracts_text_from_list(self):
        content = [{"type": "text", "text": "hello"}]
        assert extract_mcp_text(content) == "hello"

    def test_extracts_text_from_dict_with_content_key(self):
        content = {"content": [{"type": "text", "text": "world"}]}
        assert extract_mcp_text(content) == "world"

    def test_returns_none_for_empty(self):
        assert extract_mcp_text([]) is None
        assert extract_mcp_text(None) is None

    def test_returns_none_when_no_text_type(self):
        content = [{"type": "image", "data": "..."}]
        assert extract_mcp_text(content) is None

    def test_handles_sdk_objects_with_attrs(self):
        obj = MagicMock()
        obj.type = "text"
        obj.text = "from sdk"
        assert extract_mcp_text([obj]) == "from sdk"


# ---------------------------------------------------------------------------
# get_config_schema
# ---------------------------------------------------------------------------


class TestGetConfigSchema:
    def test_returns_user_slug_field(self, provider):
        schema = provider.get_config_schema()
        keys = [f["key"] for f in schema]
        assert "user_slug" in keys

    def test_user_slug_has_default(self, provider):
        schema = provider.get_config_schema()
        slug_field = next(f for f in schema if f["key"] == "user_slug")
        assert slug_field.get("default") == "default"

    def test_user_slug_not_secret(self, provider):
        schema = provider.get_config_schema()
        slug_field = next(f for f in schema if f["key"] == "user_slug")
        assert not slug_field.get("secret", False)


# ---------------------------------------------------------------------------
# save_config
# ---------------------------------------------------------------------------


class TestSaveConfig:
    def test_writes_usrcp_json(self, provider, tmp_path):
        provider.save_config({"user_slug": "frank"}, str(tmp_path))
        config_file = tmp_path / "usrcp.json"
        assert config_file.exists()
        data = json.loads(config_file.read_text())
        assert data["user_slug"] == "frank"

    def test_file_permissions_0600(self, provider, tmp_path):
        import os
        import stat

        provider.save_config({"user_slug": "frank"}, str(tmp_path))
        config_file = tmp_path / "usrcp.json"
        mode = oct(stat.S_IMODE(os.stat(config_file).st_mode))
        assert mode == "0o600"


# ---------------------------------------------------------------------------
# register() hook
# ---------------------------------------------------------------------------


class TestRegisterHook:
    def test_register_calls_register_memory_provider(self):
        from usrcp_hermes import register

        ctx = MagicMock()
        register(ctx)
        ctx.register_memory_provider.assert_called_once()
        p = ctx.register_memory_provider.call_args[0][0]
        assert isinstance(p, UsrcpMemoryProvider)

    def test_registered_provider_name_is_usrcp(self):
        from usrcp_hermes import register

        ctx = MagicMock()
        register(ctx)
        p = ctx.register_memory_provider.call_args[0][0]
        assert p.name == "usrcp"
