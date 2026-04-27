"""Pytest configuration for usrcp-hermes tests.

Two responsibilities:

1. Add the package's parent directory to ``sys.path`` so ``import usrcp_hermes``
   works without an editable pip install.
2. Stub ``agent.memory_provider`` (the Hermes ABC) before the package is loaded,
   since Hermes is not installed in this repo's test environment.
"""

from __future__ import annotations

import sys
import types
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# 1. Make ``usrcp_hermes`` importable
# ---------------------------------------------------------------------------

_PKG_PARENT = Path(__file__).parent.parent  # packages/usrcp-hermes/
if str(_PKG_PARENT) not in sys.path:
    sys.path.insert(0, str(_PKG_PARENT))

# ---------------------------------------------------------------------------
# 2. Stub ``agent.memory_provider`` — must happen before usrcp_hermes is loaded
# ---------------------------------------------------------------------------


def _install_stubs() -> None:
    if "agent.memory_provider" in sys.modules:
        return

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...

        @abstractmethod
        def is_available(self) -> bool: ...

        @abstractmethod
        def initialize(self, session_id: str, **kwargs) -> None: ...

        def system_prompt_block(self) -> str:
            return ""

        def prefetch(self, query: str, *, session_id: str = "") -> str:
            return ""

        def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
            pass

        @abstractmethod
        def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

        def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
            raise NotImplementedError

        def shutdown(self) -> None:
            pass

        def get_config_schema(self) -> List[Dict[str, Any]]:
            return []

        def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
            pass

    agent_pkg = types.ModuleType("agent")
    mp_mod = types.ModuleType("agent.memory_provider")
    mp_mod.MemoryProvider = MemoryProvider  # type: ignore[attr-defined]
    agent_pkg.memory_provider = mp_mod  # type: ignore[attr-defined]
    sys.modules["agent"] = agent_pkg
    sys.modules["agent.memory_provider"] = mp_mod


_install_stubs()
