"""Java LSP plugin (Eclipse JDT Language Server + Maven/Gradle project root)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nemo_backend.lsp.java_project_root import resolve_java_project_root
from nemo_backend.lsp.java_server import build_java_initialization_options, build_java_lsp_command
from nemo_backend.lsp.server_plugin import LspServerPlugin, LspStartParams

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState

logger = logging.getLogger('nemo.lsp.plugins.java')


@dataclass
class JavaPluginState:
    last_seed: str = ''
    project_root: Path | None = None


class JavaLspPlugin(LspServerPlugin):
    server_id = 'java'

    def create_state(self) -> Any:
        return JavaPluginState()

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
    ) -> LspStartParams:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        cached = (session.java_lsp_resolved_root or '').strip()
        if cached:
            root = Path(cached).resolve()
        elif st.last_seed:
            root = resolve_java_project_root(
                workspace_root,
                seed_relative_path=st.last_seed,
            )
        else:
            root = resolve_java_project_root(
                workspace_root,
                seed_relative_path=None,
                allow_workspace_walk=False,
            )
        st.project_root = root
        return LspStartParams(
            lsp_cwd=root,
            command=build_java_lsp_command(root),
            init_options=build_java_initialization_options(),
        )

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        return not bool((st.last_seed or '').strip())

    def on_before_sync_document(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        relative_posix_path: str,
        state: Any,
        client_running: bool,
    ) -> bool:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        st.last_seed = relative_posix_path
        desired = resolve_java_project_root(
            workspace_root,
            seed_relative_path=st.last_seed,
        )
        if not client_running:
            st.project_root = desired
            return False
        cur = st.project_root
        if cur is None:
            st.project_root = desired
            return False
        try:
            mismatch = desired.resolve() != cur.resolve()
        except OSError:
            mismatch = True
        if mismatch:
            logger.info(
                'java LSP project root changed %s -> %s; restarting server',
                cur,
                desired,
            )
            st.project_root = desired
            return True
        return False

    def after_shutdown(self, session: SessionState, state: Any) -> None:
        session.java_lsp_resolved_root = ''
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        st.project_root = None

    def on_after_client_started(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        lsp_cwd: Path,
    ) -> None:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        st.project_root = lsp_cwd
        session.java_lsp_resolved_root = str(lsp_cwd)
