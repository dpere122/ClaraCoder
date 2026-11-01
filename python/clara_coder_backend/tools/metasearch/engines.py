"""Search-engine adapters for the built-in metasearch backend.

Each adapter turns one engine's public HTML/JSON endpoint into normalized
``RawResult`` rows. Adapters are deliberately small and defensive: markup changes
should degrade one engine, never the whole search.

An engine that answers with a rate limit, a 403, or a captcha page raises
:class:`EngineBlocked` so the aggregator can park it for a while instead of
retrying it on the next query.
"""

from __future__ import annotations

import base64
import binascii
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

from clara_coder_backend.tools.http_guards import assert_public_http_url
from clara_coder_backend.tools.metasearch.dom import find_all, find_first, parse_html, text_of

__all__ = [
    'DEFAULT_USER_AGENT',
    'ENGINE_NAMES',
    'ENGINES',
    'EngineBlocked',
    'RawResult',
    'run_engine',
]

_REQUEST_TIMEOUT_SEC = 12.0
_MAX_BYTES = 2_000_000

#: A browser-like UA: the HTML endpoints serve bot UAs a challenge page instead of results.
DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
)

#: Status codes that mean "stop asking for a while" rather than "this query failed".
_BLOCK_STATUS = frozenset({403, 429, 503})

#: Structural markers of a captcha / challenge interstitial. Deliberately narrow:
#: a phrase like "unusual traffic" also appears in ordinary result snippets.
_BLOCK_MARKERS = (
    'anomaly-modal',
    'challenge-form',
    'g-recaptcha',
    'h-captcha',
    'id="captcha"',
    'name="captcha"',
)


class EngineBlocked(Exception):
    """Raised when an engine refuses the request (rate limit, challenge page, 403)."""

    def __init__(self, engine: str, reason: str, retry_after: float | None = None) -> None:
        super().__init__(reason)
        self.engine = engine
        self.reason = reason
        self.retry_after = retry_after


@dataclass(frozen=True)
class RawResult:
    """One engine's unranked hit."""

    title: str
    url: str
    snippet: str = ''


class _PublicOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validate every redirect hop before following it (same policy as ``fetch_url``)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D401
        if assert_public_http_url(newurl):
            raise urllib.error.URLError('redirect target is not a public http(s) URL (blocked)')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_PublicOnlyRedirectHandler)


def _retry_after_seconds(headers) -> float | None:  # noqa: ANN001
    raw = headers.get('Retry-After') if headers is not None else None
    if not raw:
        return None
    try:
        return max(0.0, float(str(raw).strip()))
    except ValueError:
        return None


def _http_get(url: str, *, accept: str, user_agent: str, engine: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            'Accept': accept,
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': user_agent,
        },
    )
    try:
        with _OPENER.open(req, timeout=_REQUEST_TIMEOUT_SEC) as resp:
            raw = resp.read(_MAX_BYTES)
    except urllib.error.HTTPError as exc:
        if exc.code in _BLOCK_STATUS:
            raise EngineBlocked(
                engine,
                f'HTTP {exc.code}',
                retry_after=_retry_after_seconds(exc.headers),
            ) from exc
        raise

    body = raw.decode('utf-8', errors='replace')
    lowered = body.lower()
    for marker in _BLOCK_MARKERS:
        if marker in lowered:
            raise EngineBlocked(engine, f'challenge page ({marker})')
    return body


def _strip_tags(markup: str) -> str:
    return text_of(parse_html(markup))


def _unwrap_duckduckgo(href: str) -> str:
    """DuckDuckGo wraps outbound links as ``//duckduckgo.com/l/?uddg=<encoded>``."""

    text = str(href or '').strip()
    if text.startswith('//'):
        text = 'https:' + text
    parsed = urllib.parse.urlsplit(text)
    if parsed.netloc.endswith('duckduckgo.com') and parsed.path.startswith('/l/'):
        target = urllib.parse.parse_qs(parsed.query).get('uddg')
        if target:
            return target[0]
    return text


def _unwrap_bing(href: str) -> str:
    """Bing wraps outbound links as ``/ck/a?...&u=a1<base64url>``."""

    text = str(href or '').strip()
    parsed = urllib.parse.urlsplit(text)
    if not parsed.netloc.endswith('bing.com') or not parsed.path.startswith('/ck/a'):
        return text
    raw = urllib.parse.parse_qs(parsed.query).get('u')
    if not raw or not raw[0].startswith('a1'):
        return text
    payload = raw[0][2:]
    try:
        decoded = base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)).decode(
            'utf-8', errors='replace'
        )
    except (ValueError, binascii.Error):
        return text
    return decoded if decoded.startswith(('http://', 'https://')) else text


