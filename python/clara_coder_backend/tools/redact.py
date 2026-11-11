"""Strip personal data from text that is about to leave the machine.

The agent composes search queries, and a model that has seen the user's address
in the conversation can put it in a query. Search engines log queries, so the
address is removed before the request is built rather than trusted to stay out.
"""

from __future__ import annotations

import re

__all__ = ['EMAIL_PLACEHOLDER', 'redact_emails']

#: What an address is replaced with; kept visible so the model can see it was dropped.
EMAIL_PLACEHOLDER = '[email redacted]'

_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')


def redact_emails(text: str) -> tuple[str, int]:
    """Replace every email address in ``text``; return ``(redacted, count)``."""

    if not text:
        return text, 0
    redacted, count = _EMAIL_RE.subn(EMAIL_PLACEHOLDER, text)
    return redacted, count
