"""Normalize LSP payloads and render them for tool output."""

from __future__ import annotations

from typing import Any

from nemo_backend.lsp.file_policy import normalize_relative_posix_path

__all__ = [
    'diagnostic_severity_name',
    'normalize_lsp_diagnostics',
    'format_diagnostics_summary',
]

_SEVERITY_LABELS = {
    1: 'error',
    2: 'warning',
    3: 'information',
    4: 'hint',
}


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


def format_diagnostics_summary(relative_path: str, items: list[dict[str, Any]] | None) -> str:
    rel = normalize_relative_posix_path(relative_path)
    diagnostics = items or []
    if not diagnostics:
        return f'No LSP diagnostics for `{rel}`.'

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
    return '\n'.join(lines)
