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
