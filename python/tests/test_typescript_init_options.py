"""Tests for the vtsls settings built from Settings → LSP → TypeScript / JavaScript."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeTypescriptLspConfig, SessionState
from clara_coder_backend.lsp.client import configuration_values_for_items
from clara_coder_backend.lsp.typescript_init_options import build_typescript_initialization_options


def test_defaults_match_vtsls_defaults() -> None:
    opts = build_typescript_initialization_options(RuntimeTypescriptLspConfig())
    for language in ('typescript', 'javascript'):
        section = opts[language]
        assert section['inlayHints'] == {
            'parameterNames': {'enabled': 'none'},
            'parameterTypes': {'enabled': False},
            'variableTypes': {'enabled': False},
            'propertyDeclarationTypes': {'enabled': False},
            'functionLikeReturnTypes': {'enabled': False},
            'enumMemberValues': {'enabled': False},
        }
        assert section['suggest'] == {'autoImports': True}
        assert section['preferences'] == {'importModuleSpecifier': 'shortest', 'quoteStyle': 'auto'}
    assert opts['javascript']['validate'] == {'enable': True}
    assert 'validate' not in opts['typescript'], 'TypeScript errors are never turned off from here'
    assert opts['js/ts'] == {'implicitProjectConfig': {'checkJs': False}}
    assert opts['vtsls'] == {'autoUseWorkspaceTsdk': False}


def test_applies_settings_to_both_languages() -> None:
    opts = build_typescript_initialization_options(
        RuntimeTypescriptLspConfig(
            use_workspace_tsdk=True,
            validate_javascript=False,
            check_js=True,
            inlay_parameter_names='all',
            inlay_variable_types=True,
            inlay_function_return_types=True,
            auto_import_completions=False,
            import_module_specifier='relative',
            quote_style='single',
        )
    )
    for language in ('typescript', 'javascript'):
        section = opts[language]
        assert section['inlayHints']['parameterNames'] == {'enabled': 'all'}
        assert section['inlayHints']['variableTypes'] == {'enabled': True}
        assert section['inlayHints']['functionLikeReturnTypes'] == {'enabled': True}
        assert section['inlayHints']['enumMemberValues'] == {'enabled': False}
        assert section['suggest'] == {'autoImports': False}
        assert section['preferences'] == {'importModuleSpecifier': 'relative', 'quoteStyle': 'single'}
    assert opts['javascript']['validate'] == {'enable': False}
    assert opts['js/ts']['implicitProjectConfig']['checkJs'] is True
    assert opts['vtsls']['autoUseWorkspaceTsdk'] is True


def test_language_sections_are_separate_objects() -> None:
    opts = build_typescript_initialization_options(RuntimeTypescriptLspConfig())
    assert opts['typescript'] is not opts['javascript']
    assert opts['typescript']['inlayHints'] is not opts['javascript']['inlayHints']


def test_vtsls_whole_configuration_request_gets_every_section() -> None:
    """vtsls asks for ``section: ''`` once it has initialized and reads ``typescript.*`` etc. from that."""

    opts = build_typescript_initialization_options(RuntimeTypescriptLspConfig(check_js=True))
    [whole] = configuration_values_for_items(opts, {'items': [{'section': ''}]})
    assert whole == opts
    [check_js] = configuration_values_for_items(opts, {'items': [{'section': 'js/ts.implicitProjectConfig.checkJs'}]})
    assert check_js is True


def test_reads_runtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(runtime_config.lsp, 'typescript', RuntimeTypescriptLspConfig(quote_style='double'))
    opts = build_typescript_initialization_options()
    assert opts['typescript']['preferences']['quoteStyle'] == 'double'


def test_plugin_starts_vtsls_with_the_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.lsp.plugins.typescript_plugin import TypescriptLspPlugin
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(runtime_config.lsp, 'typescript', RuntimeTypescriptLspConfig(inlay_parameter_names='literals'))
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    plugin = TypescriptLspPlugin()
    params = plugin.compute_start_params(session=SessionState(), workspace_root=tmp_path, state=plugin.create_state())
    assert params.init_options['javascript']['inlayHints']['parameterNames'] == {'enabled': 'literals'}


@pytest.mark.parametrize('path', ['src/app.js', 'src/App.jsx', 'lib/x.mjs', 'lib/x.cjs'])
def test_javascript_reports_nothing_only_while_its_errors_are_off(path: str) -> None:
    from clara_coder_backend.lsp.typescript_init_options import javascript_diagnostics_off_reason

    assert javascript_diagnostics_off_reason(path, RuntimeTypescriptLspConfig()) == ''
    reason = javascript_diagnostics_off_reason(path, RuntimeTypescriptLspConfig(validate_javascript=False))
    assert 'Report errors in JavaScript files' in reason


@pytest.mark.parametrize('path', ['src/app.ts', 'src/App.tsx', 'tool.py', 'README'])
def test_typescript_and_other_files_always_report(path: str) -> None:
    from clara_coder_backend.lsp.typescript_init_options import javascript_diagnostics_off_reason

    assert javascript_diagnostics_off_reason(path, RuntimeTypescriptLspConfig(validate_javascript=False)) == ''


class _SilentClient:
    """vtsls with ``javascript.validate.enable`` off: never publishes for a JavaScript file."""

    def __init__(self) -> None:
        self.closed = False

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities, initialization_options
        return {'capabilities': {'textDocumentSync': {'openClose': True, 'change': 2}}}

    def request(self, method, params, *, timeout_s=10.0):
        del params, timeout_s
        if method == 'shutdown':
            self.closed = True
        return {}

    def notify(self, method, params):
        del params
        if method == 'exit':
            self.closed = True

    def is_running(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def shutdown(self) -> None:
        self.closed = True


def test_agent_does_not_wait_for_javascript_diagnostics_that_are_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    from clara_coder_backend.lsp.manager import get_session_lsp_manager, shutdown_all_lsp_managers
    from clara_coder_backend.session.state import current_session_id, get_session, runtime_config

    monkeypatch.setattr(runtime_config.lsp, 'typescript', RuntimeTypescriptLspConfig(validate_javascript=False))
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'package.json').write_text('{}', encoding='utf-8')
    session_id = 'ts-js-validation-off'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''
    shutdown_all_lsp_managers()
    try:
        manager = get_session_lsp_manager(
            session_id,
            server='typescript',
            client_factory=lambda **_: _SilentClient(),
        )
        started = time.monotonic()
        assert manager.sync_document('app.js', 'const a = 1;\n', wait_for_diagnostics=True) == []
        assert manager.sync_document('app.js', 'const a = 1;\n', wait_for_diagnostics=True) == []
        assert time.monotonic() - started < 1.0, 'no publish is coming, so there is nothing to wait for'
        assert manager.diagnostics_fresh('app.js')
        assert 'JavaScript error checking is off' in manager.diagnostics_off_reason('app.js')
        assert manager.diagnostics_off_reason('app.ts') == ''
    finally:
        shutdown_all_lsp_managers()
        current_session_id.reset(token)
