"""Java LSP plugin (Eclipse JDT Language Server + Maven/Gradle/Eclipse/loose project layouts)."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from clara_coder_backend.lsp.java_loose_folder import (
    java_loose_settings,
    load_loose_java_config,
    scan_loose_source_roots,
    source_root_for_file,
)
from clara_coder_backend.lsp.java_project_root import (
    JAVA_LAYOUT_LOOSE,
    JavaProjectLayout,
    detect_java_project_layout,
    java_layout_for_dir,
)
from clara_coder_backend.lsp.java_server import build_java_initialization_options, build_java_lsp_command
from clara_coder_backend.lsp.server_plugin import LspServerPlugin, LspStartParams

if TYPE_CHECKING:
    from clara_coder_backend.domain import SessionState

logger = logging.getLogger('clara.lsp.plugins.java')


def _path_under_workspace(path: Path, workspace_root: Path) -> Path | None:
    """Return ``path`` resolved when it is inside ``workspace_root``; else None."""

    try:
        resolved = path.resolve()
        resolved.relative_to(workspace_root.resolve())
        return resolved
    except (OSError, ValueError):
        return None


def _config_stamp(layout: JavaProjectLayout | None) -> tuple[int, int] | None:
    path = layout.config_path if layout is not None else None
    if path is None:
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


@dataclass
class JavaPluginState:
    last_seed: str = ''
    project_root: Path | None = None
    layout: JavaProjectLayout | None = None
    persist_session_root: bool = False
    #: Loose folders: inferred source roots and the project root they were scanned under.
    source_roots: tuple[str, ...] = ()
    scanned_root: Path | None = None
    #: Absolute ``.java`` path → absolute source root from its last synced text.
    file_roots: dict[Path, Path] = field(default_factory=dict)
    config_stamp: tuple[int, int] | None = None
    #: ``settings.java`` fragment the running server currently has.
    applied_java_settings: dict[str, Any] = field(default_factory=dict)
    pending_options: dict[str, Any] | None = None


class JavaLspPlugin(LspServerPlugin):
    server_id = 'java'
    slow_diagnostics = True

    def create_state(self) -> Any:
        return JavaPluginState()

    @staticmethod
    def _start_layout(session: SessionState, ws: Path, st: JavaPluginState) -> JavaProjectLayout:
        layout: JavaProjectLayout | None = None
        if (st.last_seed or '').strip():
            layout = detect_java_project_layout(ws, seed_relative_path=st.last_seed)
        if layout is None and st.layout is not None and _path_under_workspace(st.layout.root, ws) is not None:
            layout = st.layout
        if layout is None:
            cached = (session.lsp.java_lsp_resolved_root or '').strip()
            cached_root = _path_under_workspace(Path(cached), ws) if cached else None
            if cached_root is not None:
                layout = java_layout_for_dir(cached_root)
        if layout is None:
            layout = detect_java_project_layout(
                ws,
                seed_relative_path=None,
                allow_workspace_walk=False,
            )
        return layout

    @staticmethod
    def _loose_java_settings(st: JavaPluginState, layout: JavaProjectLayout) -> dict[str, Any]:
        """Refresh inferred source roots / config for a loose folder; return its ``settings.java`` fragment."""

        if not layout.is_loose:
            st.source_roots = ()
            st.scanned_root = None
            st.config_stamp = None
            return {}
        config = load_loose_java_config(layout.config_path)
        st.config_stamp = _config_stamp(layout)
        if config.source_paths:
            st.source_roots = tuple(config.source_paths)
            st.scanned_root = None
        elif st.scanned_root != layout.root:
            known: dict[str, str] = {}
            for file_path, source_root in st.file_roots.items():
                try:
                    rel_file = file_path.relative_to(layout.root).as_posix()
                    rel_root = source_root.relative_to(layout.root).as_posix()
                except ValueError:
                    continue
                known[rel_file] = rel_root if rel_root not in ('', '.') else '.'
            st.source_roots = tuple(scan_loose_source_roots(layout.root, known_file_roots=known))
            st.scanned_root = layout.root
        return java_loose_settings(layout, config, st.source_roots)

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        session_id: str = '',
        scope: str = 'workspace',
    ) -> LspStartParams:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        st.persist_session_root = (scope or 'workspace') == 'workspace'
        ws = Path(workspace_root).resolve()

        layout = self._start_layout(session, ws, st)
        st.layout = layout
        st.project_root = layout.root
        st.scanned_root = None  # always rescan on a fresh server
        java_settings = self._loose_java_settings(st, layout)
        st.applied_java_settings = java_settings
        st.pending_options = None
        if layout.is_loose:
            logger.info(
                'java LSP loose folder root=%s config=%s settings=%s',
                layout.root,
                layout.config_path if layout.config_path and layout.config_path.is_file() else None,
                java_settings,
            )
        return LspStartParams(
            lsp_cwd=layout.root,
            # The layout kind is part of the key so JDT LS gets a fresh ``-data`` workspace when
            # a folder gains or loses a build file; a stale invisible project would linger otherwise.
            command=build_java_lsp_command(
                layout.root,
                instance_key=f'{session_id}:{scope}:{layout.kind}',
            ),
            init_options=build_java_initialization_options(java_settings),
            startup_timeout_s=180.0,
        )

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        return not bool((st.last_seed or '').strip())

    @staticmethod
    def _remember_file_root(
        st: JavaPluginState,
        layout: JavaProjectLayout,
        workspace_root: Path,
        relative_posix_path: str,
        text: str | None,
    ) -> bool:
        """Record the synced file's source root; True when it is new or changed."""

        if not layout.is_loose or text is None:
            return False
        file_path = (Path(workspace_root) / relative_posix_path).resolve()
        rel_root = source_root_for_file(layout.root, file_path, text)
        if rel_root is None:
            return False
        source_root = (layout.root / rel_root).resolve()
        changed = st.file_roots.get(file_path) != source_root
        st.file_roots[file_path] = source_root
        return changed and rel_root not in st.source_roots

    def on_before_sync_document(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        relative_posix_path: str,
        state: Any,
        client_running: bool,
        text: str | None = None,
    ) -> bool:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        st.last_seed = relative_posix_path
        desired = detect_java_project_layout(
            workspace_root,
            seed_relative_path=st.last_seed,
        )
        root_changed = self._remember_file_root(st, desired, workspace_root, relative_posix_path, text)
        cur = st.layout
        if not client_running or cur is None:
            st.layout = desired
            st.project_root = desired.root
            return False
        try:
            mismatch = desired.root.resolve() != cur.root.resolve()
        except OSError:
            mismatch = True
        if mismatch or desired.kind != cur.kind:
            logger.info(
                'java LSP project changed %s (%s) -> %s (%s); restarting server',
                cur.root,
                cur.kind,
                desired.root,
                desired.kind,
            )
            st.layout = desired
            st.project_root = desired.root
            return True
        if desired.kind == JAVA_LAYOUT_LOOSE:
            config_changed = _config_stamp(desired) != st.config_stamp
            if root_changed or config_changed:
                st.scanned_root = None
                st.layout = desired
                java_settings = self._loose_java_settings(st, desired)
                if java_settings != st.applied_java_settings:
                    logger.info(
                        'java LSP loose settings changed root=%s settings=%s',
                        desired.root,
                        java_settings,
                    )
                    st.applied_java_settings = java_settings
                    st.pending_options = build_java_initialization_options(java_settings)
        return False

    def take_pending_initialization_options(self, state: Any) -> dict[str, Any] | None:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        pending, st.pending_options = st.pending_options, None
        return pending

    def after_shutdown(self, session: SessionState, state: Any) -> None:
        st = state if isinstance(state, JavaPluginState) else JavaPluginState()
        cached = (session.lsp.java_lsp_resolved_root or '').strip()
        if st.persist_session_root and cached and st.project_root is not None:
            try:
                if Path(cached).resolve() == st.project_root.resolve():
                    session.lsp.java_lsp_resolved_root = ''
            except OSError:
                session.lsp.java_lsp_resolved_root = ''
        st.project_root = None
        st.persist_session_root = False
        st.applied_java_settings = {}
        st.pending_options = None

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
        if st.persist_session_root:
            session.lsp.java_lsp_resolved_root = str(lsp_cwd)
