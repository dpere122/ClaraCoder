"""Universal (preset-agnostic) disk-vs-staged-draft guidance in ``edit_semantics_block``."""

from __future__ import annotations

from clara_coder_backend.prompt_blocks import edit_semantics_block


def test_staging_edit_semantics_tells_model_to_refresh_from_staged_draft() -> None:
    block = edit_semantics_block(direct=False)
    assert 'current staged draft' in block
    assert 'read_staged_edit' in block
    assert 'not `read_workspace_file`' in block


def test_staging_edit_semantics_prefers_line_range_when_line_numbers_known() -> None:
    block = edit_semantics_block(direct=False)
    assert 'Prefer `stage_line_range_edit` when you already know line numbers' in block
    assert 'include_line_numbers=false' in block


def test_direct_edit_semantics_has_no_staging_draft_language() -> None:
    # Auto-apply/direct mode has no staging plane at all, so this guidance should not appear there.
    block = edit_semantics_block(direct=True)
    assert 'staged draft' not in block
