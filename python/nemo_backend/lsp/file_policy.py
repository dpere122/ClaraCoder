"""Shared file classification for code review and Python LSP routing."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath

__all__ = [
    'PythonLspFilePolicy',
    'LANGUAGE_POLICIES',
    'LEGACY_CODE_REVIEW_EXTENSIONS',
    'normalize_relative_posix_path',
    'get_python_lsp_policy',
    'is_lsp_managed_path',
    'is_programming_path',
    'requires_code_review',
]


@dataclass(frozen=True)
class PythonLspFilePolicy:
    """Describes how a file type participates in the LSP-aware toolchain."""

    extension: str
    language_id: str
    language_label: str
    use_lsp: bool = True
    requires_review: bool = True


LANGUAGE_POLICIES: dict[str, PythonLspFilePolicy] = {
    '.py': PythonLspFilePolicy(
        extension='.py',
        language_id='python',
        language_label='Python',
        use_lsp=True,
        requires_review=True,
    ),
}

# Existing non-LSP code-review set stays intact for now so v1 only changes Python routing.
LEGACY_CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
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


def normalize_relative_posix_path(relative_path: str) -> str:
    return relative_path.strip().replace('\\', '/')


def _suffix(relative_path: str) -> str:
    return PurePosixPath(normalize_relative_posix_path(relative_path)).suffix.lower()


def get_python_lsp_policy(relative_path: str) -> PythonLspFilePolicy | None:
    return LANGUAGE_POLICIES.get(_suffix(relative_path))


def is_lsp_managed_path(relative_path: str) -> bool:
    policy = get_python_lsp_policy(relative_path)
    return bool(policy and policy.use_lsp)


def is_programming_path(relative_path: str) -> bool:
    suffix = _suffix(relative_path)
    return suffix in LANGUAGE_POLICIES or suffix in LEGACY_CODE_REVIEW_EXTENSIONS


def requires_code_review(relative_path: str) -> bool:
    policy = get_python_lsp_policy(relative_path)
    if policy is not None:
        return policy.requires_review
    return _suffix(relative_path) in LEGACY_CODE_REVIEW_EXTENSIONS