def _search_duckduckgo(query: str, limit: int, user_agent: str) -> list[RawResult]:
    url = 'https://html.duckduckgo.com/html/?' + urllib.parse.urlencode({'q': query})
    root = parse_html(
        _http_get(url, accept='text/html,application/xhtml+xml', user_agent=user_agent, engine='duckduckgo')
    )
    results: list[RawResult] = []
    for block in find_all(root, class_='result'):
        anchor = find_first(block, tag='a', class_='result__a')
        if anchor is None:
            continue
        href = _unwrap_duckduckgo(anchor.get('href'))
        title = text_of(anchor)
        if not href or not title:
            continue
        snippet_node = find_first(block, class_='result__snippet')
        results.append(
            RawResult(
                title=title,
                url=href,
                snippet=text_of(snippet_node) if snippet_node is not None else '',
            )
        )
        if len(results) >= limit:
            break
    return results


def _search_bing(query: str, limit: int, user_agent: str) -> list[RawResult]:
    params = {'q': query, 'count': str(max(limit * 2, 10)), 'setlang': 'en'}
    url = 'https://www.bing.com/search?' + urllib.parse.urlencode(params)
    root = parse_html(
        _http_get(url, accept='text/html,application/xhtml+xml', user_agent=user_agent, engine='bing')
    )
    results: list[RawResult] = []
    for block in find_all(root, tag='li', class_='b_algo'):
        heading = find_first(block, tag='h2')
        anchor = find_first(heading, tag='a') if heading is not None else find_first(block, tag='a')
        if anchor is None:
            continue
        href = _unwrap_bing(anchor.get('href'))
        title = text_of(anchor)
        if not href or not title:
            continue
        snippet_node = find_first(block, tag='p')
        results.append(
            RawResult(
                title=title,
                url=href,
                snippet=text_of(snippet_node) if snippet_node is not None else '',
            )
        )
        if len(results) >= limit:
            break
    return results


def _search_mojeek(query: str, limit: int, user_agent: str) -> list[RawResult]:
    url = 'https://www.mojeek.com/search?' + urllib.parse.urlencode({'q': query})
    root = parse_html(
        _http_get(url, accept='text/html,application/xhtml+xml', user_agent=user_agent, engine='mojeek')
    )
    container = find_first(root, tag='ul', class_='results-standard')
    scope = container if container is not None else root
    results: list[RawResult] = []
    for block in find_all(scope, tag='li'):
        anchor = find_first(block, tag='a', class_='ob')
        if anchor is None:
            heading = find_first(block, tag='h2')
            anchor = find_first(heading, tag='a') if heading is not None else None
        if anchor is None:
            continue
        href = anchor.get('href')
        title = text_of(anchor)
        if not href or not title:
            continue
        snippet_node = find_first(block, tag='p', class_='s')
        results.append(
            RawResult(
                title=title,
                url=href,
                snippet=text_of(snippet_node) if snippet_node is not None else '',
            )
        )
        if len(results) >= limit:
            break
    return results


def _search_wikipedia(query: str, limit: int, user_agent: str) -> list[RawResult]:
    params = {
        'action': 'query',
        'list': 'search',
        'srsearch': query,
        'srlimit': str(limit),
        'format': 'json',
        'utf8': '1',
    }
    url = 'https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode(params)
    payload = json.loads(
        _http_get(url, accept='application/json', user_agent=user_agent, engine='wikipedia')
    )
    if not isinstance(payload, dict):
        return []
    query_block = payload.get('query')
    if not isinstance(query_block, dict):
        return []
    hits = query_block.get('search')
    if not isinstance(hits, list):
        return []
    results: list[RawResult] = []
    for item in hits[:limit]:
        if not isinstance(item, dict):
            continue
        title = str(item.get('title') or '').strip()
        if not title:
            continue
        pageid = item.get('pageid')
        if pageid:
            href = f'https://en.wikipedia.org/?curid={pageid}'
        else:
            href = 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))
        results.append(
            RawResult(
                title=title,
                url=href,
                snippet=_strip_tags(str(item.get('snippet') or '')),
            )
        )
    return results


ENGINES: dict[str, Callable[[str, int, str], list[RawResult]]] = {
    'duckduckgo': _search_duckduckgo,
    'bing': _search_bing,
    'mojeek': _search_mojeek,
    'wikipedia': _search_wikipedia,
}

ENGINE_NAMES: tuple[str, ...] = tuple(ENGINES)


def run_engine(
    name: str,
    query: str,
    limit: int,
    user_agent: str = DEFAULT_USER_AGENT,
) -> list[RawResult]:
    """Run one engine by name; raises ``KeyError`` for an unknown engine."""

    engine = ENGINES.get(name)
    if engine is None:
        raise KeyError(f'unknown search engine `{name}`')
    return engine(query, limit, user_agent)
