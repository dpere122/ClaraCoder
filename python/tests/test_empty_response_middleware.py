from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from clara_coder_backend.domain import EditStagingEntry, PendingStagedTransferHitl
from clara_coder_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from clara_coder_backend.state import current_session_id, get_session


pytestmark = pytest.mark.asyncio(loop_scope='function')


async def test_empty_response_nudge_resets_after_tool_call() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(
                    content='',
                    tool_calls=[{'name': 'list_workspace_directory', 'args': {'relative_path': '.'}, 'id': 'tool-1'}],
                )
            ],
            'empty_response_nudge_streak': 2,
        },
        MagicMock(),
    )

    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }


async def test_empty_response_nudge_keeps_generic_tool_result_prompt_for_other_tools() -> None:
    middleware = EmptyResponseNudgeMiddleware()

    result = await middleware.aafter_model(
        {
            'messages': [
                ToolMessage(
                    content='Directory: .\nfile.py',
                    tool_call_id='tool-1',
                    name='list_workspace_directory',
                ),
                AIMessage(content=''),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )

    assert result is not None
    assert 'You already have tool results' in result['messages'][0].content


_PSEUDO_XML = (
    '<tool_call><function=list_workspace_directory>'
    '<parameter name="relative_path">server</parameter></function></tool_call>'
)


async def test_pseudo_tool_markup_in_text_nudges_without_api_tool_calls() -> None:
    """Qwen / template stacks often emit <tool_call> in content or reasoning, not in tool_calls."""
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [
                AIMessage(content=_PSEUDO_XML),
            ],
            'empty_response_nudge_streak': 0,
        },
        MagicMock(),
    )
    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('pseudo_tool_markup_nudge_streak') == 1
    assert 'tool-calling' in (result.get('messages') or [{}])[0].content
    assert result.get('empty_response_nudge_streak') == 0


@patch('clara_coder_backend.empty_response_middleware.MAX_AGENT_PSEUDO_TOOL_NUDGES', 2)
async def test_pseudo_tool_markup_nudge_stops_at_cap() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content=_PSEUDO_XML)],
            'pseudo_tool_markup_nudge_streak': 2,
        },
        MagicMock(),
    )
    assert result is None


async def test_prose_only_resets_pseudo_streak() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    result = await middleware.aafter_model(
        {
            'messages': [AIMessage(content='Here is a normal answer for the user.')],
            'pseudo_tool_markup_nudge_streak': 3,
        },
        MagicMock(),
    )
    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }


async def test_prose_with_pending_staging_nudges_transfer() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    session_id = 'empty-mw-staging-prose'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_edit_stagings['src/app.html'] = EditStagingEntry(
        temp_path='/tmp/staged.html',
        old_text='',
        merged_text='<p>hi</p>\n',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
        workspace_applied=False,
    )
    try:
        result = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Done staging.')],
                'staging_continuation_nudge_streak': 0,
            },
            MagicMock(),
        )
    finally:
        session.pending_edit_stagings.clear()
        current_session_id.reset(token)

    assert result is not None
    assert result.get('jump_to') == 'model'
    assert result.get('staging_continuation_nudge_streak') == 1
    assert 'transfer_staged_file_to_workspace' in result['messages'][0].content
    assert 'Auto-apply is off' in result['messages'][0].content


async def test_empty_after_stage_tool_nudges_transfer_not_do_not_call_tools() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    session_id = 'empty-mw-staging-empty'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_edit_stagings['src/app.html'] = EditStagingEntry(
        temp_path='/tmp/staged.html',
        old_text='',
        merged_text='<p>hi</p>\n',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
        workspace_applied=False,
    )
    try:
        result = await middleware.aafter_model(
            {
                'messages': [
                    ToolMessage(
                        content='Staged `src/app.html` for review. Next: transfer_staged_file_to_workspace',
                        tool_call_id='tool-1',
                        name='stage_create_file',
                    ),
                    AIMessage(content=''),
                ],
                'staging_continuation_nudge_streak': 0,
            },
            MagicMock(),
        )
    finally:
        session.pending_edit_stagings.clear()
        current_session_id.reset(token)

    assert result is not None
    assert result.get('jump_to') == 'model'
    assert 'transfer_staged_file_to_workspace' in result['messages'][0].content
    assert 'do NOT call tools again' not in result['messages'][0].content.lower()


async def test_staging_continuation_skipped_when_transfer_hitl_pending() -> None:
    middleware = EmptyResponseNudgeMiddleware()
    session_id = 'empty-mw-staging-hitl'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_staged_transfer_hitl = PendingStagedTransferHitl(
        request_id='hitl-test',
        relative_paths=['src/app.html'],
    )
    session.pending_edit_stagings['src/app.html'] = EditStagingEntry(
        temp_path='/tmp/staged.html',
        old_text='',
        merged_text='<p>hi</p>\n',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
        workspace_applied=False,
    )
    try:
        result = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Done staging.')],
                'staging_continuation_nudge_streak': 0,
            },
            MagicMock(),
        )
    finally:
        session.pending_edit_stagings.clear()
        session.pending_staged_transfer_hitl = None
        current_session_id.reset(token)

    assert result == {
        'empty_response_nudge_streak': 0,
        'pseudo_tool_markup_nudge_streak': 0,
        'staging_continuation_nudge_streak': 0,
        'action_commitment_nudge_streak': 0,
    }
