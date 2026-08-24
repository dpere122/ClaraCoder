"""Normalize URLs copied from server bind flags for use as HTTP client bases."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


def normalize_openai_api_base(raw: str) -> str | None:
    """Return ``api_base`` for the OpenAI SDK (``.../v1``) or ``None`` for library defaults."""
    s = (raw or '').strip()
    if not s:
        return None
    s = s.rstrip('/')
    if s.endswith('/v1'):
        return s
    return f'{s}/v1'


def normalize_bind_all_host_url(url: str) -> str:
    """Replace ``0.0.0.0`` / unspecified IPv6 with ``127.0.0.1``.

    ``llama-server --host 0.0.0.0`` listens on all interfaces; outbound requests must use a concrete host.
    Users often paste the same ``0.0.0.0`` into Settings, which breaks embeddings/chat HTTP clients.
    """
    raw = (url or '').strip()
    if not raw:
        return raw
    candidate = raw if '://' in raw else f'http://{raw}'
    try:
        parts = urlsplit(candidate)
        if parts.username or parts.password:
            return raw
        host = (parts.hostname or '').lower()
        if host not in {'0.0.0.0', '::'}:
            return raw
        port = parts.port
        netloc = f'127.0.0.1:{port}' if port else '127.0.0.1'
        return urlunsplit((parts.scheme or 'http', netloc, parts.path or '', parts.query, parts.fragment))
    except Exception:
        return raw
