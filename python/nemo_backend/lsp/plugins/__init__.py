"""Built-in LSP server plugin implementations."""

from __future__ import annotations

from nemo_backend.lsp.plugins.gdscript_plugin import GdscriptLspPlugin
from nemo_backend.lsp.plugins.java_plugin import JavaLspPlugin
from nemo_backend.lsp.plugins.python_plugin import PythonLspPlugin
from nemo_backend.lsp.plugins.typescript_plugin import TypescriptLspPlugin
from nemo_backend.lsp.server_plugin import LspServerPlugin

__all__ = [
    'BUILTIN_LSP_PLUGINS',
    'GdscriptLspPlugin',
    'JavaLspPlugin',
    'PythonLspPlugin',
    'TypescriptLspPlugin',
]

BUILTIN_LSP_PLUGINS: tuple[type[LspServerPlugin], ...] = (
    PythonLspPlugin,
    TypescriptLspPlugin,
    GdscriptLspPlugin,
    JavaLspPlugin,
)

