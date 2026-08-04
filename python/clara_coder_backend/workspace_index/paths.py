"""Filesystem paths for the workspace semantic index (internal app data, not under workspace root)."""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import hashlib
import os
import tempfile
from pathlib import Path


def semantic_index_base_dir() -> Path:
    """Root directory for all semantic index persistence (Electron sets ``CLARA_WORKSPACE_INDEX_DIR``)."""
    raw = env_clara('CLARA_WORKSPACE_INDEX_DIR', '').strip()
    if raw:
        return Path(raw).resolve()
    return (Path(tempfile.gettempdir()).resolve() / 'nemo-workspace-semantic-index')


def workspace_index_bucket_id(workspace_id: str, workspace_root: Path) -> str:
    """Stable directory name for the workspace corpus (never uses raw workspace path as folder name)."""
    wid = (workspace_id or '').strip()
    if wid:
        # Sanitize for cross-platform dir names
        safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in wid)[:200] or 'workspace'
        return safe
    digest = hashlib.sha256(str(workspace_root.resolve()).encode('utf-8')).hexdigest()[:24]
    return f'root_{digest}'


def workspace_index_persist_dir(workspace_id: str, workspace_root: Path) -> Path:
    """Directory where LlamaIndex ``persist`` writes for the workspace corpus."""
    return semantic_index_base_dir() / 'workspaces' / workspace_index_bucket_id(workspace_id, workspace_root)


def staging_index_persist_dir(session_id: str) -> Path:
    """Legacy session-scoped persist dir; kept only for cleanup of old staging indexes."""
    sid = (session_id or '').strip()
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in sid)[:200] or 'session'
    return semantic_index_base_dir() / 'sessions' / safe / 'staging'


def index_persist_dir(workspace_root: Path) -> Path:
    """Deprecated layout: ``<workspace>/.nemo/llama_index``. Kept for tests that monkeypatch paths."""
    return workspace_root.resolve() / '.nemo' / 'llama_index'
