"""Capture public pages/images through Electron's isolated screenshot broker."""

from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Annotated, Any

from langchain_core.tools import tool
from pydantic import Field

from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.http_guards import assert_public_http_url
from clara_coder_backend.tools.redact import redact_emails
from clara_coder_backend.tools.tool_conventions import describe
from clara_coder_backend.tools.web_search import outbound_user_agent

SCREENSHOT_WEBPAGE_NAME = 'screenshot_webpage'

_REQUEST_TIMEOUT_SEC = 40.0
_MAX_RESPONSE_BYTES = 16 * 1024
_MAX_DIMENSION = 4096
_MAX_DECODE_PASSES = 16
_ASSET_URL_RE = re.compile(r'nemo-asset://capture/[0-9a-f]{32}\.png')
_BROKER_URL_RE = re.compile(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/capture')
_CONTROLS_RE = re.compile(r'[\x00-\x1f\x7f-\x9f]')

__all__ = ['SCREENSHOT_WEBPAGE_NAME', 'screenshot_user_agent', 'screenshot_webpage_tool']


def _url_syntax_error(url: str) -> str | None:
    """Reject unsafe syntax/privacy without resolving a host or changing the URL."""

    if not url:
        return 'Tool error: `url` must not be empty.'
    if len(url) > 2048:
        return 'Tool error: `url` is too long (max 2048 characters).'
    if any(char.isspace() for char in url):
        return 'Tool error: `url` must not contain whitespace.'
    decoded = url
    for _ in range(_MAX_DECODE_PASSES):
        if _CONTROLS_RE.search(decoded) or '\\' in decoded:
            return 'Tool error: `url` contains unsafe control characters or backslashes.'
        try:
            decoded.encode('utf-8')
            parsed = urllib.parse.urlsplit(decoded)
            if parsed.scheme not in ('http', 'https'):
                return 'Tool error: `url` must use http or https.'
            if not parsed.hostname or any(char.isspace() for char in parsed.netloc):
                return 'Tool error: `url` is missing a valid host.'
            parsed.hostname.encode('idna')
            if parsed.username is not None or parsed.password is not None:
                return 'Tool error: `url` must not include credentials.'
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                return 'Tool error: `url` has an invalid port.'
        except ValueError:
            return 'Tool error: `url` is not a valid http(s) URL.'
        if redact_emails(decoded)[1]:
            return 'Tool error: `url` must not contain email addresses (including percent-encoded addresses).'
        unquoted = urllib.parse.unquote(decoded)
        if unquoted == decoded:
            return None
        decoded = unquoted
    return 'Tool error: `url` has too many layers of percent encoding.'


def screenshot_user_agent() -> tuple[str | None, str | None]:
    """Use the shared configured UA, but fail closed on unsafe/private headers."""

    raw = str(getattr(runtime_config.tools, 'web_search_user_agent', '') or '')
    user_agent = outbound_user_agent()
    for value in (raw, user_agent):
        if _CONTROLS_RE.search(value):
            return None, 'Tool error: screenshot User-Agent must not contain control characters.'
        try:
            value.encode('ascii')
        except UnicodeEncodeError:
            return None, 'Tool error: screenshot User-Agent must contain only printable ASCII characters.'
        decoded = value
        for _ in range(_MAX_DECODE_PASSES):
            if redact_emails(decoded)[1]:
                return None, 'Tool error: screenshot User-Agent must not contain email addresses.'
            unquoted = urllib.parse.unquote(decoded)
            if unquoted == decoded:
                break
            decoded = unquoted
        else:
            return None, 'Tool error: screenshot User-Agent has too many layers of percent encoding.'
    return user_agent, None


def _valid_dimension(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= _MAX_DIMENSION


class _NoBrokerRedirects(urllib.request.HTTPRedirectHandler):
    """Never send the broker's bearer token to a redirect destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _broker_settings() -> tuple[str, str, str | None]:
    url = os.environ.get('CLARA_SCREENSHOT_URL', '')
    token = os.environ.get('CLARA_SCREENSHOT_TOKEN', '')
    match = _BROKER_URL_RE.fullmatch(url)
    if not match or not 1 <= int(match.group(1)) <= 65535:
        return '', '', 'Tool error: screenshot broker is unavailable or its loopback URL is invalid.'
    if not token or any(not 33 <= ord(char) <= 126 for char in token):
        return '', '', 'Tool error: screenshot broker authentication is unavailable or invalid.'
    return url, token, None


def _broker_failure(payload: dict[str, Any], token: str, status: int | None) -> str:
    error = payload.get('error')
    message = error if isinstance(error, str) else 'capture failed'
    message = message.replace(token, '[redacted]')
    message = redact_emails(message)[0]
    message = ' '.join(_CONTROLS_RE.sub(' ', message).split())[:512]
    code = f' (HTTP {status})' if status is not None else ''
    return f'Tool error: screenshot broker{code}: {message or "capture failed"}.'


def _capture_webpage(url: str, width: int, height: int, user_agent: str) -> str:
    broker_url, token, error = _broker_settings()
    if error:
        return error
    error = assert_public_http_url(url)
    if error:
        return error
    request = urllib.request.Request(
        broker_url,
        data=json.dumps(
            {'url': url, 'width': width, 'height': height, 'user_agent': user_agent},
            separators=(',', ':'),
        ).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': user_agent,
        },
        method='POST',
    )
    # The only HTTP connection made here is to the exact local broker endpoint.
    # Proxy environment variables must never redirect its bearer-authenticated request.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoBrokerRedirects())
    status: int | None = None
    try:
        try:
            with opener.open(request, timeout=_REQUEST_TIMEOUT_SEC) as response:
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            status = exc.code
            with exc:
                raw = exc.read(_MAX_RESPONSE_BYTES + 1)
    except TimeoutError:
        return 'Tool error: screenshot broker timed out.'
    except (OSError, ValueError):
        return 'Tool error: screenshot broker request failed.'
    if len(raw) > _MAX_RESPONSE_BYTES:
        return 'Tool error: screenshot broker response exceeded 16 KB.'
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeError, RecursionError):
        return 'Tool error: screenshot broker returned invalid JSON.'
    if not isinstance(payload, dict):
        return 'Tool error: screenshot broker returned an invalid response.'
    if status is not None or 'error' in payload:
        return _broker_failure(payload, token, status)
    asset_url = payload.get('image_url')
    if not isinstance(asset_url, str) or not _ASSET_URL_RE.fullmatch(asset_url):
        return 'Tool error: screenshot broker returned an invalid capture asset URL.'
    final_url = payload.get('url')
    if not isinstance(final_url, str) or _url_syntax_error(final_url):
        return 'Tool error: screenshot broker returned an unsafe final URL.'
    if assert_public_http_url(final_url):
        return 'Tool error: screenshot broker returned a non-public final URL (blocked).'
    actual_width, actual_height = payload.get('width'), payload.get('height')
    if not _valid_dimension(actual_width) or not _valid_dimension(actual_height):
        return 'Tool error: screenshot broker returned invalid image dimensions.'
    return (
        f'Screenshot captured ({actual_width} × {actual_height}): {final_url}\n\n'
        f'![Webpage screenshot]({asset_url})\n\n'
        'Embed the exact Markdown image above in your reply to show the screenshot. '
        'This is a static capture, not interactive browsing.'
    )


@tool(
    SCREENSHOT_WEBPAGE_NAME,
    description=describe(
        'Capture a public webpage or direct online image as a screenshot.',
        when='showing a static page/image in your reply; embed the returned Markdown image verbatim.',
        not_='private/local URLs, logins, browser automation, or script-dependent pages.',
        shape='`url` required; optional viewport size. Requires Allow web access; Auto Run off asks first.',
    ),
)
async def screenshot_webpage_tool(
    url: Annotated[str, 'absolute public http(s) URL; no credentials or email addresses'],
    width: Annotated[int, Field(strict=True), 'viewport width in pixels, 320–1920'] = 1280,
    height: Annotated[int, Field(strict=True), 'viewport height in pixels, 240–1080'] = 800,
) -> str:
    if not getattr(runtime_config.tools, 'allow_web_access', False):
        return (
            'Tool error: web access is disabled. Enable **Allow web access** in Settings → Tools, '
            'then try again.'
        )
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    target = str(url or '')
    error = _url_syntax_error(target)
    if error:
        return error
    if (not _valid_dimension(width) or not _valid_dimension(height)
            or not 320 <= width <= 1920 or not 240 <= height <= 1080):
        return 'Tool error: viewport must be integer pixels: width 320–1920, height 240–1080.'
    user_agent, error = screenshot_user_agent()
    if error:
        return error
    assert user_agent is not None
    session = get_session(sid)

    from clara_coder_backend.tools.deferred_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=SCREENSHOT_WEBPAGE_NAME,
        tool_input={'url': target, 'width': width, 'height': height},
    )
    if pending:
        return pending
    # DNS resolution and broker I/O happen only after the deferred approval gate.
    return await asyncio.to_thread(_capture_webpage, target, width, height, user_agent)
