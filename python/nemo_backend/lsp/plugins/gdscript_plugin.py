"""GDScript LSP plugin (stdio: ``NEMO_GDSCRIPT_LSP_COMMAND`` or default TCP bridge to Godot)."""

from __future__ import annotations

import logging
import os
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nemo_backend.lsp.server_plugin import LspServerPlugin, LspStartParams

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState

logger = logging.getLogger('nemo_backend.lsp.plugins.gdscript')

# Run by path, not ``python -m nemo_backend...``: LSP ``cwd`` is the game workspace, so the
# child would not resolve the ``nemo_backend`` package on ``sys.path``.
_GODOT_LSP_STDIO_BRIDGE_SCRIPT = Path(__file__).resolve().parent.parent / 'godot_lsp_stdio_bridge.py'


@dataclass
class GdscriptPluginState:
    last_seed: str = ''


class GdscriptLspPlugin(LspServerPlugin):
    server_id = 'gdscript'

    def create_state(self) -> Any:
        return GdscriptPluginState()

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        if os.environ.get('NEMO_GDSCRIPT_LSP_COMMAND', '').strip():
            return False
        st = state if isinstance(state, GdscriptPluginState) else GdscriptPluginState()
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
        st = state if isinstance(state, GdscriptPluginState) else GdscriptPluginState()
        st.last_seed = relative_posix_path
        return False

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
    ) -> LspStartParams:
        raw = os.environ.get('NEMO_GDSCRIPT_LSP_COMMAND', '').strip()
        if raw:
            cmd = shlex.split(raw, posix=os.name != 'nt')
            logger.info('gdscript LSP command override workspace=%s command=%s', workspace_root, cmd)
        else:
            cmd = [str(Path(sys.executable).resolve()), str(_GODOT_LSP_STDIO_BRIDGE_SCRIPT)]
            logger.info(
                'gdscript LSP default stdio→TCP bridge workspace=%s (Godot editor LSP on '
                '%s:%s; override with NEMO_GDSCRIPT_LSP_COMMAND or NEMO_GODOT_LSP_HOST / NEMO_GODOT_LSP_PORT)',
                workspace_root,
                (os.environ.get('NEMO_GODOT_LSP_HOST') or '127.0.0.1').strip(),
                (os.environ.get('NEMO_GODOT_LSP_PORT') or '6005').strip(),
            )
        return LspStartParams(lsp_cwd=workspace_root, command=cmd, init_options={})
