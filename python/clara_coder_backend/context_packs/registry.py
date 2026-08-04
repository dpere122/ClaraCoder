"""Registry of deferred context packs (workflow knowledge activated on demand)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContextPack:
    """Deferred playbook knowledge for a tool family or service.

    ``summary`` is always advertised in the system-prompt catalog. ``body`` is
    injected once per session when the pack activates (first matching tool use
    or explicit ``activate_context``).
    """

    id: str
    summary: str
    body: str
    tool_prefixes: tuple[str, ...] = ()
    tool_names: tuple[str, ...] = ()
    #: When non-empty with ``tool_names``, activation also requires the tool's
    #: ``relative_path`` argument to end with one of these suffixes (case-insensitive).
    path_suffixes: tuple[str, ...] = ()


_PACKS: dict[str, ContextPack] = {}


def register_pack(pack: ContextPack) -> None:
    """Register or replace a pack by ``id``."""
    key = (pack.id or '').strip()
    if not key:
        raise ValueError('ContextPack.id must be non-empty')
    _PACKS[key] = pack


def get_pack(pack_id: str) -> ContextPack | None:
    return _PACKS.get((pack_id or '').strip())


def list_packs() -> list[ContextPack]:
    """Return packs sorted by id for stable catalogs."""
    return sorted(_PACKS.values(), key=lambda p: p.id)


def clear_registry_for_tests() -> None:
    """Empty the registry (tests only)."""
    _PACKS.clear()


def _path_matches(pack: ContextPack, relative_path: str | None) -> bool:
    if not pack.path_suffixes:
        return True
    path = (relative_path or '').strip().replace('\\', '/').lower()
    if not path:
        return False
    return any(path.endswith(suf.lower()) for suf in pack.path_suffixes)


def _name_matches(pack: ContextPack, tool_name: str) -> bool:
    name = (tool_name or '').strip()
    if not name:
        return False
    if name in pack.tool_names:
        return True
    return any(name.startswith(prefix) for prefix in pack.tool_prefixes if prefix)


def packs_for_tool(tool_name: str, *, relative_path: str | None = None) -> list[ContextPack]:
    """Packs whose tool binding matches ``tool_name`` (and optional path suffixes)."""
    out: list[ContextPack] = []
    for pack in list_packs():
        if not _name_matches(pack, tool_name):
            continue
        if not _path_matches(pack, relative_path):
            continue
        out.append(pack)
    return out


def format_context_catalog() -> str:
    """Short always-on inventory of registered packs for the system prompt."""
    import clara_coder_backend.context_packs.packs  # noqa: F401

    packs = list_packs()
    if not packs:
        return ''
    lines = [
        '- **Context packs** (workflow knowledge; auto-load on first related tool use, '
        'or call `activate_context`):'
    ]
    for pack in packs:
        lines.append(f'  - `{pack.id}` — {pack.summary}')
    return '\n'.join(lines) + '\n'
