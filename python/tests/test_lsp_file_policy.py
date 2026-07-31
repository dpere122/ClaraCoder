"""LSP file policy routing."""

from __future__ import annotations

from clara_coder_backend.lsp.file_policy import (
    get_gdscript_lsp_policy,
    get_java_lsp_policy,
    get_python_lsp_policy,
    get_typescript_lsp_policy,
    lsp_server_for_path,
)


def test_lsp_server_for_path_gdscript() -> None:
    assert lsp_server_for_path('game/Main.gd') == 'gdscript'
    assert lsp_server_for_path('scripts/foo.gd') == 'gdscript'


def test_lsp_server_for_path_java() -> None:
    assert lsp_server_for_path('src/main/java/App.java') == 'java'
    assert lsp_server_for_path('App.java') == 'java'


def test_get_python_lsp_policy() -> None:
    assert get_python_lsp_policy('pkg/mod.py') is not None
    assert get_python_lsp_policy('src/app.ts') is None


def test_get_typescript_lsp_policy() -> None:
    assert get_typescript_lsp_policy('src/app.ts') is not None
    assert get_typescript_lsp_policy('src/app.tsx') is not None
    assert get_typescript_lsp_policy('src/app.js') is not None
    assert get_typescript_lsp_policy('pkg/mod.py') is None


def test_get_gdscript_lsp_policy() -> None:
    assert get_gdscript_lsp_policy('game/Main.gd') is not None
    assert get_gdscript_lsp_policy('src/app.ts') is None


def test_get_java_lsp_policy() -> None:
    assert get_java_lsp_policy('src/App.java') is not None
    assert get_java_lsp_policy('src/app.ts') is None
    assert get_java_lsp_policy('pkg/mod.py') is None
