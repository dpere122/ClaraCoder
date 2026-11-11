"""Search the web via the built-in metasearch backend or a user-configured SearXNG instance."""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from langchain_core.tools import tool

from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.http_guards import normalize_http_base_url
from clara_coder_backend.tools.metasearch import (
    DEFAULT_USER_AGENT,
    ENGINE_NAMES,
    MetasearchOutcome,
    metasearch,
)
from clara_coder_backend.tools.metasearch.cache import get_cached, put_cached
from clara_coder_backend.tools.redact import redact_emails
from clara_coder_backend.tools.tool_conventions import describe
from clara_coder_backend.tools.workspace import truncate_text_head_tail

WEB_SEARCH_NAME = 'web_search'

_REQUEST_TIMEOUT_SEC = 25.0
_MAX_OUTPUT_CHARS = 80_000
_MAX_QUERY_LEN = 512
_MAX_LIMIT = 20
_DEFAULT_LIMIT = 8

#: ``auto`` — SearXNG when a base URL is set, else the built-in engine.
#: ``internal`` — always the built-in metasearch backend.
#: ``searxng`` — always the configured SearXNG instance.
_PROVIDERS = ('auto', 'internal', 'searxng')

_MAX_USER_AGENT_LEN = 512
_DEFAULT_COOLDOWN_SEC = 300.0
_MAX_COOLDOWN_SEC = 3600.0

__all__ = [
    'WEB_SEARCH_NAME',
    'format_search_report',
    'format_searxng_search_report',
    'outbound_user_agent',
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
            'Settings → Tools (e.g. `http://127.0.0.1:8080`), or set **Web search provider** to '
            '**Built-in**.'
        )
    return base, None


def _provider() -> str:
    raw = str(getattr(runtime_config.tools, 'web_search_provider', 'auto') or 'auto').strip().lower()
    return raw if raw in _PROVIDERS else 'auto'


def _resolve_provider() -> tuple[str | None, str | None]:
    """Return ``('internal' | 'searxng', None)``, or ``(None, error)`` when misconfigured."""

    provider = _provider()
    if provider == 'internal':
        return 'internal', None
    if provider == 'searxng':
        base, err = _searxng_base()
        return (None, err) if err else ('searxng', None)
    # auto: prefer an explicitly configured instance, otherwise use the built-in engine.
    base = normalize_http_base_url(getattr(runtime_config.tools, 'searxng_base_url', '') or '')
    return ('searxng', None) if base else ('internal', None)


def _enabled_engines() -> tuple[str, ...]:
    """Configured built-in engines, filtered to known names; empty means every engine."""

    raw = getattr(runtime_config.tools, 'web_search_engines', None) or []
    wanted = {str(name).strip().lower() for name in raw if isinstance(name, str)}
    selected = tuple(name for name in ENGINE_NAMES if name in wanted)
    return selected or ENGINE_NAMES


def outbound_user_agent() -> str:
    """User-Agent sent with built-in engine requests: the configured one, or the default.

    Also read by the accept-command card, so the user sees the exact header before
    approving a search.
    """

    raw = str(getattr(runtime_config.tools, 'web_search_user_agent', '') or '').strip()
    if not raw or len(raw) > _MAX_USER_AGENT_LEN or re.search(r'[\x00-\x1f\x7f]', raw):
        return DEFAULT_USER_AGENT
    return raw


def _cooldown_seconds() -> float:
    """How long a blocked engine is parked; ``0`` disables cooldowns entirely."""

    try:
        value = float(getattr(runtime_config.tools, 'web_search_cooldown_seconds', _DEFAULT_COOLDOWN_SEC))
    except (TypeError, ValueError):
        return _DEFAULT_COOLDOWN_SEC
    return min(max(value, 0.0), _MAX_COOLDOWN_SEC)


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


