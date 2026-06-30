"""LangChain tools: semantic retrieval over the indexed workspace."""

from __future__ import annotations

import logging
from pathlib import Path

from langchain_core.tools import tool

from nemo_backend.config import NEMO_LLAMA_INDEX_MAX_FILES
from nemo_backend.state import current_session_id, get_active_connection, get_session
from nemo_backend.workspace_index.embeddings_factory import build_embedding_model, resolve_embedding_model_id
from nemo_backend.workspace_index.incremental import flush_semantic_index_patches
from nemo_backend.workspace_index.index_build import load_or_rebuild_workspace_index
from nemo_backend.workspace_index.lifecycle import cached_workspace_fingerprint

logger = logging.getLogger('nemo.workspace_index.semantic')

RETRIEVE_WORKSPACE_SEMANTIC_NAME = 'retrieve_workspace_semantic'
RETRIEVE_WORKSPACE_CHECKPOINT_SEMANTIC_NAME = 'retrieve_workspace_checkpoint_semantic'

_MAX_TOOL_CHARS = 24_000


def _header_lines() -> list[str]:
    return [
        'Chunks: on-disk workspace index only.',
        '1. Treat as hints; verify with `read_workspace_file`, LSP, or `search_workspace`.',
        '2. Staged drafts are not indexed—use `search_staged_edits` or `read_staged_edit` for pending edits.',
        '',
    ]


def _retrieve_semantic_impl(query: str, top_k: int) -> str:
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

    try:
        conn = get_active_connection()
        mid = resolve_embedding_model_id(conn)
        embed_model, err = build_embedding_model(conn)
        if embed_model is None:
            return err or 'Semantic index unavailable.'
        root = Path(root_s).resolve()
        wid = (session.workspace_id or '').strip()
        try:
            flush_semantic_index_patches(sid, session, root, wid, embed_model, embedding_model_id=mid)
        except Exception as exc:
            logger.debug('semantic index flush skipped: %s', exc)

        fp = cached_workspace_fingerprint(root, max_files=NEMO_LLAMA_INDEX_MAX_FILES)
        w_index, w_err = load_or_rebuild_workspace_index(
            root, wid, embed_model, fingerprint_override=fp, embedding_model_id=mid
        )
        if w_err:
            return w_err
        if w_index is None:
            return (
                'Semantic index: no indexable workspace content '
                '(empty tree, or paths skipped by ignore rules / non-text extensions). '
                'Try `search_workspace` or `list_workspace_directory`, or enable '
                'Settings → Tools → Expose all workspace files.'
            )

        hits = w_index.as_retriever(similarity_top_k=k).retrieve(q)
    except Exception as exc:
        logger.warning('semantic retrieve failed: %s', exc, exc_info=True)
        return f'Semantic index error ({type(exc).__name__}: {exc}).'

    if not hits:
        return 'Semantic index: no relevant chunks found.'

    from nemo_backend.tools.workspace import truncate_text

    lines: list[str] = _header_lines()
    for i, nws in enumerate(hits, start=1):
        node = nws.node
        score = getattr(nws, 'score', None)
        meta = getattr(node, 'metadata', None) or {}
        path = meta.get('file_path', meta.get('file_name', '(unknown path)'))
        text = (getattr(node, 'text', None) or '').strip()
        excerpt = truncate_text(text, 1800)
        if isinstance(score, float):
            score_s = f'{score:.4f}'
        elif score is None:
            score_s = 'n/a'
        else:
            score_s = str(score)
        lines.append(f'--- {i}. file={path} score={score_s} ---')
        lines.append(excerpt if excerpt else '[empty chunk]')
        lines.append('')

    out = '\n'.join(lines).strip()
    if len(out) > _MAX_TOOL_CHARS:
        out = truncate_text(out, _MAX_TOOL_CHARS) + '\n... [truncated]'
    return out


@tool(RETRIEVE_WORKSPACE_SEMANTIC_NAME)
def retrieve_workspace_semantic(query: str, top_k: int = 8) -> str:
    """Topical semantic retrieval over the indexed on-disk workspace (chunks, not full files).

    When: unknown targets or repo-wide “where is X?”; broad discovery before precise reads.
    Not: exact string search (use `search_workspace` on disk or `search_staged_edits` for drafts); literal file text (use `read_workspace_file` / `read_staged_edit` after picking a path).
    Shape: natural-language `query`; `top_k` capped (default 8). Verify hits with `read_workspace_file`, LSP, or `search_workspace` (see output header). Staged drafts are not indexed."""
    return _retrieve_semantic_impl(query, top_k)


@tool(RETRIEVE_WORKSPACE_CHECKPOINT_SEMANTIC_NAME)
def retrieve_workspace_checkpoint_semantic(query: str, top_k: int = 8) -> str:
    """Semantic retrieval over the on-disk workspace index (same corpus as `retrieve_workspace_semantic`).

    When: nested recon / checkpoint-authoritative phase; same discovery as full semantic but disk plane only.
    Not: staging recall (use `search_staged_edits` or `read_staged_edit`); exact grep (use `search_workspace`).
    Shape: same as `retrieve_workspace_semantic`; verify hits with `read_workspace_file`, LSP, or `search_workspace` (see output header)."""
    return _retrieve_semantic_impl(query, top_k)
