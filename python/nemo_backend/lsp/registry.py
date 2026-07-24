"""Registry of integrated LSP server plugins."""

from __future__ import annotations

from nemo_backend.lsp.plugins import BUILTIN_LSP_PLUGINS
from nemo_backend.lsp.server_plugin import LspServerPlugin

__all__ = [
    'LspServerKind',
    'display_label_for_server',
    'get_lsp_server_plugin',
    'iter_registered_lsp_server_ids',
    'lsp_server_id_is_registered',
]

# Backward-compatible alias: any registered server id (not only python|typescript).
LspServerKind = str

_PLUGIN_BY_ID: dict[str, LspServerPlugin] = {}


def _ensure_plugins_loaded() -> None:
    if _PLUGIN_BY_ID:
        return
    for cls in BUILTIN_LSP_PLUGINS:
        inst = cls()
        sid = inst.server_id
        if sid in _PLUGIN_BY_ID:
            raise RuntimeError(f'Duplicate LSP server_id: {sid!r}')
        _PLUGIN_BY_ID[sid] = inst


def get_lsp_server_plugin(server_id: str) -> LspServerPlugin:
    _ensure_plugins_loaded()
    inst = _PLUGIN_BY_ID.get((server_id or '').strip())
    if inst is None:
        raise ValueError(f'Unknown LSP server id: {server_id!r}')
    return inst


def lsp_server_id_is_registered(server_id: str) -> bool:
    _ensure_plugins_loaded()
    return (server_id or '').strip() in _PLUGIN_BY_ID


def iter_registered_lsp_server_ids() -> tuple[str, ...]:
    _ensure_plugins_loaded()
    return tuple(_PLUGIN_BY_ID.keys())


def display_label_for_server(server_id: str | None) -> str:
    if not server_id:
        return 'LSP'
    s = (server_id or '').strip().lower()
    if s == 'python':
        return 'Python'
    if s == 'typescript':
        return 'TypeScript'
    if s == 'gdscript':
        return 'GDScript'
    if s == 'java':
        return 'Java'
    return server_id.strip().title() or 'LSP'

