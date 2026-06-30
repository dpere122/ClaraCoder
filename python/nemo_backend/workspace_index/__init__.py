"""LlamaIndex-backed workspace semantic index (lazy build; persisted under app ``NEMO_WORKSPACE_INDEX_DIR``)."""

from __future__ import annotations

from nemo_backend.workspace_index.lifecycle import invalidate_workspace_index_disk

__all__ = [
    'invalidate_workspace_index_disk',
]
