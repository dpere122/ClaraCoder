"""Session-scoped inject-once helpers for context packs."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.context_packs.registry import ContextPack, get_pack, packs_for_tool
from clara_coder_backend.domain import SessionState


def _stringify_content(content: Any) -> str:
    """Local stringify to avoid importing ``llm.messages`` at module load (circular import)."""
    if content is None:
        return ''
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get('type') == 'text':
                parts.append(str(block.get('text') or ''))
            else:
                parts.append(str(block))
        return ''.join(parts)
    return str(content)


def _ensure_builtin_packs_loaded() -> None:
    """Import pack modules so ``register_pack`` side effects run."""
    import clara_coder_backend.context_packs.packs  # noqa: F401


def format_pack_injection(pack: ContextPack) -> str:
    """Labeled knowledge block prepended to a tool result on first activation."""
    body = (pack.body or '').strip()
    return f'---\nContext pack `{pack.id}` (activated):\n{body}\n---\n'


def is_pack_activated(session: SessionState, pack_id: str) -> bool:
    return (pack_id or '').strip() in session.activated_context_packs


def mark_pack_activated(session: SessionState, pack_id: str) -> bool:
    """Mark pack active. Returns True if this was the first activation."""
    key = (pack_id or '').strip()
    if not key:
        return False
    if key in session.activated_context_packs:
        return False
    session.activated_context_packs.add(key)
    return True


def activate_pack(session: SessionState, pack_id: str) -> str:
    """Explicit activation: return pack body or an already-active / unknown note."""
    _ensure_builtin_packs_loaded()
    key = (pack_id or '').strip()
    pack = get_pack(key)
    if pack is None:
        from clara_coder_backend.context_packs.registry import list_packs

        ids = ', '.join(f'`{p.id}`' for p in list_packs()) or '(none registered)'
        return f'Tool note: unknown context pack `{key or "(empty)"}`. Available: {ids}.'
    if not mark_pack_activated(session, pack.id):
        return f'Tool note: context pack `{pack.id}` is already active for this session.'
    return format_pack_injection(pack).rstrip()


def relative_path_from_tool_args(args: Any) -> str | None:
    if not isinstance(args, dict):
        return None
    raw = args.get('relative_path')
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def maybe_activate_for_tool(
    session: SessionState,
    tool_name: str,
    tool_result: Any,
    *,
    relative_path: str | None = None,
) -> Any:
    """Prepend newly activated pack bodies to a tool result (once per pack per session)."""
    _ensure_builtin_packs_loaded()
    packs = packs_for_tool(tool_name, relative_path=relative_path)
    if not packs:
        return tool_result

    injections: list[str] = []
    for pack in packs:
        if mark_pack_activated(session, pack.id):
            injections.append(format_pack_injection(pack))

    if not injections:
        return tool_result

    prefix = ''.join(injections)
    if isinstance(tool_result, str):
        return prefix + tool_result
    return prefix + _stringify_content(tool_result)
