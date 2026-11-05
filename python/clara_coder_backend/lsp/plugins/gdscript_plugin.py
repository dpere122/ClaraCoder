"""GDScript LSP plugin: the gdls server from Dependencies, or ``CLARA_GDSCRIPT_LSP_COMMAND``."""

from __future__ import annotations

import logging
import os
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from clara_coder_backend.config import env_clara
from clara_coder_backend.domain import RuntimeGdscriptLspConfig
from clara_coder_backend.lsp.godot_project_root import resolve_godot_project_root
from clara_coder_backend.lsp.server_plugin import (
    LspServerNotInstalledError,
    LspServerPlugin,
    LspStartParams,
)
from clara_coder_backend.runtime.deps.paths import gdls_stub_cache_dir, get_runtime_gdls_dir
from clara_coder_backend.session.state import runtime_config

if TYPE_CHECKING:
    from clara_coder_backend.domain import SessionState

logger = logging.getLogger('clara_coder_backend.lsp.plugins.gdscript')

GDFORMAT_COMMAND = 'gdformat'
# gdls pipes the document through the formatter; ``-`` makes gdformat read stdin and print the result.
_GDFORMAT_ARGS = ['-']


@dataclass
class GdscriptPluginState:
    last_seed: str = ''
    project_root: Path | None = None


def _formatter_options(settings: RuntimeGdscriptLspConfig) -> dict[str, Any] | None:
    """``formatter`` init option: gdls advertises formatting only when one is configured.

    ``CLARA_GDSCRIPT_FORMATTER_COMMAND`` wins over Settings → LSP, then ``gdformat`` on ``PATH``.
    """

    raw = env_clara('CLARA_GDSCRIPT_FORMATTER_COMMAND', '').strip()
    if raw:
        parts = shlex.split(raw, posix=os.name != 'nt')
        return {'command': parts[0], 'args': parts[1:]} if parts else None
    if settings.formatter_command:
        return {
            'command': settings.formatter_command,
            'args': shlex.split(settings.formatter_args, posix=os.name != 'nt'),
        }
    found = shutil.which(GDFORMAT_COMMAND)
    return {'command': found, 'args': list(_GDFORMAT_ARGS)} if found else None


def _build_init_options(project_root: Path) -> dict[str, Any]:
    options: dict[str, Any] = {
        'projectRoot': str(project_root),
        # gdls adds its own ``stubs/`` below this, which is ``gdls_stub_cache_dir()``.
        'stubCacheDir': str(get_runtime_gdls_dir()),
    }
    settings = runtime_config.lsp.gdscript
    env_binary = env_clara('CLARA_GODOT_BINARY', '').strip()
    if env_binary or settings.allow_engine_api_dump:
        godot_binary = env_binary or settings.godot_binary_path
        if godot_binary:
            options['godotBinaryPath'] = godot_binary
    else:
        # gdls would otherwise find Godot on its own and run it on the project to dump the engine
        # API, which can load the project's native GDExtension libraries. Opening a file must not
        # run project code, so this takes an explicit opt-in; gdls's bundled classes cover the rest.
        options['autoDumpExtensionApi'] = False
    options['strict'] = {'profile': settings.diagnostics_profile}
    options['inlayHint'] = {
        'typeHints': settings.inlay_type_hints,
        'parameterHints': settings.inlay_parameter_hints,
    }
    formatter = _formatter_options(settings)
    if formatter:
        options['formatter'] = formatter
    return options


class GdscriptLspPlugin(LspServerPlugin):
    server_id = 'gdscript'

    #: gdls publishes versioned diagnostics on every open and change, clean files included, but the
    #: first publish waits for the cold index: about 13s for 3,000 scripts. ``initialize`` itself
    #: returns at once, so no longer startup timeout is needed.
    slow_diagnostics = True

    #: gdls answers with everything in scope (about 1,300 items) and leaves filtering to the client.
    completion_item_limit = 5000

    def create_state(self) -> Any:
        return GdscriptPluginState()

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        if env_clara('CLARA_GDSCRIPT_LSP_COMMAND', '').strip():
            return False
        st = state if isinstance(state, GdscriptPluginState) else GdscriptPluginState()
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
                'rename': {'prepareSupport': True},
                'semanticTokens': {
                    'requests': {'range': True, 'full': {'delta': True}},
                    # Monaco colours keywords and literals from the Godot grammars.
                    'augmentsSyntaxTokens': True,
                },
                'implementation': {'linkSupport': True},
                'typeDefinition': {'linkSupport': True},
                'declaration': {'linkSupport': True},
                'foldingRange': {'lineFoldingOnly': False},
                'selectionRange': {},
                'colorProvider': {},
                'documentLink': {'tooltipSupport': True},
                'callHierarchy': {},
                'typeHierarchy': {},
            },
            'workspace': {
                'symbol': {},
                'fileOperations': {'willRename': True, 'didRename': True},
            },
            'window': {'workDoneProgress': True},
        }

    def read_only_document_roots(self, state: Any) -> list[Path]:
        return [gdls_stub_cache_dir()]

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
        st = state if isinstance(state, GdscriptPluginState) else GdscriptPluginState()
        st.last_seed = relative_posix_path
        desired = resolve_godot_project_root(workspace_root, relative_posix_path)
        current = st.project_root
        st.project_root = desired
        if not client_running or current is None or current == desired:
            return False
        logger.info('gdscript LSP project root changed %s -> %s; restarting server', current, desired)
        return True

    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        session_id: str = '',
        scope: str = 'workspace',
    ) -> LspStartParams:
        st = state if isinstance(state, GdscriptPluginState) else GdscriptPluginState()
        project_root = st.project_root or resolve_godot_project_root(workspace_root, st.last_seed)
        st.project_root = project_root

        raw = env_clara('CLARA_GDSCRIPT_LSP_COMMAND', '').strip()
        if raw:
            command = shlex.split(raw, posix=os.name != 'nt')
            logger.info('gdscript LSP command override project=%s command=%s', project_root, command)
        else:
            from clara_coder_backend.runtime.deps.providers import gdls

            binary = gdls.installed_binary()
            if binary is None:
                raise LspServerNotInstalledError(
                    'GDScript LSP (gdls) is not installed. Open Dependencies and download '
                    '“GDScript LSP (gdls)”, then retry.'
                )
            command = [str(binary)]
            logger.info('gdscript LSP starting gdls binary=%s project=%s', binary, project_root)
        return LspStartParams(
            lsp_cwd=project_root,
            command=command,
            init_options=_build_init_options(project_root),
        )

    def after_shutdown(self, session: SessionState, state: Any) -> None:
        if isinstance(state, GdscriptPluginState):
            # ``compute_start_params`` resolves it again from the last seed.
            state.project_root = None
