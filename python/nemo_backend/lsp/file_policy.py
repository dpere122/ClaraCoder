"""Shared file classification for code review and LSP routing."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath

__all__ = [
    'LspFilePolicy',
    'PythonLspFilePolicy',
    'LANGUAGE_POLICIES',
    'LEGACY_CODE_REVIEW_EXTENSIONS',
    'CONFIG_CODE_REVIEW_EXTENSIONS',
    'PRETTIER_MANAGED_SUFFIXES',
    'normalize_relative_posix_path',
    'get_lsp_file_policy',
    'get_python_lsp_policy',
    'lsp_server_for_path',
    'is_lsp_managed_path',
    'is_prettier_managed_path',
    'is_programming_path',
    'outer_workspace_edit_guard_error',
    'requires_code_review',
]


@dataclass(frozen=True)
class LspFilePolicy:
    """Describes how a file type participates in the LSP-aware toolchain."""

    extension: str
    language_id: str
    language_label: str
    lsp_server: str
    use_lsp: bool = True
    requires_review: bool = True


# Backward-compatible alias used in older references / docs.
PythonLspFilePolicy = LspFilePolicy

LANGUAGE_POLICIES: dict[str, LspFilePolicy] = {
    '.py': LspFilePolicy(
        extension='.py',
        language_id='python',
        language_label='Python',
        lsp_server='python',
        use_lsp=True,
        requires_review=True,
    ),
    '.ts': LspFilePolicy(
        extension='.ts',
        language_id='typescript',
        language_label='TypeScript',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
    '.tsx': LspFilePolicy(
        extension='.tsx',
        language_id='typescriptreact',
        language_label='TSX',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
    '.js': LspFilePolicy(
        extension='.js',
        language_id='javascript',
        language_label='JavaScript',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
    '.jsx': LspFilePolicy(
        extension='.jsx',
        language_id='javascriptreact',
        language_label='JSX',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
    '.mjs': LspFilePolicy(
        extension='.mjs',
        language_id='javascript',
        language_label='JavaScript',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
    '.cjs': LspFilePolicy(
        extension='.cjs',
        language_id='javascript',
        language_label='JavaScript',
        lsp_server='typescript',
        use_lsp=True,
        requires_review=True,
    ),
}

# Extensions that require nested code review but are not served by an integrated LSP yet.
LEGACY_CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {
        '.go',
        '.rs',
        '.java',
        '.cs',
        '.rb',
        '.php',
        '.kt',
        '.kts',
        '.swift',
        '.vue',
        '.svelte',
        '.scala',
        '.c',
        '.h',
        '.cpp',
        '.hpp',
        '.cc',
        '.cxx',
        '.m',
        '.mm',
    }
)

# Structured project/config formats: reviewed like source (no integrated LSP).
CONFIG_CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {
        '.json',
        '.jsonc',
        '.yaml',
        '.yml',
        '.xml',
        '.toml',
        '.ini',
        '.cfg',
        '.conf',
        '.properties',
        '.editorconfig',
    }
)


# Extensions formatted with Prettier in workspace/staging edit pipelines (stdin-filepath; no LSP requirement).
PRETTIER_MANAGED_SUFFIXES: frozenset[str] = frozenset(
    {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.htm', '.css'}
)


def normalize_relative_posix_path(relative_path: str) -> str:
    return relative_path.strip().replace('\\', '/')


def _suffix(relative_path: str) -> str:
    return PurePosixPath(normalize_relative_posix_path(relative_path)).suffix.lower()


def is_prettier_managed_path(relative_path: str) -> bool:
    return _suffix(relative_path) in PRETTIER_MANAGED_SUFFIXES


def get_lsp_file_policy(relative_path: str) -> LspFilePolicy | None:
    return LANGUAGE_POLICIES.get(_suffix(relative_path))


def get_python_lsp_policy(relative_path: str) -> LspFilePolicy | None:
    """Return the LSP policy when the path is managed by the Python language server."""

    policy = get_lsp_file_policy(relative_path)
    if policy is not None and policy.lsp_server == 'python':
        return policy
    return None


def lsp_server_for_path(relative_path: str) -> str | None:
    """Return ``python`` or ``typescript`` for paths with an integrated LSP, else None."""

    policy = get_lsp_file_policy(relative_path)
    if policy is not None and policy.use_lsp:
        return policy.lsp_server
    return None


def is_lsp_managed_path(relative_path: str) -> bool:
    policy = get_lsp_file_policy(relative_path)
    return bool(policy and policy.use_lsp)


def is_programming_path(relative_path: str) -> bool:
    suffix = _suffix(relative_path)
    return (
        suffix in LANGUAGE_POLICIES
        or suffix in LEGACY_CODE_REVIEW_EXTENSIONS
        or suffix in CONFIG_CODE_REVIEW_EXTENSIONS
    )


def requires_code_review(relative_path: str) -> bool:
    policy = get_lsp_file_policy(relative_path)
    if policy is not None:
        return policy.requires_review
    suf = _suffix(relative_path)
    return suf in LEGACY_CODE_REVIEW_EXTENSIONS or suf in CONFIG_CODE_REVIEW_EXTENSIONS


def outer_workspace_edit_guard_error(relative_workspace_path: str) -> str | None:
    """If the path must use nested staging, return a tool error for direct workspace edit tools; else None."""
    if not requires_code_review(relative_workspace_path):
        return None
    return (
        'Tool error: code-review extensions (.py, .ts, .js, .json, .yaml, etc.) must be edited through the '
        'staging pipeline (`stage_create_file` / `stage_workspace_file_overwrite` / `stage_line_range_edit` / '
        '`stage_snippet_edit`, then `transfer_staged_file_to_workspace`) when those tools are on your graph—not '
        'legacy direct-to-disk workspace mutators.'
    )
