"""LangGraph checkpoint introspection and fork API (time-travel primitives)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from nemo_backend.agent_langgraph import _phased_outer_coding_graph_builder, build_nemo_single_outer_graph
from nemo_backend.agents.planning.nested_middleware import PlanningNestedWorkerMiddleware
from nemo_backend.checkpointing import get_graph_checkpointer, outer_agent_thread_id
from nemo_backend.llm import build_llm
from nemo_backend.schemas import CheckpointForkRequest
from nemo_backend.state import get_session, runtime_config

logger = logging.getLogger('nemo.http.checkpoint')

router = APIRouter(prefix='/checkpoint', tags=['checkpoint'])


def _outer_config(session_id: str, *, apply_mode: bool) -> dict[str, Any]:
    phased = bool(apply_mode and runtime_config.tools.outer_phased_coding_cycle)
    return {
        'configurable': {
            'thread_id': outer_agent_thread_id(
                session_id,
                'single',
                apply_mode=apply_mode,
                orchestrated_mode=runtime_config.tools.orchestrated_mode,
                phased_outer_coding=phased,
            ),
        }
    }


def _outer_graph_for_checkpoint(llm: Any, session: Any, apply_mode: bool) -> Any:
    if apply_mode and runtime_config.tools.outer_phased_coding_cycle:
        return _phased_outer_coding_graph_builder(
            llm,
            session,
            apply_mode,
            [PlanningNestedWorkerMiddleware(get_graph_checkpointer())],
        )
    return build_nemo_single_outer_graph(llm, session, apply_mode)


@router.get('/history')
async def checkpoint_history(
    session_id: str,
    apply_mode: bool = True,
    limit: int = 50,
) -> dict[str, Any]:
    """List recent checkpoint snapshots for the outer Clara graph (newest first)."""
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail='limit must be between 1 and 500')
    session = get_session(session_id)
    try:
        llm = build_llm()
    except Exception as exc:
        logger.exception('checkpoint history: LLM bootstrap failed')
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    graph = _outer_graph_for_checkpoint(llm, session, apply_mode)
    config = _outer_config(session_id, apply_mode=apply_mode)
    entries: list[dict[str, Any]] = []
    try:
        async for snap in graph.aget_state_history(config, limit=limit):
            cfg = snap.config.get('configurable') or {}
            entries.append(
                {
                    'checkpoint_id': cfg.get('checkpoint_id'),
                    'thread_id': cfg.get('thread_id'),
                    'next': list(snap.next) if snap.next else [],
                }
            )
    except Exception as exc:
        logger.exception('checkpoint history failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {'session_id': session_id, 'apply_mode': apply_mode, 'entries': entries}


@router.get('/state')
async def checkpoint_state(session_id: str, apply_mode: bool = True) -> dict[str, Any]:
    """Latest checkpoint summary for the outer Clara graph."""
    session = get_session(session_id)
    try:
        llm = build_llm()
    except Exception as exc:
        logger.exception('checkpoint state: LLM bootstrap failed')
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    graph = _outer_graph_for_checkpoint(llm, session, apply_mode)
    config = _outer_config(session_id, apply_mode=apply_mode)
    try:
        snap = await graph.aget_state(config)
    except Exception as exc:
        logger.exception('checkpoint state failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    cfg = snap.config.get('configurable') or {}
    vals = snap.values or {}
    messages = vals.get('messages') if isinstance(vals, dict) else None
    n = len(messages) if isinstance(messages, list) else 0
    return {
        'session_id': session_id,
        'apply_mode': apply_mode,
        'checkpoint_id': cfg.get('checkpoint_id'),
        'thread_id': cfg.get('thread_id'),
        'next': list(snap.next) if snap.next else [],
        'message_count': n,
    }


@router.post('/fork')
async def checkpoint_fork(request: CheckpointForkRequest) -> dict[str, Any]:
    """Branch from ``checkpoint_id`` with optional state ``values`` (LangGraph fork)."""
    cid = request.checkpoint_id.strip()
    if not cid:
        raise HTTPException(status_code=400, detail='checkpoint_id is required')
    session = get_session(request.session_id)
    try:
        llm = build_llm()
    except Exception as exc:
        logger.exception('checkpoint fork: LLM bootstrap failed')
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    graph = _outer_graph_for_checkpoint(llm, session, request.apply_mode)
    base = _outer_config(request.session_id, apply_mode=request.apply_mode)
    base['configurable']['checkpoint_id'] = cid
    try:
        fork_cfg = await graph.aupdate_state(base, values=request.values or {})
    except Exception as exc:
        logger.exception('checkpoint fork failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    out = fork_cfg.get('configurable') or {}
    return {
        'configurable': {
            'thread_id': out.get('thread_id'),
            'checkpoint_id': out.get('checkpoint_id'),
            'checkpoint_ns': out.get('checkpoint_ns', ''),
        }
    }
