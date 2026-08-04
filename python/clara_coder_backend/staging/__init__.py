"""Editor staging, workspace mirror, and edit/diff helpers.

Modules
-------
``edit_staging`` — temp staging dir, workspace mirror, code-review extensions
``staging_snapshot_session`` — seed/cleanup workspace mirror per session
``staging_test_overlay`` — pytest overlay for staged peers
``materializations`` — rollback workspace files materialized during test runs
``partial_workspace_edit`` — merge strategies (line range, snippet, fuzzy)
``diff_payload`` — side-by-side diff rows via diff-match-patch
"""

from clara_coder_backend.staging import staging_test_overlay as _staging_test_overlay  # noqa: F401
