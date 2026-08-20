"""Python LSP plugin (basedpyright)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from clara_coder_backend.lsp.python_init_options import build_python_initialization_options
from clara_coder_backend.lsp.python_server import build_python_lsp_command
from clara_coder_backend.lsp.server_plugin import LspServerPlugin, LspStartParams

if TYPE_CHECKING:
    from clara_coder_backend.domain import SessionState


@dataclass
class PythonPluginState:
    """Last workspace-relative path that went through sync on this manager (always ``.py``)."""

    last_seed: str = ''


class PythonLspPlugin(LspServerPlugin):
    server_id = 'python'

    def create_state(self) -> Any:
        return PythonPluginState()

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        session_id: str = '',
        scope: str = 'workspace',
    ) -> LspStartParams:
        return LspStartParams(
            lsp_cwd=workspace_root,
            command=build_python_lsp_command(workspace_root),
            init_options=build_python_initialization_options(session, workspace_root),
        )

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        st = state if isinstance(state, PythonPluginState) else PythonPluginState()
        return not (st.last_seed or '').strip()

    def on_before_sync_document(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        relative_posix_path: str,
        state: Any,
        client_running: bool,
    ) -> bool:
        st = state if isinstance(state, PythonPluginState) else PythonPluginState()
        st.last_seed = relative_posix_path
        return False

