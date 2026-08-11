"""Shared HTTP URL validation helpers for outbound agent tools (SSRF-oriented)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

__all__ = [
    'assert_public_http_url',
    'normalize_http_base_url',
    'resolve_public_http_url',
]


def normalize_http_base_url(raw: str) -> str:
    """Return a trimmed base URL without a trailing slash, or empty string if invalid scheme."""

    base = str(raw or '').strip().rstrip('/')
    if not base:
        return ''
    parsed = urlparse(base)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return ''
    return base


def resolve_public_http_url(url: str) -> tuple[str | None, str | None]:
    """Validate ``url`` and return a pinned public IP literal for the connection.

    Returns ``(ip_literal, None)`` when allowed, or ``(None, error_message)`` when blocked.
    Callers should open the TCP connection to ``ip_literal`` (with the original Host header)
    so a DNS rebind between check and connect cannot point at a private address.
    """

    text = str(url or '').strip()
    if not text:
        return None, 'Tool error: `url` must not be empty.'
    if len(text) > 2048:
        return None, 'Tool error: `url` is too long (max 2048 characters).'
    parsed = urlparse(text)
    if parsed.scheme not in ('http', 'https'):
        return None, 'Tool error: `url` must use http or https.'
    host = (parsed.hostname or '').strip()
    if not host:
        return None, 'Tool error: `url` is missing a host.'
    if parsed.username or parsed.password:
        return None, 'Tool error: `url` must not include credentials.'

    # Literal IP in the URL
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not literal.is_global:
            return None, 'Tool error: `url` host resolves to a non-public address (blocked).'
        return str(literal), None

    # Hostname → resolve all addresses; pin to the first public one after validating all.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        return None, f'Tool error: could not resolve host `{host}`.'
    if not infos:
        return None, f'Tool error: could not resolve host `{host}`.'

    pinned: str | None = None
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip_text = sockaddr[0]
        try:
            addr = ipaddress.ip_address(ip_text)
        except ValueError:
            continue
        if not addr.is_global:
            return None, 'Tool error: `url` host resolves to a non-public address (blocked).'
        if pinned is None:
            pinned = str(addr)
    if pinned is None:
        return None, f'Tool error: could not resolve host `{host}`.'
    return pinned, None


def assert_public_http_url(url: str) -> str | None:
    """Validate ``url`` for fetch tools. Return an error message, or ``None`` if allowed.

    Blocks non-http(s), missing host, and hosts that resolve to loopback / private /
    link-local / multicast / reserved addresses (SSRF).
    """

    _pinned, err = resolve_public_http_url(url)
    return err
