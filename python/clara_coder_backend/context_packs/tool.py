"""LangChain tool for explicit context-pack activation."""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.context_packs.activation import activate_pack
from clara_coder_backend.tools.tool_conventions import describe

ACTIVATE_CONTEXT_NAME = 'activate_context'


@tool(
    ACTIVATE_CONTEXT_NAME,
    description=describe(
        'Load a deferred context pack (workflow playbook) into this turn.',
        when=(
            'you need pack knowledge before related tools, or a non-tool pack has no auto trigger. '
            'Packs also auto-activate on first matching tool use.'
        ),
        not_='re-reading tool schemas (bound tools already describe args).',
        shape='`pack_id` e.g. pdf|wsdl|xml|json. Unknown ids list available packs.',
    ),
)
def activate_context(pack_id: Annotated[str, 'context pack id from the system catalog']) -> str:
    from clara_coder_backend.session.state import current_session_id, get_session

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool note: no active session; cannot activate a context pack.'
    return activate_pack(get_session(sid), pack_id)


ACTIVATE_CONTEXT_TOOLS = [activate_context]
