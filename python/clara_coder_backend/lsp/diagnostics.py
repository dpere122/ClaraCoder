"""Normalize LSP payloads and render them for tool output."""

from __future__ import annotations

import re
from typing import Any

from clara_coder_backend.lsp.file_policy import is_prettier_managed_path, normalize_relative_posix_path

__all__ = [
    'diagnostic_severity_name',
    'normalize_lsp_diagnostics',
    'format_diagnostics_summary',
    'diagnostics_session_aggregate_preamble',
    'post_edit_checks_footer',
    'indentation_followup_guidance',
]

_SEVERITY_LABELS = {
    1: 'error',
    2: 'warning',
    3: 'information',
    4: 'hint',
}

# Messages matching this suggest indentation / tab-space problems (steer toward formatter + LSP verify).
_INDENT_DIAGNOSTIC_HINT = re.compile(
    r'indentation|unexpected\s+indent|unindent\s+does\s+not\s+match|mixed\s+tabs\s+and\s+spaces|'
    r'inconsistent\s+use\s+of\s+tabs|expected\s+an\s+indented\s+block|invalidIndentedBlock|IndentationError',
    re.IGNORECASE,
)


def diagnostic_severity_name(value: int | None) -> str:
    return _SEVERITY_LABELS.get(int(value or 3), 'information')


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def normalize_lsp_diagnostics(relative_path: str, items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    rel = normalize_relative_posix_path(relative_path)
    out: list[dict[str, Any]] = []
    for item in items or []:
        rng = item.get('range') if isinstance(item, dict) else None
        start = rng.get('start') if isinstance(rng, dict) else {}
        end = rng.get('end') if isinstance(rng, dict) else {}
        severity_value = _as_int(item.get('severity') if isinstance(item, dict) else None, 3)
        code_raw = item.get('code') if isinstance(item, dict) else ''
        source_raw = item.get('source') if isinstance(item, dict) else ''
        out.append(
            {
                'relative_path': rel,
                'message': str(item.get('message') or '').strip() if isinstance(item, dict) else '',
                'severity': diagnostic_severity_name(severity_value),
                'severity_value': severity_value,
                'code': '' if code_raw is None else str(code_raw),
                'source': '' if source_raw is None else str(source_raw),
                'line': _as_int(start.get('line')) + 1,
                'character': _as_int(start.get('character')) + 1,
                'end_line': _as_int(end.get('line')) + 1,
                'end_character': _as_int(end.get('character')) + 1,
            }
        )
    out.sort(key=lambda item: (item['line'], item['character'], item['severity_value'], item['message']))
    return out


def indentation_followup_guidance(
    relative_path: str,
    diagnostics: list[dict[str, Any]],
    *,
    lsp_scope: str,
) -> str:
    """When diagnostics look indentation-related, steer the model toward formatter + LSP refresh."""

    if not diagnostics:
        return ''
    for item in diagnostics:
        msg = str(item.get('message') or '')
        if _INDENT_DIAGNOSTIC_HINT.search(msg):
            break
    else:
        return ''

    rel = normalize_relative_posix_path(relative_path).lower()
    scope = (lsp_scope or 'workspace').strip().lower()
    lines = [
        '',
        'Steer (indentation-like diagnostics detected):',
    ]
    if scope == 'staging':
        if rel.endswith('.py'):
            lines.append(
                '- Call `format_staging_file_black` for this path, then `lsp_get_diagnostics` with '
                '`refresh_active_document=true` and `scope=staging` on the same path to verify the staged draft.'
            )
        elif is_prettier_managed_path(rel):
            lines.append(
                '- Call `format_staging_file_prettier` for this path, then `lsp_get_diagnostics` with '
                '`refresh_active_document=true` and `scope=staging` when the TypeScript/JavaScript server applies '
                '(`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`); for `.html`/`.htm`/`.css`, use `read_staged_edit` '
                'to verify the draft.'
            )
        else:
            lines.append(
                '- Fix whitespace with another accurate staging edit; refresh LSP for this path if the language '
                'server is available.'
            )
    elif rel.endswith('.py'):
        lines.append(
            '- Black already ran on the merged `.py` text before this listing. If indentation errors remain, '
            'correct the source and retry the workspace edit tool, or route the path through nested staging so '
            '`format_staging_file_black` is available after each stage.'
        )
    elif is_prettier_managed_path(rel):
        lines.append(
            '- Prettier already ran on merged text for this extension when the edit path used automatic formatting. '
            'If indentation errors remain, correct the source and retry the workspace edit tool, or route through '
            'nested staging so `format_staging_file_prettier` is available after each stage.'
        )
    else:
        lines.append(
            '- Correct indentation in the buffer and retry the edit tool, then `lsp_get_diagnostics` with '
            '`refresh_active_document=true` if you still need a fresh diagnostic pass.'
        )
    return '\n'.join(lines)


def post_edit_checks_footer(
    relative_path: str,
    diagnostics: list[dict[str, Any]],
    *,
    lsp_scope: str,
    server_kind: str | None,
    formatter_lines: list[str],
) -> str:
    """Human-readable block appended to edit tool results (formatter first, then LSP diagnostics)."""

    head = [
        '\n---',
        'Post-edit checks (formatter ran first where applicable, then LSP on that result):',
        *formatter_lines,
    ]
    if server_kind:
        analyzed = 'staged draft' if lsp_scope == 'staging' else 'workspace buffer'
        head.append(
            format_diagnostics_summary(
                relative_path,
                diagnostics,
                lsp_scope=lsp_scope,
                analyzed_source=analyzed,
                server_kind=server_kind,
            )
        )
    else:
        head.append('No integrated LSP for this path; formatter notes above are the only automated check.')
    body = '\n'.join(head)
    if server_kind:
        body += indentation_followup_guidance(relative_path, diagnostics, lsp_scope=lsp_scope)
    return body


def diagnostics_session_aggregate_preamble(lsp_scope: str) -> str:
    """First line when listing all cached diagnostics for a session (mixed refresh times)."""

    scope = (lsp_scope or 'workspace').strip() or 'workspace'
    return (
        f'LSP context: scope={scope}; aggregated session cache — paths may reflect different refresh times; '
        f'call `lsp_get_diagnostics` per path with `refresh_active_document=true` to re-sync.'
    )


def format_diagnostics_summary(
    relative_path: str,
    items: list[dict[str, Any]] | None,
    *,
    lsp_scope: str = '',
    analyzed_source: str = '',
    server_kind: str = '',
) -> str:
    """Render diagnostics with optional LSP scope/source labeling (workspace vs staging; disk vs draft vs cached)."""

    rel = normalize_relative_posix_path(relative_path)
    rel_display = rel if rel else '(path)'
    diagnostics = items or []

    prelude: list[str] = []
    if lsp_scope or analyzed_source:
        bits: list[str] = []
        if lsp_scope:
            bits.append(f'scope={lsp_scope}')
        if analyzed_source:
            bits.append(f'analyzed={analyzed_source}')
        if (lsp_scope or '').strip().lower() == 'staging':
            doc_note = (
                f'the materialized staging overlay file URI for `{rel_display}` '
                f'(other project files use the same overlay; heavy dirs may be symlinked from the real workspace).'
            )
        else:
            doc_note = f'the workspace file URI for `{rel_display}`.'
        prelude.append(
            f"LSP context: {'; '.join(bits)} (document buffer uses {doc_note})"
        )

    if not diagnostics:
        body = f'No LSP diagnostics for `{rel}`.'
        text = '\n'.join([*prelude, body]) if prelude else body
    else:
        lines = [f'LSP diagnostics for `{rel}` ({len(diagnostics)} issue(s)):']
        for item in diagnostics[:50]:
            source_bits = [item.get('severity', 'information')]
            if item.get('source'):
                source_bits.append(str(item['source']))
            if item.get('code'):
                source_bits.append(str(item['code']))
            label = '/'.join(source_bits)
            lines.append(
                f"- {item.get('line', 1)}:{item.get('character', 1)} [{label}] {item.get('message', '').strip() or '(no message)'}"
            )
        if len(diagnostics) > 50:
            lines.append(f'... {len(diagnostics) - 50} more diagnostic(s) omitted.')
        body = '\n'.join(lines)
        text = '\n'.join([*prelude, body]) if prelude else body

    if server_kind == 'python' and lsp_scope == 'staging':
        text += (
            '\n\nNote: Staging analysis uses a mirror workspace with pending drafts on disk; imports resolve against '
            'that mirror (symlinked dependency dirs such as `node_modules` point at the real workspace). '
            'Paths never transferred into staging are unchanged copies from the staging snapshot or live workspace baseline.'
        )
    return text
