"""Tests for security/python-sidecar-auth — subtask 3 (workspace-path-containment).

Verifies ``normalize_relative_path`` resolves the workspace root once (realpath)
before the containment check, so ``..`` escapes and symlinked entries pointing
outside the workspace are rejected.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from clara_coder_backend.workspace.paths import normalize_relative_path


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / 'ws'
    (root / 'real').mkdir(parents=True)
    return root


def _link_directory(link: Path, target: Path) -> None:
    """Make ``link`` a directory link to ``target``.

    Windows only allows symlinks with admin rights or Developer Mode, so fall back to a junction there:
    it needs no privilege and escapes the workspace the same way.
    """
    try:
        os.symlink(target, link, target_is_directory=True)
        return
    except OSError:
        if sys.platform != 'win32':
            raise
    made = subprocess.run(
        ['cmd', '/c', 'mklink', '/J', str(link), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip(f'cannot create a symlink or junction here: {made.stderr.strip() or made.stdout.strip()}')


@pytest.fixture()
def workspace_with_escape_link(workspace: Path, tmp_path: Path) -> Path:
    """Workspace holding ``escape``, a directory link that points outside it."""
    outside = tmp_path / 'outside'
    outside.mkdir()
    _link_directory(workspace / 'escape', outside)
    return workspace


def test_dotdot_escape_rejected(workspace: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace, '../../../../etc/passwd')


def test_symlinked_entry_pointing_outside_rejected(workspace_with_escape_link: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace_with_escape_link, 'escape/etc/passwd')


def test_legitimate_relative_path_allowed(workspace: Path) -> None:
    got = normalize_relative_path(workspace, 'real/./file.txt')
    assert str(got).startswith(str(workspace.resolve()))


def test_absolute_path_outside_root_rejected(workspace: Path) -> None:
    with pytest.raises(ValueError, match='outside the active workspace'):
        normalize_relative_path(workspace, '/etc/passwd')
