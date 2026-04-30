"""LangChain tools: semantic retrieval over the indexed workspace (optional nested staging merge)."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from langchain_core.tools import tool

from nemo_backend.config import NEMO_LLAMA_INDEX_MAX_FILES
from nemo_backend.state import current_session_id, get_active_connection, get_session
from nemo_backend.workspace_index.embeddings_factory import build_embedding_model
from nemo_backend.workspace_index.incremental import flush_semantic_index_patches
from nemo_backend.workspace_index.index_build import load_or_rebuild_staging_index, load_or_rebuild_workspace_index
from nemo_backend.workspace_index.lifecycle import cached_staging_fingerprint, cached_workspace_fingerprint

logger = logging.getLogger('nemo.workspace_index.semantic')

RETRIEVE_WORKSPACE_SEMANTIC_NAME = 'retrieve_workspace_semantic'
RETRIEVE_WORKSPACE_CHECKPOINT_SEMANTIC_NAME = 'retrieve_workspace_checkpoint_semantic'

_MAX_TOOL_CHARS = 24_000


def _hit_score(nws: object) -> float:
    s = getattr(nws, 'score', None)
    try:
        return float(s) if s is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _header_for_scope(scope: Literal['full', 'checkpoint']) -> list[str]:
    if scope == 'checkpoint':
        return [
            'Chunks: on-disk workspace / checkpoint index only (no staging).',
            '1. Treat as hints; verify with `read_workspace_file`, LSP, or `search_workspace`.',
            '',
        ]
    return [
        'Chunks: workspace checkpoint + optional staging index.',
        '1. Treat as hints; check each hit `origin`.',
        '2. origin=workspace → verify with `read_workspace_file`, LSP, or `search_workspace` (disk).',
        '3. origin=staging → verify with `read_staged_edit` or `diff_staged_edit_against_baseline` (disk `read_workspace_file` is checkpoint until `transfer_staged_file_to_workspace`).',
        '',
    ]


def _retrieve_semantic_impl(query: str, top_k: int, *, include_nested_staging: bool) -> str:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    root_s = (session.workspace_path or '').strip()
    if not root_s:
        return 'Semantic index: no workspace is attached to this conversation.'

    q = (query or '').strip()
    if not q:
        return 'Semantic index: empty query.'

    k = max(1, min(int(top_k), 25))
    scope: Literal['full', 'checkpoint'] = 'full' if include_nested_staging else 'checkpoint'

    try:
        embed_model, err = build_embedding_model(get_active_connection())
        if embed_model is None:
            return err or 'Semantic index unavailable.'
        root = Path(root_s).resolve()
        wid = (session.workspace_id or '').strip()
        try:
            flush_semantic_index_patches(sid, session, root, wid, embed_model)
        except Exception as exc:
            logger.debug('semantic index flush skipped: %s', exc)

        fp = cached_workspace_fingerprint(root, max_files=NEMO_LLAMA_INDEX_MAX_FILES)
        w_index, w_err = load_or_rebuild_workspace_index(root, wid, embed_model, fingerprint_override=fp)
        if w_err:
            return w_err

        s_index = None
        if include_nested_staging and sid:
            graph_id = (session.active_planner_graph_id or '').strip()
            sfp = cached_staging_fingerprint(sid, graph_id, max_files=NEMO_LLAMA_INDEX_MAX_FILES)
            s_index, _s_err = load_or_rebuild_staging_index(
                sid, graph_id, embed_model, fingerprint_override=sfp or None
            )

        hits: list = []
        if w_index is not None:
            hits.extend(w_index.as_retriever(similarity_top_k=k).retrieve(q))
        if s_index is not None:
            hits.extend(s_index.as_retriever(similarity_top_k=k).retrieve(q))
        hits.sort(key=_hit_score, reverse=True)
        hits = hits[:k]
    except Exception as exc:
        logger.warning('semantic retrieve failed: %s', exc, exc_info=True)
        return f'Semantic index error ({type(exc).__name__}: {exc}).'

    if not hits:
        return 'Semantic index: no relevant chunks found.'

    from nemo_backend.workspace_tools import truncate_text

    lines: list[str] = _header_for_scope(scope)
    for i, nws in enumerate(hits, start=1):
        node = nws.node
        score = getattr(nws, 'score', None)
        meta = getattr(node, 'metadata', None) or {}
        path = meta.get('file_path', meta.get('file_name', '(unknown path)'))
        origin = meta.get('origin', 'workspace')
        text = (getattr(node, 'text', None) or '').strip()
        excerpt = truncate_text(text, 1800)
        if isinstance(score, float):
            score_s = f'{score:.4f}'
        elif score is None:
            score_s = 'n/a'
        else:
            score_s = str(score)
        lines.append(f'--- {i}. origin={origin} file={path} score={score_s} ---')
        lines.append(excerpt if excerpt else '[empty chunk]')
        lines.append('')

    out = '\n'.join(lines).strip()
    if len(out) > _MAX_TOOL_CHARS:
        out = truncate_text(out, _MAX_TOOL_CHARS) + '\n... [truncated]'
    return out


@tool(RETRIEVE_WORKSPACE_SEMANTIC_NAME)
def retrieve_workspace_semantic(query: str, top_k: int = 8) -> str:
    """Topical semantic retrieval over indexed workspace + nested staging (chunks, not full files).

    When: unknown targets or repo-wide “where is X?”; broad discovery before precise reads.
    Not: exact string search (use `search_workspace` disk or `search_staged_edits` drafts); literal file text (use `read_workspace_file` / `read_staged_edit` after picking a path).
    Shape: natural-language `query`; `top_k` capped (default 8). Verify every hit by `origin` (see output header). LSP-backed paths (`.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`): prefer LSP on that path before trusting chunks alone. Index lives outside workspace; refreshes from watcher/embeddings when available—otherwise returns guidance if embeddings missing."""
    return _retrieve_semantic_impl(query, top_k, include_nested_staging=True)


@tool(RETRIEVE_WORKSPACE_CHECKPOINT_SEMANTIC_NAME)
def retrieve_workspace_checkpoint_semantic(query: str, top_k: int = 8) -> str:
    """Semantic retrieval over **on-disk workspace index only** (staging drafts excluded).

    When: nested recon / checkpoint-authoritative phase; same discovery as full semantic but disk plane only.
    Not: staging recall (use `retrieve_workspace_semantic` or `read_staged_edit`); exact grep (use `search_workspace`).
    Shape: same as `retrieve_workspace_semantic`; verify hits with `read_workspace_file`, LSP, or `search_workspace` (see output header)."""
    return _retrieve_semantic_impl(query, top_k, include_nested_staging=False)
