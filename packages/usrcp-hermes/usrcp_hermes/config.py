"""USRCP Hermes plugin — configuration schema.

Provides ``get_config_schema()`` for the ``hermes memory setup`` wizard.
USRCP's actual runtime configuration lives in ``~/.usrcp/``; the only
Hermes-side value we need is the user slug that identifies which ledger to
open.
"""

from __future__ import annotations

from typing import Any, Dict, List


def get_config_schema() -> List[Dict[str, Any]]:
    """Return config fields required by ``hermes memory setup``.

    The returned list drives the interactive setup wizard.  Each entry
    follows the MemoryProvider.get_config_schema() contract documented
    in agent/memory_provider.py.
    """
    return [
        {
            "key": "user_slug",
            "description": (
                "USRCP user slug — the directory name under ~/.usrcp/users/ "
                "that holds your ledger (default: 'default')"
            ),
            "required": False,
            "default": "default",
        },
    ]
