"""LangChain tools: semantic retrieval over the indexed workspace."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.config import CLARA_LLAMA_INDEX_MAX_FILES
from clara_coder_backend.tools.tool_conventions import VERIFY_READ, describe
from clara_coder_backend.session.state import current_session_id, get_active_connection, get_session
from clara_coder_backend.workspace_index.embeddings_factory import build_embedding_model, resolve_embedding_model_id
from clara_coder_backend.workspace_index.incremental import flush_semantic_index_patches
from clara_coder_backend.workspace_index.index_build import load_or_rebuild_workspace_index
from clara_coder_backend.workspace_index.lifecycle import cached_workspace_fingerprint

logger = logging.getLogger('clara.workspace_index.semantic')

RETRIEVE_WORKSPACE_SEMANTIC_NAME = 'retrieve_workspace_semantic'

_MAX_TOOL_CHARS = 24_000


def _header_lines() -> list[str]:
    return [
        'Chunks: on-disk workspace index only.',
        '1. Treat as hints; verify with `read_workspace_file`, LSP, or `search_workspace`.',
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

        fp = cached_workspace_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
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

    from clara_coder_backend.tools.workspace import truncate_text

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


@tool(
    RETRIEVE_WORKSPACE_SEMANTIC_NAME,
    description=describe(
        'Topical semantic retrieval over the indexed workspace (chunks, not full files)',
        when='unknown targets or repo-wide “where is X?” before precise reads',
        not_='exact strings (use `search_workspace`); literal file text (use `read_workspace_file`)',
        verify=VERIFY_READ,
    ),
)
def retrieve_workspace_semantic(
    query: Annotated[str, 'natural-language description of what to find'],
    top_k: Annotated[int, 'chunks to return (1-25)'] = 8,
) -> str:
    return _retrieve_semantic_impl(query, top_k)
