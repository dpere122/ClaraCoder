"""vtsls settings (the ``typescript`` / ``javascript`` / ``js/ts`` / ``vtsls`` sections) from Settings → LSP."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import RuntimeTypescriptLspConfig
from clara_coder_backend.lsp.file_policy import get_lsp_file_policy

__all__ = ['build_typescript_initialization_options', 'javascript_diagnostics_off_reason']

#: ``javascript.validate.enable`` covers both; vtsls reads ``typescript.*`` for ``.ts`` / ``.tsx``.
_JAVASCRIPT_LANGUAGE_IDS = frozenset({'javascript', 'javascriptreact'})


def _typescript_lsp_settings() -> RuntimeTypescriptLspConfig:
    # Imported here: ``session.state`` pulls in most of the backend.
    from clara_coder_backend.session.state import runtime_config

    return runtime_config.lsp.typescript


def _language_section(s: RuntimeTypescriptLspConfig) -> dict[str, Any]:
    """Settings vtsls reads per language; Clara uses the same values for TypeScript and JavaScript."""

    return {
        'inlayHints': {
            'parameterNames': {'enabled': s.inlay_parameter_names},
            'parameterTypes': {'enabled': s.inlay_parameter_types},
            'variableTypes': {'enabled': s.inlay_variable_types},
            'propertyDeclarationTypes': {'enabled': s.inlay_property_declaration_types},
            'functionLikeReturnTypes': {'enabled': s.inlay_function_return_types},
            'enumMemberValues': {'enabled': s.inlay_enum_member_values},
        },
        'suggest': {'autoImports': s.auto_import_completions},
        'preferences': {
            'importModuleSpecifier': s.import_module_specifier,
            'quoteStyle': s.quote_style,
        },
    }


def build_typescript_initialization_options(
    settings: RuntimeTypescriptLspConfig | None = None,
) -> dict[str, Any]:
    """vtsls settings for ``initialize`` / ``workspace/configuration``.

    vtsls asks for the whole configuration (``section: ''``) once it has initialized and takes
    ``workspace/didChangeConfiguration`` after that, so the keys mirror VS Code's settings tree.
    ``settings`` defaults to Settings → LSP → TypeScript / JavaScript. A project ``tsconfig.json`` /
    ``jsconfig.json`` still decides its own compiler options; ``checkJs`` here only covers JavaScript
    files outside one.
    """

    s = settings if settings is not None else _typescript_lsp_settings()
    javascript = _language_section(s)
    javascript['validate'] = {'enable': s.validate_javascript}
    return {
        'typescript': _language_section(s),
        'javascript': javascript,
        'js/ts': {'implicitProjectConfig': {'checkJs': s.check_js}},
        'vtsls': {'autoUseWorkspaceTsdk': s.use_workspace_tsdk},
    }


def javascript_diagnostics_off_reason(
    relative_posix_path: str,
    settings: RuntimeTypescriptLspConfig | None = None,
) -> str:
    """Why vtsls reports nothing for this file, or ``''``.

    With ``javascript.validate.enable`` off vtsls never asks tsserver for a JavaScript file's errors,
    so it never publishes for one (not even an empty list).
    """

    policy = get_lsp_file_policy(relative_posix_path)
    if policy is None or policy.language_id not in _JAVASCRIPT_LANGUAGE_IDS:
        return ''
    s = settings if settings is not None else _typescript_lsp_settings()
    if s.validate_javascript:
        return ''
    return (
        'JavaScript error checking is off (Settings → LSP → TypeScript / JavaScript → '
        '"Report errors in JavaScript files"), so the language server reports no problems for this file.'
    )
