"""Python LSP plugin (jedi-language-server)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from nemo_backend.lsp.jedi_init_options import build_jedi_initialization_options
from nemo_backend.lsp.python_server import build_python_lsp_command
from nemo_backend.lsp.server_plugin import LspServerPlugin, LspStartParams

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState


class PythonLspPlugin(LspServerPlugin):
    server_id = 'python'

    def create_state(self) -> Any:
        return None

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
    ) -> LspStartParams:
        return LspStartParams(
            lsp_cwd=workspace_root,
            command=build_python_lsp_command(workspace_root),
            init_options=build_jedi_initialization_options(session, workspace_root),
        )

