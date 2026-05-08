"""LSP file policy routing."""

from __future__ import annotations

from nemo_backend.lsp.file_policy import lsp_server_for_path


def test_lsp_server_for_path_gdscript() -> None:
    assert lsp_server_for_path('game/Main.gd') == 'gdscript'
    assert lsp_server_for_path('scripts/foo.gd') == 'gdscript'
