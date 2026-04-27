"""USRCP Hermes memory provider plugin.

Implements Hermes' ``MemoryProvider`` ABC using USRCP's local MCP server
(``usrcp serve``) as the backend.  The ledger logic stays TypeScript; this
plugin is a thin Python wrapper that translates Hermes lifecycle hooks into
USRCP MCP tool calls.

Architecture
------------
- ``initialize()`` spawns ``usrcp serve`` as a subprocess and establishes an
  MCP stdio connection via the official ``mcp`` Python SDK.
- ``prefetch()`` calls ``usrcp_search_timeline`` and returns formatted context.
- ``sync_turn()`` calls ``usrcp_append_event`` with the combined turn text.
- ``system_prompt_block()`` calls ``usrcp_get_state`` for identity/preferences.
- ``handle_tool_call()`` proxies all ``usrcp_*`` tool calls to the MCP client.
- ``shutdown()`` closes the MCP session and terminates the subprocess.

Optional hooks (on_session_end, on_pre_compress, on_delegation,
on_memory_write) are deferred to v0.2.

Discovery
---------
The Hermes plugin loader checks for ``MemoryProvider`` or
``register_memory_provider`` in ``__init__.py`` source text.  Both are
present here — ``UsrcpMemoryProvider`` subclasses ``MemoryProvider`` and
``register()`` calls ``ctx.register_memory_provider()``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

from .client import UsrcpMcpClient, UsrcpMcpError, is_usrcp_available
from .config import get_config_schema
from .tools import extract_mcp_text, mcp_search_to_context_text, mcp_state_to_system_text

logger = logging.getLogger(__name__)

# Tools exposed to Hermes' LLM (subset of the full USRCP tool list).
# Schemas follow the OpenAI function-calling format.
_TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "usrcp_get_state",
        "description": (
            "Query the user's identity, preferences, active projects, domain context, "
            "and recent interaction timeline from their USRCP State Ledger."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "scopes": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "core_identity",
                            "global_preferences",
                            "recent_timeline",
                            "domain_context",
                            "active_projects",
                        ],
                    },
                    "description": "Which facets of user state to retrieve.",
                },
                "timeline_last_n": {
                    "type": "integer",
                    "description": "Number of recent timeline events to retrieve (1-500).",
                },
                "timeline_domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter timeline to specific domains.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "usrcp_append_event",
        "description": (
            "Record an interaction event to the user's USRCP State Ledger. "
            "Call when a meaningful interaction completes."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {
                    "type": "string",
                    "description": "Semantic domain: coding, writing, research, design, personal, etc.",
                },
                "summary": {
                    "type": "string",
                    "description": "Concise summary of what happened (max 500 chars).",
                },
                "intent": {
                    "type": "string",
                    "description": "What the user was trying to accomplish (max 300 chars).",
                },
                "outcome": {
                    "type": "string",
                    "enum": ["success", "partial", "failed", "abandoned"],
                    "description": "How the interaction resolved.",
                },
                "platform": {
                    "type": "string",
                    "description": "Platform this event originated from.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Freeform tags for filtering and search.",
                },
                "detail": {
                    "type": "object",
                    "description": "Structured detail blob — varies by domain.",
                },
            },
            "required": ["domain", "summary", "intent", "outcome"],
        },
    },
    {
        "name": "usrcp_search_timeline",
        "description": (
            "Search the user's interaction timeline by keyword. "
            "Useful for finding past interactions, decisions, or context about specific topics."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query — matches against summary, intent, and tags.",
                },
                "domain": {
                    "type": "string",
                    "description": "Filter to a specific domain.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (1-100, default 20).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "usrcp_set_fact",
        "description": (
            "Store a free-form fact in a domain namespace. "
            "Use for data the fixed schema doesn't model (habits, relationships, goals, etc.)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "Semantic domain."},
                "namespace": {"type": "string", "description": "Namespace within domain."},
                "key": {"type": "string", "description": "Key within namespace."},
                "value": {"description": "Free-form JSON-serializable value."},
            },
            "required": ["domain", "namespace", "key", "value"],
        },
    },
    {
        "name": "usrcp_get_facts",
        "description": "Read schemaless facts from the USRCP ledger.",
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "Domain to read from."},
                "namespace": {"type": "string", "description": "Optional namespace filter."},
                "key": {"type": "string", "description": "Optional single-fact key."},
            },
            "required": ["domain"],
        },
    },
    {
        "name": "usrcp_status",
        "description": "Get the status and statistics of the local USRCP ledger.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
]

# Tool names dispatched to the MCP client without transformation
_PASSTHROUGH_TOOLS = {s["name"] for s in _TOOL_SCHEMAS}

_CALLER_TAG = "hermes"


class UsrcpMemoryProvider(MemoryProvider):
    """Hermes MemoryProvider backed by the USRCP local MCP server.

    One MCP client (and one ``usrcp serve`` subprocess) per provider
    instance.  Concurrent sessions are not supported in v0 — one instance
    per Hermes session.
    """

    def __init__(self) -> None:
        self._user_slug: str = "default"
        self._client: Optional[UsrcpMcpClient] = None
        self._session_id: str = ""
        self._active: bool = False
        self._write_enabled: bool = True
        self._sync_thread: Optional[threading.Thread] = None
        self._prefetch_result: str = ""

    # ------------------------------------------------------------------
    # MemoryProvider required properties
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return "usrcp"

    # ------------------------------------------------------------------
    # Core lifecycle
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        """Return True if ``usrcp`` binary is on PATH and the ledger DB exists.

        Never makes network calls — pure filesystem check.
        """
        return is_usrcp_available(self._user_slug)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Spawn ``usrcp serve`` and establish the MCP stdio connection.

        kwargs recognised:
        - ``hermes_home`` (str): HERMES_HOME directory (unused by USRCP, kept for compat)
        - ``agent_context`` (str): skip writes for "cron"/"flush"/"subagent"
        - ``platform`` (str): passed as ``caller`` to USRCP audit log
        """
        self._session_id = session_id
        agent_context = kwargs.get("agent_context", "")
        self._write_enabled = agent_context not in ("cron", "flush", "subagent")

        # Read user_slug from env or fall back to "default"
        self._user_slug = os.environ.get("USRCP_USER_SLUG", "default")

        try:
            self._client = UsrcpMcpClient(
                user_slug=self._user_slug,
                caller=_CALLER_TAG,
            )
            self._client.connect()
            self._active = True
            logger.debug("USRCP MCP client connected (session=%s)", session_id)
        except Exception:
            logger.warning("USRCP MCP client failed to connect", exc_info=True)
            self._client = None
            self._active = False

    def system_prompt_block(self) -> str:
        """Inject user identity and preferences into the system prompt.

        Calls ``usrcp_get_state`` with identity + preferences scopes.
        Returns empty string if not active or the call fails.
        """
        if not self._active or not self._client:
            return ""
        try:
            raw = self._client.call_tool(
                "usrcp_get_state",
                {
                    "scopes": ["core_identity", "global_preferences", "domain_context"],
                    "caller": _CALLER_TAG,
                },
            )
            text = extract_mcp_text(raw)
            if not text:
                return ""
            return mcp_state_to_system_text(text)
        except UsrcpMcpError:
            logger.debug("USRCP system_prompt_block failed", exc_info=True)
            return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Search the USRCP timeline for context relevant to ``query``.

        Calls ``usrcp_search_timeline`` and formats results as a text block.
        Returns empty string on failure or if nothing relevant is found.
        """
        if not self._active or not self._client or not query.strip():
            return ""
        try:
            raw = self._client.call_tool(
                "usrcp_search_timeline",
                {
                    "query": query[:200],
                    "limit": 10,
                    "caller": _CALLER_TAG,
                },
            )
            text = extract_mcp_text(raw)
            if not text:
                return ""
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                return ""
            return mcp_search_to_context_text(parsed)
        except UsrcpMcpError:
            logger.debug("USRCP prefetch failed", exc_info=True)
            return ""

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:
        """Write a completed turn as a single USRCP timeline event.

        Fires in a daemon thread so it doesn't block the Hermes response loop.
        Skips writes when not active, write-disabled (cron/flush), or when
        either message is trivially short.

        Design note: one combined event per turn pair (not two separate events)
        to avoid doubling event volume while preserving search granularity.
        """
        if not self._active or not self._write_enabled or not self._client:
            return

        user = (user_content or "").strip()
        assistant = (assistant_content or "").strip()
        if len(user) < 10 or len(assistant) < 10:
            return

        def _run() -> None:
            try:
                summary = user[:300] if len(user) <= 300 else user[:297] + "..."
                intent = user[:300] if len(user) <= 300 else user[:297] + "..."
                self._client.call_tool(
                    "usrcp_append_event",
                    {
                        "domain": "chat",
                        "summary": summary,
                        "intent": intent,
                        "outcome": "success",
                        "platform": _CALLER_TAG,
                        "session_id": self._session_id or session_id,
                        "detail": {
                            "user_message": user[:500],
                            "assistant_message": assistant[:500],
                        },
                    },
                )
            except UsrcpMcpError:
                logger.debug("USRCP sync_turn failed", exc_info=True)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=2.0)
        self._sync_thread = threading.Thread(
            target=_run, daemon=True, name="usrcp-sync-turn"
        )
        self._sync_thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return OpenAI-format schemas for USRCP tools exposed to the LLM."""
        return list(_TOOL_SCHEMAS)

    def handle_tool_call(
        self, tool_name: str, args: Dict[str, Any], **kwargs: Any
    ) -> str:
        """Proxy a tool call to the USRCP MCP server.

        All ``usrcp_*`` tool names in ``_PASSTHROUGH_TOOLS`` are dispatched
        directly.  Returns a JSON string as required by the Hermes contract.
        """
        if not self._active or not self._client:
            return json.dumps({"error": "USRCP is not connected"})
        if tool_name not in _PASSTHROUGH_TOOLS:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
        try:
            # Add caller tag for audit log where the tool accepts it
            enriched_args = dict(args)
            if tool_name in (
                "usrcp_get_state",
                "usrcp_search_timeline",
                "usrcp_set_fact",
            ):
                enriched_args.setdefault("caller", _CALLER_TAG)
            raw = self._client.call_tool(tool_name, enriched_args)
            text = extract_mcp_text(raw)
            if text is not None:
                return text
            # Fallback: serialise raw content
            return json.dumps({"content": str(raw)})
        except UsrcpMcpError as exc:
            return json.dumps({"error": str(exc)})

    def shutdown(self) -> None:
        """Join the sync thread, close the MCP session, terminate subprocess."""
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = None

        if self._client:
            try:
                self._client.close()
            except Exception:
                logger.debug("USRCP client close error", exc_info=True)
            self._client = None

        self._active = False

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return get_config_schema()

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Save non-secret config to ``$HERMES_HOME/usrcp.json`` (0600)."""
        import stat

        config_path = Path(hermes_home) / "usrcp.json"
        existing: Dict[str, Any] = {}
        if config_path.exists():
            try:
                existing = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update(values or {})
        config_path.write_text(
            json.dumps(existing, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        config_path.chmod(0o600)


def register(ctx: Any) -> None:
    """Plugin registration hook — called by Hermes' plugin loader.

    ``ctx.register_memory_provider`` is the _ProviderCollector method from
    ``plugins/memory/__init__.py``.
    """
    ctx.register_memory_provider(UsrcpMemoryProvider())
