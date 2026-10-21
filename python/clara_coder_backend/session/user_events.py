"""Queue and drain user/system event notes for injection into the agent."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import SessionState

#: Ends the saved reply of an agent turn the user stopped or interrupted (session history).
INTERRUPTED_TURN_MARKER = '[Interrupted by the user]'

#: Saved reply of a message a newer one replaced before its turn started.
SUPERSEDED_TURN_MARKER = '[Superseded before a reply]'

#: Longest excerpt of the interrupted request quoted back in the note.
_REQUEST_EXCERPT_CHARS = 300
#: Longest excerpt of the cut-off reply text quoted back in the note.
_UNSAVED_TEXT_CHARS = 1_500


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


def _excerpt(content: str | list[dict[str, Any]], limit: int) -> str:
    from clara_coder_backend.llm.messages import stringify_content

    text = ' '.join(stringify_content(content).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + '…'


def queue_interrupted_turn_note(
    session: SessionState,
    user_message: str | list[dict[str, Any]],
    unsaved_text: str = '',
) -> None:
    """Tell the next turn that the previous one was stopped before it finished.

    ``unsaved_text`` is what the model was streaming when it stopped: no checkpoint holds it, so it is
    quoted back (truncated). Work that already ran (edits on disk, commands) is not undone.
    """
    request = _excerpt(user_message, _REQUEST_EXCERPT_CHARS)
    parts = [
        'Your previous reply was interrupted by the user before it finished'
        + (f' (their request: "{request}").' if request else '.')
    ]
    unsaved = (unsaved_text or '').strip()
    if unsaved:
        if len(unsaved) > _UNSAVED_TEXT_CHARS:
            unsaved = unsaved[: _UNSAVED_TEXT_CHARS - 1].rstrip() + '…'
        parts.append(f'You were in the middle of writing:\n"""\n{unsaved}\n"""')
    parts.append(
        'Edits already on disk and commands that already ran remain; check the current state before '
        'redoing work, and answer the message below.'
    )
    queue_user_event_note(session, '\n'.join(parts))


def record_superseded_turn(session: SessionState, user_message: str | list[dict[str, Any]]) -> None:
    """Keep a message whose turn never started because a newer message replaced it.

    History gets the message with a marker reply, and the next turn a note quoting it.
    """
    session.history.append({'role': 'user', 'content': user_message})
    session.history.append({'role': 'assistant', 'content': SUPERSEDED_TURN_MARKER})
    request = _excerpt(user_message, _REQUEST_EXCERPT_CHARS)
    if request:
        queue_user_event_note(
            session,
            f'The user also sent this message before you could reply to it: "{request}". '
            'Take it into account with the message below.',
        )
