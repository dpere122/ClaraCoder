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
            'Retrieved chunks (**on-disk workspace / checkpoint index only**; staging drafts are not included). '
            'Verify paths with `read_workspace_file`, LSP, or `search_workspace`:',
            '',
        ]
    return [
        'Retrieved chunks (**workspace checkpoint** + optional **`[staging]`** draft index). '
        'Treat hits as hints—verify by **origin**:',
        '- **origin=workspace** (default): confirm with `read_workspace_file`, LSP, or `search_workspace` (on-disk text).',
        '- **origin=staging**: confirm with `read_staged_edit` or `diff_staged_edit_against_baseline` (draft text). '
        '`read_workspace_file` is the **checkpoint** only; it does **not** show pending drafts until '
        '`transfer_staged_file_to_workspace` succeeds.',
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
    """Semantic search over indexed workspace files and nested-edit staging (code, text, PDFs).

    Prefer this tool first for broad discovery, then narrow with ``search_workspace`` / ``read_workspace_file`` / LSP
    for **workspace** hits, or ``read_staged_edit`` / diff tools for **staging** hits (see tool output header).

    The index is stored under the app data directory (not inside the workspace). It refreshes incrementally from the
    Electron file watcher when embeddings are available; otherwise updates apply on the next call. If the server has no
    embedding model, the tool returns guidance instead of failing silently.
    """
    return _retrieve_semantic_impl(query, top_k, include_nested_staging=True)


@tool(RETRIEVE_WORKSPACE_CHECKPOINT_SEMANTIC_NAME)
def retrieve_workspace_checkpoint_semantic(query: str, top_k: int = 8) -> str:
    """Semantic search over the **on-disk workspace** index only (no nested staging drafts).

    Use in **workspace recon** phases where the checkpoint is authoritative. For drafts after staging, use
    ``read_staged_edit`` or the full ``retrieve_workspace_semantic`` on graphs that include staging in recall.

    Results are hints only—verify with ``read_workspace_file``, LSP, or ``search_workspace``.
    """
    return _retrieve_semantic_impl(query, top_k, include_nested_staging=False)
