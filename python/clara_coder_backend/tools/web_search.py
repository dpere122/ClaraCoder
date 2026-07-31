"""Search the web via a user-configured SearXNG instance."""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from langchain_core.tools import tool

from clara_coder_backend.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.http_guards import normalize_http_base_url
from clara_coder_backend.tools.tool_conventions import describe
from clara_coder_backend.tools.workspace import truncate_text_head_tail

WEB_SEARCH_NAME = 'web_search'

_REQUEST_TIMEOUT_SEC = 25.0
_MAX_OUTPUT_CHARS = 80_000
_MAX_QUERY_LEN = 512
_MAX_LIMIT = 20
_DEFAULT_LIMIT = 8

__all__ = [
    'WEB_SEARCH_NAME',
    'format_searxng_search_report',
    'search_searxng',
    'web_search_tool',
]


def _web_access_gate() -> str | None:
    if not getattr(runtime_config.tools, 'allow_web_access', False):
        return (
            'Tool error: web access is disabled. Enable **Allow web access** in Settings → Tools, '
            'then try again.'
        )
    return None


def _searxng_base() -> tuple[str | None, str | None]:
    base = normalize_http_base_url(getattr(runtime_config.tools, 'searxng_base_url', '') or '')
    if not base:
        return None, (
            'Tool error: SearXNG base URL is not configured. Set **SearXNG base URL** in '
            'Settings → Tools (e.g. `http://127.0.0.1:8080`).'
        )
    return base, None


def _normalize_limit(limit: int) -> tuple[int | None, str | None]:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return None, 'Tool error: `limit` must be an integer.'
    if value < 1:
        return None, 'Tool error: `limit` must be at least 1.'
    if value > _MAX_LIMIT:
        return None, f'Tool error: `limit` must be at most {_MAX_LIMIT}.'
    return value, None


def search_searxng(query: str, *, base_url: str, limit: int = _DEFAULT_LIMIT) -> list[dict[str, Any]]:
    """Call SearXNG JSON API and return normalized result rows."""

    params = urllib.parse.urlencode({'q': query, 'format': 'json'})
    url = f'{base_url.rstrip("/")}/search?{params}'
    req = urllib.request.Request(
        url,
        headers={
            'Accept': 'application/json',
            'User-Agent': 'nemo-wrapper-searxng-tool',
        },
    )
    with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_SEC) as resp:
        raw = resp.read()
    data = json.loads(raw.decode('utf-8'))
    results = data.get('results') if isinstance(data, dict) else None
    if not isinstance(results, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in results[:limit]:
        if not isinstance(item, dict):
            continue
        title = str(item.get('title') or '').strip()
        href = str(item.get('url') or item.get('href') or '').strip()
        content = str(item.get('content') or item.get('snippet') or '').strip()
        engine = str(item.get('engine') or '').strip()
        if not title and not href:
            continue
        rows.append({'title': title, 'url': href, 'content': content, 'engine': engine})
    return rows


def format_searxng_search_report(*, query: str, rows: list[dict[str, Any]]) -> str:
    lines: list[str] = [
        'Web search results (SearXNG):',
        '',
        f'Query: `{query}`',
    ]
    if not rows:
        lines.append('- Matches: none')
    else:
        lines.append(f'- Matches: {len(rows)}')
        lines.append('')
        for index, row in enumerate(rows, start=1):
            title = str(row.get('title') or '').strip() or '(untitled)'
            href = str(row.get('url') or '').strip()
            content = str(row.get('content') or '').strip()
            if len(content) > 400:
                content = content[:397] + '…'
            engine = str(row.get('engine') or '').strip()
            lines.append(f'{index}. {title}')
            if href:
                lines.append(f'   URL: {href}')
            if content:
                lines.append(f'   {content}')
            if engine:
                lines.append(f'   Engine: `{engine}`')
            lines.append('')
    lines.append('Use `fetch_url` to read a specific result page when needed.')
    body = '\n'.join(lines).rstrip() + '\n'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


@tool(
    WEB_SEARCH_NAME,
    description=describe(
        'Search the web via the configured SearXNG instance.',
        when='you need current docs, APIs, errors, or package info from the public web.',
        not_='reading a known URL (use `fetch_url`); workspace search.',
        shape='`query` required; optional `limit` (1–20). Requires Allow web access + SearXNG base URL in Settings.',
    ),
)
async def web_search_tool(query: str, limit: int = _DEFAULT_LIMIT) -> str:
    gate = _web_access_gate()
    if gate:
        return gate

    q = str(query or '').strip()
    if not q:
        return 'Tool error: `query` must not be empty.'
    if len(q) > _MAX_QUERY_LEN:
        return f'Tool error: `query` must be at most {_MAX_QUERY_LEN} characters.'
    if re.search(r'[\x00-\x1f\x7f]', q):
        return 'Tool error: `query` contains control characters.'

    limit_value, limit_err = _normalize_limit(limit)
    if limit_err:
        return limit_err
    assert limit_value is not None

    base, base_err = _searxng_base()
    if base_err:
        return base_err
    assert base is not None

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)

    from clara_coder_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=WEB_SEARCH_NAME,
        tool_input={'query': q, 'limit': limit_value},
    )
    if pending:
        return pending

    try:
        rows = await asyncio.to_thread(search_searxng, q, base_url=base, limit=limit_value)
    except urllib.error.HTTPError as exc:
        return f'Tool error: SearXNG HTTP {exc.code} ({exc.reason}).'
    except urllib.error.URLError as exc:
        return f'Tool error: could not reach SearXNG ({exc.reason}).'
    except TimeoutError:
        return 'Tool error: SearXNG request timed out.'
    except json.JSONDecodeError:
        return 'Tool error: SearXNG returned invalid JSON.'

    return format_searxng_search_report(query=q, rows=rows)
