"""Tests for security/python-sidecar-auth — subtask 3 (workspace-path-containment).

Verifies ``normalize_relative_path`` resolves the workspace root once (realpath)
before the containment check, so ``..`` escapes and symlinked entries pointing
outside the workspace are rejected.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from clara_coder_backend.workspace.paths import normalize_relative_path


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / 'ws'
    (root / 'real').mkdir(parents=True)
    # A symlink inside the workspace that points outside it.
    os.symlink('/', root / 'escape')
    return root


def test_dotdot_escape_rejected(workspace: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace, '../../../../etc/passwd')


def test_symlinked_entry_pointing_outside_rejected(workspace: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace, 'escape/etc/passwd')


def test_legitimate_relative_path_allowed(workspace: Path) -> None:
    got = normalize_relative_path(workspace, 'real/./file.txt')
    assert str(got).startswith(str(workspace.resolve()))


def test_absolute_path_outside_root_rejected(workspace: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace, '/etc/passwd')
