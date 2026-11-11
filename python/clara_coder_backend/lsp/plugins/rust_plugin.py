"""Rust LSP plugin: rust-analyzer from Dependencies, or ``CLARA_RUST_LSP_COMMAND``.

rust-analyzer loads a project by running cargo on it, and cargo runs what the project tells it to:
a ``.cargo/config.toml`` can name the ``rustc`` to execute, before any build script or proc macro
comes into it. Turning those off therefore doesn't make an untrusted folder safe to open, so the
server only starts in a workspace the user trusts.
"""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from clara_coder_backend.config import env_clara
from clara_coder_backend.domain import RuntimeRustLspConfig
from clara_coder_backend.lsp.rust_project_root import find_rust_project
from clara_coder_backend.lsp.server_plugin import (
    LspServerNotInstalledError,
    LspServerPlugin,
    LspStartParams,
)
from clara_coder_backend.session.state import runtime_config
from clara_coder_backend.workspace.trust import workspace_is_trusted

if TYPE_CHECKING:
    from clara_coder_backend.domain import SessionState

logger = logging.getLogger('clara_coder_backend.lsp.plugins.rust')

#: The trust list arrives with the app's first settings sync, which waits on network refreshes.
_RUNTIME_CONFIG_WAIT_S = 60.0
_SERVER_STATUS_METHOD = 'experimental/serverStatus'
_HEALTH_MESSAGE_MAX_CHARS = 300

UNTRUSTED_MESSAGE = (
    'Rust needs a trusted workspace. rust-analyzer runs cargo, which can run code from the folder. '
    'Trust this workspace in Settings → Workspaces to turn it on.'
)


@dataclass
class RustPluginState:
    last_seed: str = ''
    #: ``linkedProjects``, in the order their first file was opened.
    linked_projects: list[Path] = field(default_factory=list)
    scope: str = 'workspace'
    pending_options: dict[str, Any] | None = None


def find_cargo() -> Path | None:
    on_path = shutil.which('cargo')
    if on_path:
        return Path(on_path)
    # Apps launched from Finder don't inherit the shell PATH that rustup edits.
    default = Path.home() / '.cargo' / 'bin' / ('cargo.exe' if sys.platform.startswith('win') else 'cargo')
    return default if default.is_file() else None


def build_rust_init_options(
    settings: RuntimeRustLspConfig,
    linked_projects: list[Path],
    *,
    scope: str,
) -> dict[str, Any]:
    """The ``rust-analyzer`` settings section: sent as ``initializationOptions`` and on every later pull."""

    return {
        'linkedProjects': [str(path) for path in linked_projects],
        'cargo': {
            'buildScripts': {'enable': settings.run_build_scripts},
            'features': 'all' if settings.all_features else [],
            # ``True`` is ``target/rust-analyzer``: its own build lock, at the cost of a second set of artifacts.
            'targetDir': True if settings.separate_target_dir else None,
        },
        'procMacro': {'enable': settings.expand_proc_macros},
        # cargo reads the files on disk, so it can say nothing about a staging overlay's unsaved text.
        'checkOnSave': settings.check_on_save and scope == 'workspace',
        'check': {'command': settings.check_command},
        'inlayHints': {
            'typeHints': {'enable': settings.inlay_type_hints},
            'parameterHints': {'enable': settings.inlay_parameter_hints},
            'chainingHints': {'enable': settings.inlay_chaining_hints},
        },
        # The shared capabilities don't offer watcher registration, so rust-analyzer watches by itself.
        'files': {'watcher': 'server'},
    }


