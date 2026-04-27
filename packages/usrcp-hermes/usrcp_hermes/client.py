"""USRCP Hermes plugin — MCP stdio client wrapper.

Spawns ``usrcp serve`` as a subprocess and manages the MCP stdio connection
using the official ``mcp`` Python SDK (``mcp.ClientSession`` +
``mcp.client.stdio.stdio_client``).

Usage::

    with UsrcpMcpClient(user_slug="default") as client:
        result = client.call_tool("usrcp_get_state", {"scopes": ["core_identity"]})
        print(result)

The context manager owns the subprocess lifetime.  Do not share a single
client instance across threads — create one per Hermes session.

Design notes
------------
- We use ``asyncio.run()`` in a dedicated thread so the synchronous
  Hermes plugin interface can call into the async MCP SDK without
  restructuring the caller.
- The subprocess is killed on ``close()`` or on ``__exit__``.
- If ``usrcp serve`` crashes mid-session, ``call_tool`` raises
  ``UsrcpMcpError`` and logs the full exchange.  The caller (the provider)
  is responsible for catching and handling it gracefully.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class UsrcpMcpError(RuntimeError):
    """Raised when an MCP tool call fails or the client is not connected."""


class UsrcpMcpClient:
    """Thin synchronous wrapper around the USRCP MCP stdio server.

    Parameters
    ----------
    user_slug:
        The USRCP user slug (``~/.usrcp/users/<slug>/``).  Passed as
        ``--user`` to ``usrcp serve`` if the CLI supports it.
    usrcp_bin:
        Override the ``usrcp`` binary path.  Auto-detected via ``shutil.which``
        if not supplied.
    caller:
        Identifies this client in USRCP audit logs.
    """

    def __init__(
        self,
        user_slug: str = "default",
        usrcp_bin: Optional[str] = None,
        caller: str = "hermes",
    ) -> None:
        self._user_slug = user_slug
        self._caller = caller
        self._usrcp_bin = usrcp_bin or shutil.which("usrcp") or "usrcp"
        self._session: Any = None  # mcp.ClientSession
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._context_stack: Any = None  # async context manager stack
        self._error: Optional[Exception] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """Spawn the subprocess and establish the MCP stdio connection.

        Blocks until the session is ready or raises ``UsrcpMcpError``.
        """
        if self._session is not None:
            return

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_event_loop,
            daemon=True,
            name="usrcp-mcp-loop",
        )
        self._thread.start()

        # Wait up to 30 s for the MCP handshake to complete
        if not self._ready.wait(timeout=30):
            self._stop.set()
            raise UsrcpMcpError(
                "Timed out waiting for USRCP MCP server to start. "
                "Check that `usrcp serve` works from your shell."
            )
        if self._error:
            raise UsrcpMcpError(f"USRCP MCP connect failed: {self._error}") from self._error

    def close(self) -> None:
        """Close the MCP session and terminate the subprocess."""
        if self._loop and not self._stop.is_set():
            self._stop.set()
            if self._thread and self._thread.is_alive():
                self._thread.join(timeout=10)
        self._session = None
        self._loop = None
        self._thread = None

    def call_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        """Call an USRCP MCP tool synchronously.

        Returns the parsed content from the MCP response (a list of content
        dicts, e.g. ``[{"type": "text", "text": "..."}]``).

        Raises ``UsrcpMcpError`` if not connected or the call fails.
        """
        if self._session is None or self._loop is None:
            raise UsrcpMcpError("UsrcpMcpClient is not connected. Call connect() first.")

        future = asyncio.run_coroutine_threadsafe(
            self._async_call_tool(tool_name, args),
            self._loop,
        )
        try:
            return future.result(timeout=60)
        except Exception as exc:
            raise UsrcpMcpError(f"Tool call '{tool_name}' failed: {exc}") from exc

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "UsrcpMcpClient":
        self.connect()
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Internal async machinery
    # ------------------------------------------------------------------

    def _run_event_loop(self) -> None:
        """Entry point for the background thread — owns the event loop."""
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._async_session_lifetime())
        except Exception as exc:
            logger.debug("UsrcpMcpClient event loop exited with error: %s", exc)
        finally:
            self._loop.close()

    async def _async_session_lifetime(self) -> None:
        """Async coroutine that holds the MCP stdio session alive.

        Signals ``_ready`` once the session is initialized, then blocks
        until ``_stop`` is set.
        """
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError as exc:
            self._error = exc
            self._ready.set()
            return

        cmd_args = ["serve"]
        if self._user_slug and self._user_slug != "default":
            cmd_args += ["--user", self._user_slug]

        server_params = StdioServerParameters(
            command=self._usrcp_bin,
            args=cmd_args,
            env=None,
        )

        try:
            async with stdio_client(server_params) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    self._session = session
                    self._ready.set()
                    logger.debug(
                        "USRCP MCP session initialized (user_slug=%s)", self._user_slug
                    )

                    # Keep the session alive until shutdown is requested
                    while not self._stop.is_set():
                        await asyncio.sleep(0.1)

                    self._session = None
                    logger.debug("USRCP MCP session closing")
        except Exception as exc:
            self._error = exc
            self._ready.set()
            logger.warning("USRCP MCP session failed: %s", exc)

    async def _async_call_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        """Async tool call — runs in the background event loop."""
        if self._session is None:
            raise UsrcpMcpError("No active MCP session")

        result = await self._session.call_tool(tool_name, args)
        # result.content is a list of ContentBlock objects or dicts
        content = getattr(result, "content", result)
        return content


# ---------------------------------------------------------------------------
# Availability check (no import of heavy deps)
# ---------------------------------------------------------------------------

def is_usrcp_available(user_slug: str = "default") -> bool:
    """Return True if ``usrcp`` binary is on PATH and the ledger DB exists.

    Does NOT make network calls or spawn subprocesses.
    """
    if not shutil.which("usrcp"):
        return False

    ledger_path = Path.home() / ".usrcp" / "users" / user_slug / "ledger.db"
    return ledger_path.exists()
