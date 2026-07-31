"""Fetch a public http(s) URL and return truncated text content."""

from __future__ import annotations

import asyncio
import re
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.http_guards import assert_public_http_url
from clara_coder_backend.tools.tool_conventions import describe
from clara_coder_backend.tools.workspace import truncate_text_head_tail

FETCH_URL_NAME = 'fetch_url'

_REQUEST_TIMEOUT_SEC = 25.0
_MAX_BYTES = 1_000_000
_MAX_OUTPUT_CHARS = 80_000

__all__ = [
    'FETCH_URL_NAME',
    'fetch_http_url_text',
    'fetch_url_tool',
    'html_to_text',
]


def _web_access_gate() -> str | None:
    if not getattr(runtime_config.tools, 'allow_web_access', False):
        return (
            'Tool error: web access is disabled. Enable **Allow web access** in Settings → Tools, '
            'then try again.'
        )
    return None


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in ('script', 'style', 'noscript'):
            self._skip_depth += 1
        elif tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._chunks.append('\n')

    def handle_endtag(self, tag: str) -> None:
        if tag in ('script', 'style', 'noscript') and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._chunks.append('\n')

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data:
            self._chunks.append(data)

    def text(self) -> str:
        raw = ''.join(self._chunks)
        raw = re.sub(r'[ \t]+\n', '\n', raw)
        raw = re.sub(r'\n{3,}', '\n\n', raw)
        raw = re.sub(r'[ \t]{2,}', ' ', raw)
        return raw.strip()


def html_to_text(html: str) -> str:
    parser = _HTMLTextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        # Fall back to crude tag strip on malformed markup.
        return re.sub(r'<[^>]+>', ' ', html)
    return parser.text()


def fetch_http_url_text(url: str) -> tuple[str | None, str | None]:
    """Fetch ``url`` and return ``(text, error)``. One of the two is set."""

    err = assert_public_http_url(url)
    if err:
        return None, err

    req = urllib.request.Request(
        url.strip(),
        headers={
            'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
            'User-Agent': 'nemo-wrapper-fetch-url-tool',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_SEC) as resp:
            content_type = str(resp.headers.get('Content-Type') or '').lower()
            raw = resp.read(_MAX_BYTES + 1)
            final_url = str(resp.geturl() or url)
    except urllib.error.HTTPError as exc:
        return None, f'Tool error: HTTP {exc.code} ({exc.reason}).'
    except urllib.error.URLError as exc:
        return None, f'Tool error: could not fetch URL ({exc.reason}).'
    except TimeoutError:
        return None, 'Tool error: fetch timed out.'

    # Re-check final URL after redirects.
    redirect_err = assert_public_http_url(final_url)
    if redirect_err:
        return None, 'Tool error: redirect target is not a public http(s) URL (blocked).'

    truncated = len(raw) > _MAX_BYTES
    if truncated:
        raw = raw[:_MAX_BYTES]

    if 'charset=' in content_type:
        charset = content_type.split('charset=', 1)[1].split(';', 1)[0].strip().strip('"\'')
    else:
        charset = 'utf-8'
    try:
        text = raw.decode(charset or 'utf-8', errors='replace')
    except LookupError:
        text = raw.decode('utf-8', errors='replace')

    # Reject obvious binary
    if '\x00' in text[:4096]:
        return None, 'Tool error: response looks binary; only text/HTML/JSON are supported.'

    if 'html' in content_type or text.lstrip().lower().startswith(('<!doctype', '<html')):
        body = html_to_text(text)
    else:
        body = text.strip()

    header = f'Fetched: {final_url}'
    if truncated:
        header += f' (truncated to {_MAX_BYTES} bytes)'
    report = f'{header}\n\n{body}\n'
    if len(report) > _MAX_OUTPUT_CHARS:
        report = truncate_text_head_tail(report, _MAX_OUTPUT_CHARS)
    return report, None


@tool(
    FETCH_URL_NAME,
    description=describe(
        'Fetch a public http(s) URL and return truncated page text.',
        when='reading docs or pages after `web_search`, or when you already have a URL.',
        not_='private/local hosts; binary downloads; JS-rendered SPAs.',
        shape='`url` required. Requires Allow web access in Settings. Blocks non-public addresses.',
    ),
)
async def fetch_url_tool(
    url: Annotated[str, 'absolute http(s) URL to fetch'],
) -> str:
    gate = _web_access_gate()
    if gate:
        return gate

    target = str(url or '').strip()
    if not target:
        return 'Tool error: `url` must not be empty.'

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)

    from clara_coder_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=FETCH_URL_NAME,
        tool_input={'url': target},
    )
    if pending:
        return pending

    text, err = await asyncio.to_thread(fetch_http_url_text, target)
    if err:
        return err
    assert text is not None
    return text