class RustLspPlugin(LspServerPlugin):
    server_id = 'rust'

    #: The first publish waits for cargo metadata and the index of the whole crate graph.
    slow_diagnostics = True

    #: Publishes when a file's diagnostics change, so a clean → clean edit brings nothing.
    silent_when_diagnostics_unchanged = True

    #: rust-analyzer answers with everything in scope and leaves filtering to the client.
    completion_item_limit = 5000

    save_check_progress_prefix = 'rust-analyzer/flycheck'

    uses_workspace_trust = True
    configuration_section = 'rust-analyzer'

    @property
    def checks_on_save(self) -> bool:  # type: ignore[override]
        """Without this an agent's edits would only ever get the diagnostics rust-analyzer finds itself."""

        return runtime_config.lsp.rust.check_on_save

    def create_state(self) -> Any:
        return RustPluginState()

    def wait_until_ready_to_start(self) -> None:
        # Before the first settings sync every workspace reads as untrusted, which would refuse a
        # trusted one with a message telling the user to trust it.
        from clara_coder_backend.session.state import runtime_config_received

        if not runtime_config_received.wait(timeout=_RUNTIME_CONFIG_WAIT_S):
            raise LspServerNotInstalledError(
                "Clara's settings haven't reached the Rust language server yet, so it hasn't started. "
                'Try again shortly.'
            )

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        # With no file there is no project to link, and an empty list makes rust-analyzer go looking.
        st = state if isinstance(state, RustPluginState) else RustPluginState()
        return not (st.last_seed or '').strip()

    def client_capability_overrides(self) -> dict[str, Any]:
        return {
            'textDocument': {
                'completion': {
                    'completionItem': {
                        'resolveSupport': {'properties': ['documentation', 'detail']},
                        'tagSupport': {'valueSet': [1]},
                    },
                },
            },
            'window': {'workDoneProgress': True},
            'experimental': {'serverStatusNotification': True},
        }

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
        st = state if isinstance(state, RustPluginState) else RustPluginState()
        st.last_seed = relative_posix_path
        project = find_rust_project(workspace_root, relative_posix_path)
        if project is None or project in st.linked_projects:
            return False
        st.linked_projects.append(project)
        if client_running:
            # rust-analyzer reloads its projects when the list changes; no restart needed.
            logger.info('rust LSP linking project %s', project)
            st.pending_options = build_rust_init_options(runtime_config.lsp.rust, st.linked_projects, scope=st.scope)
        return False

    def take_pending_initialization_options(self, state: Any) -> dict[str, Any] | None:
        st = state if isinstance(state, RustPluginState) else RustPluginState()
        pending, st.pending_options = st.pending_options, None
        return pending

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        session_id: str = '',
        scope: str = 'workspace',
    ) -> LspStartParams:
        st = state if isinstance(state, RustPluginState) else RustPluginState()
        root = Path(workspace_root).resolve()
        if not workspace_is_trusted(root):
            raise LspServerNotInstalledError(UNTRUSTED_MESSAGE)

        raw = env_clara('CLARA_RUST_LSP_COMMAND', '').strip()
        if raw:
            command = shlex.split(raw, posix=os.name != 'nt')
            logger.info('rust LSP command override workspace=%s command=%s', root, command)
        else:
            from clara_coder_backend.runtime.deps.providers import rust_analyzer

            binary = rust_analyzer.installed_binary()
            if binary is None:
                raise LspServerNotInstalledError(
                    'Rust LSP (rust-analyzer) is not installed. Open Dependencies and download '
                    '“Rust LSP (rust-analyzer)”, then retry.'
                )
            command = [str(binary)]

        cargo = find_cargo()
        if cargo is None:
            raise LspServerNotInstalledError(
                'Rust is not installed. rust-analyzer needs cargo to load a project. '
                'Install Rust from https://rustup.rs, then retry.'
            )
        env: dict[str, str] | None = None
        if shutil.which('cargo') is None:
            env = {'PATH': os.pathsep.join([str(cargo.parent), os.environ.get('PATH', '')])}

        st.scope = scope or 'workspace'
        st.pending_options = None
        # A project whose manifest was deleted since would only make the server report it missing.
        st.linked_projects = [project for project in st.linked_projects if project.is_file()]
        if not st.linked_projects and (st.last_seed or '').strip():
            project = find_rust_project(root, st.last_seed)
            if project is not None:
                st.linked_projects.append(project)
        logger.info(
            'rust LSP starting command=%s workspace=%s projects=%s',
            command,
            root,
            [str(project) for project in st.linked_projects],
        )
        return LspStartParams(
            lsp_cwd=root,
            command=command,
            init_options=build_rust_init_options(runtime_config.lsp.rust, st.linked_projects, scope=st.scope),
            env=env,
        )

    def server_health_from_notification(self, method: str, params: dict[str, Any]) -> str | None:
        if method != _SERVER_STATUS_METHOD:
            return None
        if params.get('health') not in ('warning', 'error'):
            return ''
        message = ' '.join(str(params.get('message') or '').split())
        if len(message) > _HEALTH_MESSAGE_MAX_CHARS:
            message = message[: _HEALTH_MESSAGE_MAX_CHARS - 1] + '…'
        return message

    def after_shutdown(self, session: SessionState, state: Any) -> None:
        if isinstance(state, RustPluginState):
            state.pending_options = None
