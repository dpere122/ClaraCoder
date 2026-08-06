"""Universal (preset-agnostic) disk-vs-staged-draft guidance in ``edit_semantics_block``."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from clara_coder_backend.llm.messages import build_system_prompt
from clara_coder_backend.llm.prompt_blocks import edit_semantics_block
from clara_coder_backend.domain import RuntimeConnection, SessionState


def _conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='c',
        name='test',
        provider='openai',
        base_url='http://127.0.0.1:1234/v1',
        model='test-model',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
    )


def test_staging_edit_semantics_tells_model_to_refresh_from_staged_draft() -> None:
    block = edit_semantics_block(direct=False)
    assert 'current staged draft' in block
    assert 'read_staged_edit' in block
    assert 'not `read_workspace_file`' in block


def test_staging_edit_semantics_prefers_line_range_when_line_numbers_known() -> None:
    block = edit_semantics_block(direct=False)
    assert 'Prefer `stage_line_range_edit` when you already know line numbers' in block
    assert 'include_line_numbers=false' in block


def test_staging_edit_semantics_owns_landing_and_legacy_mutator_rules() -> None:
    block = edit_semantics_block(direct=False)
    assert 'Never ask the user to apply or approve landing' in block
    assert 'legacy direct-to-disk workspace mutators' in block
    assert 'land_in_workspace=true' in block
    assert 'transfer_staged_file_to_workspace' in block
    assert 'discard_staged_edits' in block


def test_direct_edit_semantics_has_no_staging_draft_language() -> None:
    # Auto-apply/direct mode has no staging plane at all, so this guidance should not appear there.
    block = edit_semantics_block(direct=True)
    assert 'staged draft' not in block


@patch('clara_coder_backend.llm.messages.get_active_connection')
def test_build_system_prompt_injects_edit_semantics_once(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    session = SessionState(workspace_path='/tmp/ws', workspace_context='.', auto_apply_mode=False)
    prompt = build_system_prompt(session, apply_mode=True)
    assert prompt.count('**Edit semantics (staging):**') == 1
    assert prompt.count('Never put tool arguments') == 1
    assert 'Discovery: reach for `search_workspace` first' not in prompt
    assert 'Never ask the user to apply or approve landing' in prompt