def format_search_report(
    *,
    query: str,
    rows: list[dict[str, Any]],
    source: str = 'SearXNG',
    engines_ok: list[str] | None = None,
    engines_failed: dict[str, str] | None = None,
    engines_skipped: dict[str, float] | None = None,
    degraded: bool = False,
    redacted_count: int = 0,
) -> str:
    lines: list[str] = [
        f'Web search results ({source}):',
        '',
        f'Query: `{query}`',
    ]
    if engines_ok:
        lines.append(f'- Engines: {", ".join(engines_ok)}')
    if engines_failed:
        lines.append(f'- Unavailable: {", ".join(sorted(engines_failed))}')
    if engines_skipped:
        cooling = ', '.join(
            f'{name} ({int(seconds)}s)' for name, seconds in sorted(engines_skipped.items())
        )
        lines.append(f'- Cooling down: {cooling}')
    if degraded:
        lines.append('- Note: every engine was cooling down; retried them anyway.')
    if redacted_count:
        lines.append(f'- Email addresses redacted from the query: {redacted_count}')
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


def format_searxng_search_report(*, query: str, rows: list[dict[str, Any]]) -> str:
    return format_search_report(query=query, rows=rows, source='SearXNG')


async def _internal_search(query: str, limit: int, redacted_count: int = 0) -> str:
    engines = _enabled_engines()
    user_agent = outbound_user_agent()
    cooldown = _cooldown_seconds()
    key = ('internal', query.strip().lower(), limit, engines, user_agent)
    outcome: MetasearchOutcome | None = get_cached(key)
    if outcome is None:
        try:
            outcome = await asyncio.to_thread(
                metasearch,
                query,
                limit=limit,
                engines=engines,
                user_agent=user_agent,
                cooldown_seconds=cooldown,
            )
        except Exception as exc:  # noqa: BLE001 - surface a tool error, never a traceback
            return f'Tool error: built-in search failed ({exc.__class__.__name__}).'
        put_cached(key, outcome)

    if not outcome.rows and outcome.engines_failed and not outcome.engines_ok:
        detail = '; '.join(f'{name}: {err}' for name, err in sorted(outcome.engines_failed.items()))
        if outcome.engines_skipped:
            cooling = ', '.join(
                f'{name} ({int(seconds)}s)' for name, seconds in sorted(outcome.engines_skipped.items())
            )
            detail += f'; cooling down: {cooling}'
        return f'Tool error: every built-in search engine failed ({detail}).'

    return format_search_report(
        query=query,
        rows=outcome.rows,
        source='built-in',
        engines_ok=outcome.engines_ok,
        engines_failed=outcome.engines_failed,
        engines_skipped=outcome.engines_skipped,
        degraded=outcome.degraded,
        redacted_count=redacted_count,
    )


@tool(
    WEB_SEARCH_NAME,
    description=describe(
        'Search the web with the built-in metasearch engine or a configured SearXNG instance.',
        when='you need current docs, APIs, errors, or package info from the public web.',
        not_='reading a known URL (use `fetch_url`); workspace search.',
        shape=(
            '`query` required; optional `limit` (1–20). Requires Allow web access in Settings. '
            'Email addresses in `query` are redacted before sending.'
        ),
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

    provider, provider_err = _resolve_provider()
    if provider_err:
        return provider_err
    assert provider is not None

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)

    from clara_coder_backend.tools.deferred_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=WEB_SEARCH_NAME,
        tool_input={'query': q, 'limit': limit_value},
    )
    if pending:
        return pending

    # Redact after the approval card: the card shows what will actually be sent, and
    # the request itself never carries an address the model put in the query.
    q, redacted_count = redact_emails(q)

    if provider == 'internal':
        return await _internal_search(q, limit_value, redacted_count)

    base, base_err = _searxng_base()
    if base_err:
        return base_err
    assert base is not None

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

    return format_search_report(query=q, rows=rows, source='SearXNG', redacted_count=redacted_count)
