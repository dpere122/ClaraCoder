"""``propose_theme``: let Clara author a UI theme the user can preview and save.

The tool does not block the agent. It validates the document against ``registry.json`` (token
catalog + element groups), pushes a ``theme_proposal`` event onto the session's nested event
queue (the same path ``run_command`` uses for terminal tabs) and returns a one-line summary.
The renderer shows a HITL card with Preview / Save / Dismiss; those actions are local to the
UI (Electron IPC) and never round-trip to Python.
"""

from __future__ import annotations

import json
import re
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.tool_conventions import describe

PROPOSE_THEME_NAME = 'propose_theme'
THEME_PROPOSAL_EVENT = 'theme_proposal'

_REGISTRY_PATH = Path(__file__).with_name('registry.json')

_THEME_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,63}$')
_UNSAFE_TOKEN_VALUE_RE = re.compile(r'[;{}<>]|/\*|url\s*\(|expression\s*\(|javascript\s*:|@', re.IGNORECASE)
_HEX_RE = re.compile(r'^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
_BARE_HEX_RE = re.compile(r'^#?(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
_MONACO_KEY_RE = re.compile(r'^[A-Za-z][A-Za-z0-9.]*$')
_RULE_TOKEN_RE = re.compile(r'^[A-Za-z0-9._-]*$')

_MODES = ('dark', 'light')
_FITS = ('cover', 'contain', 'tile', 'center')
_MONACO_BASES = ('vs', 'vs-dark', 'hc-black', 'hc-light')

_MAX_NAME = 80
_MAX_DESCRIPTION = 400
_MAX_TOKEN_VALUE = 400
_MAX_GROUP_CSS = 20_000
_MAX_SUMMARY = 600
_MAX_MONACO_RULES = 200


@lru_cache(maxsize=1)
def load_theme_registry() -> dict[str, Any]:
    """Generated registry (groups + token catalog). Cached for the process lifetime."""
    with _REGISTRY_PATH.open('r', encoding='utf-8') as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError('theme registry must be a JSON object')
    return data


def _registry_token_names() -> set[str]:
    return {t['name'] for t in load_theme_registry().get('tokens', []) if isinstance(t, dict) and 'name' in t}


def _registry_groups() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for g in load_theme_registry().get('groups', []):
        if isinstance(g, dict) and isinstance(g.get('id'), str):
            out[g['id']] = g
    return out


def theme_registry_summary(*, max_groups: int | None = None) -> str:
    """Compact text for the tool description: token names by category and group ids by category."""
    reg = load_theme_registry()
    tokens_by_cat: dict[str, list[str]] = {}
    for t in reg.get('tokens', []):
        if not isinstance(t, dict) or t.get('alias'):
            # Alias tokens default to `var(--t-…)` of a canonical token; agents need not set them.
            continue
        tokens_by_cat.setdefault(str(t.get('category', 'other')), []).append(str(t.get('name', '')))
    token_lines = [f"{cat}: {', '.join(names)}" for cat, names in tokens_by_cat.items()]

    groups = list(reg.get('groups', []))
    if max_groups is not None:
        groups = groups[:max_groups]
    group_ids = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        flag = ' (bg)' if g.get('supportsBackground') else ''
        group_ids.append(f"{g.get('id')}{flag}")
    return 'Tokens — ' + '; '.join(token_lines) + '. Groups — ' + ', '.join(group_ids) + '.'


def _slugify(value: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', value.lower()).strip('-')[:64]
    if _THEME_ID_RE.match(slug):
        return slug
    return f'{slug}-theme' if len(slug) == 1 else 'custom-theme'


def _safe_token_value(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or len(v) > _MAX_TOKEN_VALUE or _UNSAFE_TOKEN_VALUE_RE.search(v):
        return None
    return v


def _validate_tokens(raw: Any, path: str, known: set[str], warnings: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        warnings.append(f'{path}: must be an object (dropped)')
        return out
    for key, value in raw.items():
        if key not in known:
            warnings.append(f'{path}.{key}: unknown token (dropped)')
            continue
        safe = _safe_token_value(value)
        if safe is None:
            warnings.append(f'{path}.{key}: unsafe or empty value (dropped)')
            continue
        out[key] = safe
    return out


def _validate_background(raw: Any, path: str, warnings: list[str]) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        warnings.append(f'{path}: must be an object (dropped)')
        return None
    opacity_raw = raw.get('opacity', 0.35)
    try:
        opacity = float(opacity_raw)
    except (TypeError, ValueError):
        opacity = 0.35
        warnings.append(f'{path}.opacity: must be a number (defaulted)')
    # Whole numbers above 1 read as percentages (40 → 0.4); other values above 1 clamp.
    if opacity > 1 and opacity.is_integer():
        opacity = opacity / 100.0
    opacity = max(0.0, min(1.0, opacity))
    fit = raw.get('fit', 'cover')
    if fit not in _FITS:
        warnings.append(f'{path}.fit: unknown fit (defaulted to cover)')
        fit = 'cover'
    asset = raw.get('asset', '')
    if not isinstance(asset, str):
        asset = ''
    # Agents cannot ship image files; keep the slot so the user can pick one in Settings.
    if asset:
        warnings.append(f'{path}.asset: assets cannot be attached by the agent; the user picks an image in Settings')
    return {'enabled': False, 'asset': '', 'opacity': round(opacity, 3), 'fit': fit}


def _validate_groups(raw: Any, known_tokens: set[str], warnings: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        warnings.append('groups: must be an object (dropped)')
        return out
    groups = _registry_groups()
    for group_id, entry in raw.items():
        path = f'groups.{group_id}'
        definition = groups.get(group_id)
        if definition is None:
            warnings.append(f'{path}: unknown group id (dropped)')
            continue
        if not isinstance(entry, dict):
            warnings.append(f'{path}: must be an object (dropped)')
            continue
        override: dict[str, Any] = {}
        tokens = _validate_tokens(entry.get('tokens'), f'{path}.tokens', known_tokens, warnings)
        if tokens:
            override['tokens'] = tokens
        css = entry.get('css')
        if isinstance(css, str) and css.strip():
            if len(css) > _MAX_GROUP_CSS:
                warnings.append(f'{path}.css: truncated to {_MAX_GROUP_CSS} characters')
                css = css[:_MAX_GROUP_CSS]
            override['css'] = css
        elif css is not None and not isinstance(css, str):
            warnings.append(f'{path}.css: must be a string (dropped)')
        if definition.get('supportsBackground'):
            background = _validate_background(entry.get('background'), f'{path}.background', warnings)
            if background is not None:
                override['background'] = background
        elif entry.get('background') is not None:
            warnings.append(f'{path}.background: this group does not support background images (dropped)')
        if override:
            out[group_id] = override
    return out


def _monaco_hex(value: Any) -> str | None:
    if not isinstance(value, str) or not _HEX_RE.match(value.strip()):
        return None
    v = value.strip()[1:].lower()
    if len(v) in (3, 4):
        v = ''.join(ch * 2 for ch in v)
    return f'#{v}'


def _bare_hex(value: Any) -> str | None:
    if not isinstance(value, str) or not _BARE_HEX_RE.match(value.strip()):
        return None
    v = value.strip()
    return (v[1:] if v.startswith('#') else v).lower()


def _default_monaco_base(mode: str) -> str:
    return 'vs' if mode == 'light' else 'vs-dark'


def _validate_monaco(raw: Any, mode: str, warnings: list[str]) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        warnings.append('monaco: must be an object (dropped)')
        return None
    fallback_base = _default_monaco_base(mode)
    base_raw = raw.get('base')
    base = base_raw if base_raw in _MONACO_BASES else fallback_base
    if base_raw is not None and base != base_raw:
        warnings.append(f'monaco.base: unknown base (defaulted to {fallback_base})')
    colors: dict[str, str] = {}
    colors_raw = raw.get('colors')
    if isinstance(colors_raw, dict):
        for key, value in colors_raw.items():
            if not isinstance(key, str) or not _MONACO_KEY_RE.match(key):
                warnings.append(f'monaco.colors.{key}: invalid color id (dropped)')
                continue
            hex_value = _monaco_hex(value)
            if hex_value is None:
                warnings.append(f'monaco.colors.{key}: must be a hex color (dropped)')
                continue
            colors[key] = hex_value
    elif colors_raw is not None:
        warnings.append('monaco.colors: must be an object (dropped)')
    rules: list[dict[str, Any]] = []
    rules_raw = raw.get('rules')
    if isinstance(rules_raw, list):
        for index, rule in enumerate(rules_raw):
            if len(rules) >= _MAX_MONACO_RULES:
                warnings.append(f'monaco.rules: only the first {_MAX_MONACO_RULES} rules are kept')
                break
            if not isinstance(rule, dict) or not isinstance(rule.get('token'), str) or not _RULE_TOKEN_RE.match(rule['token']):
                warnings.append(f'monaco.rules[{index}]: invalid rule (dropped)')
                continue
            entry: dict[str, Any] = {'token': rule['token']}
            fg = _bare_hex(rule.get('foreground'))
            bg = _bare_hex(rule.get('background'))
            if fg:
                entry['foreground'] = fg
            if bg:
                entry['background'] = bg
            style = rule.get('fontStyle')
            if isinstance(style, str) and re.match(r'^[a-z ]{0,40}$', style):
                entry['fontStyle'] = style
            rules.append(entry)
    elif rules_raw is not None:
        warnings.append('monaco.rules: must be an array (dropped)')
    if base_raw is None and not colors and not rules:
        # `monaco: {}` would replace the token-derived palette with a bare stock theme.
        warnings.append('monaco: empty; the editor palette stays derived from the tokens')
        return None
    return {'base': base, 'colors': colors, 'rules': rules}


def validate_theme_proposal(raw: Any) -> tuple[dict[str, Any] | None, list[str]]:
    """Normalize an agent-authored theme; ``None`` with an error message list when unusable."""
    warnings: list[str] = []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None, ['theme must be a JSON object (got an unparsable string)']
    if not isinstance(raw, dict):
        return None, ['theme must be a JSON object']

    version = raw.get('version', 1)
    if version != 1:
        return None, [f'unsupported theme version {version!r}']

    name_raw = raw.get('name')
    name = name_raw.strip()[:_MAX_NAME] if isinstance(name_raw, str) else ''
    id_raw = raw.get('id')
    theme_id = id_raw.strip() if isinstance(id_raw, str) else ''
    if not theme_id and name:
        theme_id = _slugify(name)
    if not _THEME_ID_RE.match(theme_id):
        if theme_id:
            theme_id = _slugify(theme_id)
        else:
            return None, ['name (or id) is required']
    if not name:
        name = theme_id

    mode = raw.get('mode', 'dark')
    if mode not in _MODES:
        warnings.append('mode: must be "dark" or "light" (defaulted to dark)')
        mode = 'dark'

    known_tokens = _registry_token_names()
    tokens = _validate_tokens(raw.get('tokens'), 'tokens', known_tokens, warnings)
    if raw.get('tokens') is None:
        warnings.append('tokens: missing; the theme inherits every built-in token')
    groups = _validate_groups(raw.get('groups'), known_tokens, warnings)
    monaco = _validate_monaco(raw.get('monaco'), mode, warnings)
    if raw.get('assets'):
        warnings.append('assets: dropped; images are added by the user in Settings → Themes')

    doc: dict[str, Any] = {
        'version': 1,
        'id': theme_id,
        'name': name,
        'mode': mode,
        'tokens': tokens,
        'groups': groups,
    }
    description = raw.get('description')
    if isinstance(description, str) and description.strip():
        doc['description'] = description.strip()[:_MAX_DESCRIPTION]
    author = raw.get('author')
    if isinstance(author, str) and author.strip():
        doc['author'] = author.strip()[:_MAX_NAME]
    else:
        doc['author'] = 'Clara'
    if monaco is not None:
        doc['monaco'] = monaco
    return doc, warnings


def build_theme_proposal_payload(doc: dict[str, Any], summary: str, warnings: list[str]) -> dict[str, Any]:
    """Wire payload for the ``theme_proposal`` SSE event (camelCase, versioned)."""
    return {
        'version': 1,
        'requestId': f'theme-{uuid.uuid4().hex[:12]}',
        'title': f"Theme proposal: {doc['name']}",
        'summary': (summary or '').strip()[:_MAX_SUMMARY],
        'theme': doc,
        'warnings': warnings[:40],
    }


_TOOL_DESCRIPTION = describe(
    'Propose a complete app theme (colors, per-element-group overrides, optional Monaco palette) that the user can '
    'preview live and save from a card in chat. Does not pause; keep working or finish your reply after calling it.',
    when='the user asks for a new look, color scheme, theme, or wants an element group restyled.',
    not_='changing editor behaviour settings; that is Settings → Editor.',
    shape=(
        '`theme` = {name, mode: dark|light, description?, tokens: {"--t-…": cssValue}, '
        'groups?: {"<category>.<name>": {tokens?, css?, background?: {opacity 0–1, fit}}}, '
        'monaco?: {base, colors: {id: "#rrggbb"}, rules: [{token, foreground: "rrggbb", fontStyle?}]}}. '
        'Only catalog tokens and registered group ids are kept; group css is scoped to the group root '
        '(`&` = root). Give every color token a value for a complete theme. `summary` = 1–2 sentences for the card. '
        + theme_registry_summary()
    ),
)


@tool(PROPOSE_THEME_NAME, description=_TOOL_DESCRIPTION)
async def propose_theme_tool(theme: dict[str, Any] | str, summary: str = '') -> str:
    doc, notes = validate_theme_proposal(theme)
    if doc is None:
        return 'Tool error: ' + '; '.join(notes)

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    queue = getattr(session, 'planning_nested_events_q', None)
    if queue is None:
        return 'Tool error: no live chat stream to deliver the proposal to.'

    payload = build_theme_proposal_payload(doc, summary, notes)
    await queue.put(('agent', {'event': THEME_PROPOSAL_EVENT, 'data': payload}))

    token_count = len(doc['tokens'])
    group_count = len(doc['groups'])
    summary_line = (
        f"Proposed theme \"{doc['name']}\" ({doc['mode']}, {token_count} tokens, {group_count} group override"
        f"{'' if group_count == 1 else 's'}"
        f"{', custom Monaco palette' if doc.get('monaco') else ''}). "
        'The user can preview, save, or dismiss it from the card in chat.'
    )
    if notes:
        shown = notes[:5]
        more = f' (+{len(notes) - 5} more)' if len(notes) > 5 else ''
        summary_line += ' Dropped/adjusted: ' + '; '.join(shown) + more + '.'
    return summary_line


__all__ = [
    'PROPOSE_THEME_NAME',
    'THEME_PROPOSAL_EVENT',
    'build_theme_proposal_payload',
    'load_theme_registry',
    'propose_theme_tool',
    'theme_registry_summary',
    'validate_theme_proposal',
]
