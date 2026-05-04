"""Pure helpers for when the Electron app should ask the model to refresh a conversation title."""

from __future__ import annotations


def should_refresh_auto_title(assistant_count: int) -> bool:
    """First assistant reply, then every 25th (1, 25, 50, …)."""
    return assistant_count == 1 or (assistant_count > 0 and assistant_count % 25 == 0)
