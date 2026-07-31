"""LlamaIndex-backed workspace semantic index (lazy build; persisted under app ``CLARA_WORKSPACE_INDEX_DIR``)."""

from __future__ import annotations

from clara_coder_backend.workspace_index.lifecycle import invalidate_workspace_index_disk

__all__ = [
    'invalidate_workspace_index_disk',
]
