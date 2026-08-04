"""Queue and drain user/system event notes for injection into the agent."""

from __future__ import annotations

from clara_coder_backend.domain import SessionState


def queue_user_event_note(session: SessionState, note: str) -> None:
    """Append one note to be injected as a HumanMessage on the next model call."""
    cleaned = (note or '').strip()
    if cleaned:
        session.pending_user_event_notes.append(cleaned)


def drain_user_event_notes(session: SessionState) -> list[str]:
    """Remove and return all queued user event notes (FIFO)."""
    if not session.pending_user_event_notes:
        return []
    notes = list(session.pending_user_event_notes)
    session.pending_user_event_notes.clear()
    return notes
