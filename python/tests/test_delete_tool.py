"""Safe delete tool helpers."""

from nemo_backend.delete_tool import _reject_reason


def test_rejects_workspace_root() -> None:
    assert _reject_reason('.') is not None
    assert _reject_reason('') is not None


def test_rejects_git() -> None:
    assert _reject_reason('.git') is not None
    assert _reject_reason('.git/config') is not None
