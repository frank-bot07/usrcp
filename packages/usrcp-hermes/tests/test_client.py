"""Narrow unit tests for usrcp-hermes/client.py.

Tests exercise ``is_usrcp_available`` and the ``UsrcpMcpClient`` public
interface.  All subprocess and MCP SDK calls are avoided or mocked so
tests run fully offline.

The ``mcp`` package is imported lazily inside ``_async_session_lifetime`` —
it is never imported at module level in client.py — so these tests run
without requiring ``mcp`` to be installed.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# conftest.py has loaded usrcp_hermes; client sub-module is already in sys.modules
from usrcp_hermes.client import UsrcpMcpClient, UsrcpMcpError, is_usrcp_available


# ---------------------------------------------------------------------------
# is_usrcp_available
# ---------------------------------------------------------------------------


class TestIsUsrcpAvailable:
    def test_returns_false_when_binary_missing(self, monkeypatch):
        monkeypatch.setattr("usrcp_hermes.client.shutil.which", lambda _: None)
        assert is_usrcp_available("default") is False

    def test_returns_false_when_ledger_missing(self, monkeypatch, tmp_path):
        monkeypatch.setattr("usrcp_hermes.client.shutil.which", lambda _: "/usr/local/bin/usrcp")
        # Patch Path.home() so the ledger path resolves inside tmp_path (no ledger.db)
        with patch("usrcp_hermes.client.Path") as mock_path_cls:
            fake_ledger = MagicMock()
            fake_ledger.exists.return_value = False
            # Path.home() / ".usrcp" / "users" / slug / "ledger.db"
            mock_path_cls.home.return_value.__truediv__.return_value \
                .__truediv__.return_value.__truediv__.return_value \
                .__truediv__.return_value = fake_ledger
            assert is_usrcp_available("default") is False

    def test_returns_true_when_both_present(self, monkeypatch):
        monkeypatch.setattr("usrcp_hermes.client.shutil.which", lambda _: "/usr/local/bin/usrcp")
        with patch("usrcp_hermes.client.Path") as mock_path_cls:
            fake_ledger = MagicMock()
            fake_ledger.exists.return_value = True
            mock_path_cls.home.return_value.__truediv__.return_value \
                .__truediv__.return_value.__truediv__.return_value \
                .__truediv__.return_value = fake_ledger
            assert is_usrcp_available("default") is True


# ---------------------------------------------------------------------------
# UsrcpMcpClient — init
# ---------------------------------------------------------------------------


class TestUsrcpMcpClientInit:
    def test_default_slug(self):
        c = UsrcpMcpClient()
        assert c._user_slug == "default"

    def test_custom_slug(self):
        c = UsrcpMcpClient(user_slug="frank")
        assert c._user_slug == "frank"

    def test_custom_bin(self):
        c = UsrcpMcpClient(usrcp_bin="/opt/usrcp")
        assert c._usrcp_bin == "/opt/usrcp"

    def test_session_none_initially(self):
        c = UsrcpMcpClient()
        assert c._session is None

    def test_call_tool_raises_when_not_connected(self):
        c = UsrcpMcpClient()
        with pytest.raises(UsrcpMcpError, match="not connected"):
            c.call_tool("usrcp_status", {})


# ---------------------------------------------------------------------------
# UsrcpMcpClient — call_tool with mocked session + event loop
# ---------------------------------------------------------------------------


class TestUsrcpMcpClientCallTool:
    """Test the async tool-call path (`_async_call_tool`) directly via
    ``asyncio.run`` rather than spinning up a real background event loop —
    keeps the unit test fast and deterministic.
    """

    def test_async_returns_content_list(self):
        client = UsrcpMcpClient(user_slug="default")
        fake_content = [{"type": "text", "text": '{"usrcp_version": "0.1.0"}'}]

        async def fake_call_tool(name, args):
            result = MagicMock()
            result.content = fake_content
            return result

        mock_session = MagicMock()
        mock_session.call_tool = fake_call_tool
        client._session = mock_session

        result = asyncio.run(client._async_call_tool("usrcp_status", {}))
        assert isinstance(result, list)
        assert result[0]["type"] == "text"

    def test_async_raises_on_session_error(self):
        client = UsrcpMcpClient()
        mock_session = MagicMock()
        mock_session.call_tool = AsyncMock(side_effect=RuntimeError("server died"))
        client._session = mock_session

        with pytest.raises(RuntimeError, match="server died"):
            asyncio.run(client._async_call_tool("usrcp_status", {}))

    def test_call_tool_raises_when_loop_missing(self):
        client = UsrcpMcpClient()
        client._session = MagicMock()
        # _loop is still None — the synchronous wrapper short-circuits
        with pytest.raises(UsrcpMcpError, match="not connected"):
            client.call_tool("usrcp_status", {})


# ---------------------------------------------------------------------------
# UsrcpMcpClient — context manager
# ---------------------------------------------------------------------------


class TestUsrcpMcpClientContextManager:
    def test_connect_and_close_called(self):
        connected = []
        closed = []

        class PatchedClient(UsrcpMcpClient):
            def connect(self):
                connected.append(True)
                self._session = MagicMock()
                self._loop = MagicMock()

            def close(self):
                closed.append(True)
                self._session = None

        with PatchedClient() as c:
            assert c._session is not None

        assert connected == [True]
        assert closed == [True]

    def test_close_called_on_exception(self):
        closed = []

        class PatchedClient(UsrcpMcpClient):
            def connect(self):
                self._session = MagicMock()
                self._loop = MagicMock()

            def close(self):
                closed.append(True)
                self._session = None

        with pytest.raises(ValueError):
            with PatchedClient():
                raise ValueError("boom")

        assert closed == [True]
