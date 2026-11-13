"""The ``agent_nudge`` stream event: a finish gate sent the model's answer back with more work to do.

Edit verification and the plan's pending-steps check use it. The UI folds the prose the model had
streamed as its answer into a preview, because the turn goes on.
"""

from __future__ import annotations

from clara_coder_backend.session.state import current_session_id, get_session


async def emit_agent_nudge_event(*, reason: str) -> None:
    """Queue an SSE promote so the UI folds live primary prose into a nudge preview."""
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return
    session = get_session(sid)
    queue = session.hitl_sse_queue
    if queue is None:
        return
    await queue.put(('agent_nudge', {'reason': reason}))
