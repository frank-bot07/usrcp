"""USRCP Hermes plugin — MCP result translation helpers.

Converts raw MCP tool responses from the USRCP server into human-readable
text blocks suitable for injection into Hermes' context window.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def mcp_search_to_context_text(mcp_response: Any) -> str:
    """Convert a ``usrcp_search_timeline`` MCP response to context text.

    ``mcp_response`` is the parsed JSON dict returned by the MCP tool call.
    Returns an empty string if there are no events or parsing fails.
    """
    if not mcp_response:
        return ""

    try:
        if isinstance(mcp_response, str):
            mcp_response = json.loads(mcp_response)
    except (json.JSONDecodeError, TypeError):
        return ""

    events: List[Dict[str, Any]] = mcp_response.get("events", [])
    if not events:
        return ""

    lines: List[str] = []
    for evt in events:
        summary = str(evt.get("summary", "")).strip()
        intent = str(evt.get("intent", "")).strip()
        domain = str(evt.get("domain", "")).strip()
        ts = str(evt.get("timestamp", "") or evt.get("created_at", "")).strip()

        parts: List[str] = []
        if ts:
            # Trim to date+hour for readability
            parts.append(f"[{ts[:16]}]")
        if domain:
            parts.append(f"[{domain}]")
        if summary:
            parts.append(summary)
        if intent and intent != summary:
            parts.append(f"(intent: {intent})")

        if parts:
            lines.append("- " + " ".join(parts))

    if not lines:
        return ""

    header = (
        "## USRCP Timeline (relevant past interactions)\n"
        "The following events are from your cross-platform interaction history. "
        "Use this context silently when relevant."
    )
    return f"<usrcp-context>\n{header}\n\n" + "\n".join(lines) + "\n</usrcp-context>"


def mcp_state_to_system_text(mcp_response: Any) -> str:
    """Convert a ``usrcp_get_state`` MCP response to a system-prompt block.

    Formats identity, preferences, and domain_context from the state object
    into a compact text block.  Returns empty string if no relevant data.
    """
    if not mcp_response:
        return ""

    try:
        if isinstance(mcp_response, str):
            mcp_response = json.loads(mcp_response)
    except (json.JSONDecodeError, TypeError):
        return ""

    state: Dict[str, Any] = mcp_response.get("state", mcp_response)
    if not state:
        return ""

    sections: List[str] = []

    # Core identity
    identity = state.get("core_identity") or {}
    if identity:
        id_lines: List[str] = []
        if identity.get("display_name"):
            id_lines.append(f"Name: {identity['display_name']}")
        if identity.get("roles"):
            id_lines.append(f"Roles: {', '.join(identity['roles'])}")
        if identity.get("communication_style"):
            id_lines.append(f"Preferred style: {identity['communication_style']}")
        if identity.get("expertise_domains"):
            expertise = [
                f"{e['domain']} ({e['level']})"
                for e in identity["expertise_domains"]
                if isinstance(e, dict)
            ]
            if expertise:
                id_lines.append(f"Expertise: {', '.join(expertise)}")
        if id_lines:
            sections.append("## User Identity\n" + "\n".join(id_lines))

    # Global preferences
    prefs = state.get("global_preferences") or {}
    if prefs:
        pref_lines: List[str] = []
        for k in ("language", "timezone", "output_format", "verbosity"):
            v = prefs.get(k)
            if v:
                pref_lines.append(f"{k}: {v}")
        custom = prefs.get("custom") or {}
        if isinstance(custom, dict):
            for k, v in custom.items():
                pref_lines.append(f"{k}: {v}")
        if pref_lines:
            sections.append("## User Preferences\n" + "\n".join(pref_lines))

    # Domain context (top-level keys only — avoid verbosity)
    domain_ctx = state.get("domain_context") or {}
    if isinstance(domain_ctx, dict) and domain_ctx:
        ctx_lines = [f"- {domain}: {json.dumps(ctx)}" for domain, ctx in domain_ctx.items()]
        sections.append("## Domain Context\n" + "\n".join(ctx_lines))

    if not sections:
        return ""

    body = "\n\n".join(sections)
    return f"# USRCP User Context\n{body}"


def extract_mcp_text(tool_result: Any) -> Optional[str]:
    """Pull the text payload out of an MCP tool result.

    MCP tool results are a list of content objects:
    ``[{"type": "text", "text": "..."}]``.
    Returns the first text block, or None if parsing fails.
    """
    if not tool_result:
        return None

    content_list: List[Any] = []
    if isinstance(tool_result, list):
        content_list = tool_result
    elif isinstance(tool_result, dict):
        content_list = tool_result.get("content", [])

    for item in content_list:
        if isinstance(item, dict) and item.get("type") == "text":
            return item.get("text")
        # Handle SDK object with .type / .text attrs
        try:
            if getattr(item, "type", None) == "text":
                return getattr(item, "text", None)
        except Exception:
            pass

    return None
