"""Tests for the ``after_agent`` leftover-staging return-to-model node."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage

from clara_coder_backend.domain import PendingStagedTransferHitl
from clara_coder_backend.lang_agent.graph import _cleanup_nested_edit_staging
from clara_coder_backend.middleware.flush_untransferred_staging_middleware import (
    FlushUntransferredStagingMiddleware,
    untransferred_draft_review_nudge_text,
)
from clara_coder_backend.tools.staging_edit import stage_create_file


pytestmark = pytest.mark.asyncio(loop_scope='function')


def _stage_py(staging_env, *, name: str, old: str, new: str) -> None:
    ws = staging_env.workspace
    (ws / name).write_text(old, encoding='utf-8')
    stage_create_file.invoke(
        {
            'relative_path': name,
            'new_content': new,
            'encoding': 'utf-8',
            'newline': 'lf',
        }
    )


async def test_flush_node_is_compiled_onto_create_agent_graph() -> None:
    mw = FlushUntransferredStagingMiddleware()
    assert mw.aafter_agent.__can_jump_to__ == ['model']
    graph = create_agent(
        FakeListChatModel(responses=['ok']),
        [],
        middleware=[mw],
    )
    assert 'FlushUntransferredStagingMiddleware.after_agent' in graph.nodes


async def test_after_agent_noop_without_untransferred_drafts(staging_env) -> None:
    session = staging_env.session
    session.worker_apply_mode = True
    mw = FlushUntransferredStagingMiddleware()
    assert await mw.aafter_agent({}, MagicMock()) is None


async def test_after_agent_skips_when_editor_off(staging_env) -> None:
    session = staging_env.session
    _stage_py(staging_env, name='skip.py', old='a=1\n', new='a = 1\n')
    session.worker_apply_mode = False
    mw = FlushUntransferredStagingMiddleware()
    assert await mw.aafter_agent({}, MagicMock()) is None
    assert session.pending_edit_stagings['skip.py'].workspace_applied is False
    assert (staging_env.workspace / 'skip.py').read_text(encoding='utf-8') == 'a = 1\n'


async def test_after_agent_skips_when_abort_event_set(staging_env) -> None:
    session = staging_env.session
    session.worker_apply_mode = True
    session.abort_event.set()
    _stage_py(staging_env, name='abort.py', old='a=1\n', new='a = 1\n')
    mw = FlushUntransferredStagingMiddleware()
    assert await mw.aafter_agent({}, MagicMock()) is None
    assert session.pending_edit_stagings['abort.py'].workspace_applied is False


async def test_after_agent_skips_when_transfer_hitl_already_pending(staging_env) -> None:
    session = staging_env.session
    session.worker_apply_mode = True
    _stage_py(staging_env, name='busy.py', old='a=1\n', new='a = 1\n')
    session.pending_staged_transfer_hitl = PendingStagedTransferHitl(
        request_id='already',
        relative_paths=['busy.py'],
    )
    mw = FlushUntransferredStagingMiddleware()
    assert await mw.aafter_agent({}, MagicMock()) is None
    assert session.pending_edit_stagings['busy.py'].workspace_applied is False


async def test_after_agent_jumps_to_model_to_review_untransferred_drafts(staging_env) -> None:
    session = staging_env.session
    session.auto_apply_mode = False
    session.worker_apply_mode = True
    session.hitl_sse_queue = asyncio.Queue()
    _stage_py(staging_env, name='review.py', old='n=0\n', new='n = 0\n')
    mw = FlushUntransferredStagingMiddleware()
    result = await mw.aafter_agent({}, MagicMock())

    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('untransferred_draft_review_streak') == 1
    content = result['messages'][0].content
    assert '`review.py`' in content
    assert 'Review' in content or 'review' in content
    assert 'transfer_staged_file_to_workspace' in content
    assert 'discard_staged_edits' in content
    assert session.pending_edit_stagings['review.py'].workspace_applied is False
    assert (staging_env.workspace / 'review.py').read_text(encoding='utf-8') == 'n = 0\n'
    assert session.pending_staged_transfer_hitl is None
    queued = session.hitl_sse_queue.get_nowait()
    assert queued[0] == 'agent_nudge'
    assert queued[1].get('reason') == 'staging'


async def test_after_agent_review_nudge_mentions_hitl_when_auto_apply_off() -> None:
    text = untransferred_draft_review_nudge_text(['a.py'], auto_apply=False)
    assert '`a.py`' in text
    assert 'diff card' in text
    assert 'diff card' not in untransferred_draft_review_nudge_text(['a.py'], auto_apply=True)


async def test_after_agent_review_jumps_stop_at_cap(staging_env, monkeypatch) -> None:
    monkeypatch.setattr(
        'clara_coder_backend.middleware.flush_untransferred_staging_middleware.MAX_UNTRANSFERRED_DRAFT_REVIEW_NUDGES',
        3,
    )
    session = staging_env.session
    session.auto_apply_mode = True
    session.worker_apply_mode = True
    _stage_py(staging_env, name='again.py', old='n=0\n', new='n = 0\n')
    mw = FlushUntransferredStagingMiddleware()
    under = await mw.aafter_agent({'untransferred_draft_review_streak': 2}, MagicMock())
    assert under is not None
    assert under.get('jump_to') == 'model'
    assert under.get('untransferred_draft_review_streak') == 3
    capped = await mw.aafter_agent({'untransferred_draft_review_streak': 3}, MagicMock())
    assert capped is None
    assert session.pending_edit_stagings['again.py'].workspace_applied is False
    assert (staging_env.workspace / 'again.py').read_text(encoding='utf-8') == 'n = 0\n'
    assert session.pending_staged_transfer_hitl is None


async def test_create_agent_after_agent_stops_after_cap(staging_env, monkeypatch) -> None:
    """Leftover drafts stay unapplied; after_agent stops jumping once the cap is hit."""
    monkeypatch.setattr(
        'clara_coder_backend.middleware.flush_untransferred_staging_middleware.MAX_UNTRANSFERRED_DRAFT_REVIEW_NUDGES',
        2,
    )
    session = staging_env.session
    session.auto_apply_mode = True
    session.worker_apply_mode = True
    _stage_py(staging_env, name='land.py', old='n=0\n', new='n = 0\n')
    graph = create_agent(
        FakeListChatModel(responses=['I staged the file and I am done.', 'Still looking.']),
        [],
        middleware=[FlushUntransferredStagingMiddleware()],
    )
    await graph.ainvoke(
        {'messages': [HumanMessage(content='edit land.py')]},
        {'recursion_limit': 8},
    )
    assert session.pending_edit_stagings['land.py'].workspace_applied is False
    assert (staging_env.workspace / 'land.py').read_text(encoding='utf-8') == 'n = 0\n'
    assert session.pending_staged_transfer_hitl is None


async def test_cleanup_warns_only_for_untransferred_paths(staging_env, caplog) -> None:
    session = staging_env.session
    session.auto_apply_mode = True
    session.worker_apply_mode = True
    _stage_py(staging_env, name='applied.py', old='a=1\n', new='a = 1\n')
    session.pending_edit_stagings['applied.py'].workspace_applied = True
    _stage_py(staging_env, name='orphan.py', old='b=1\n', new='b = 1\n')
    with caplog.at_level('WARNING', logger='clara.agent.langgraph'):
        _cleanup_nested_edit_staging(session, staging_env.session_id)
    assert 'orphan.py' in caplog.text
    assert 'applied.py' not in caplog.text
    assert session.pending_edit_stagings == {}
