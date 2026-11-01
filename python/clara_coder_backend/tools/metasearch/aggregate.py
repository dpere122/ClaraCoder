"""Fan-out, normalize, dedupe and rank results from the built-in engines.

This is the part that makes the backend behave like a metasearch engine rather than
four scrapers in a trench coat: every engine runs concurrently, hits are keyed by a
normalized URL, and the merged list is ordered by reciprocal rank fusion so a page
several engines agree on outranks a page only one engine liked.
"""

from __future__ import annotations

import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Iterable

from clara_coder_backend.tools.metasearch.engines import ENGINE_NAMES, run_engine

__all__ = ['MetasearchOutcome', 'metasearch', 'normalize_url']

#: Query parameters that only track the click, never change the page.
_TRACKING_PARAMS = frozenset(
    {
        '_hsenc',
        '_hsmi',
        'dclid',
        'fbclid',
        'gclid',
        'igshid',
        'mc_cid',
        'mc_eid',
        'msclkid',
        'ref',
        'ref_src',
        'referrer',
        'source',
        'spm',
        'yclid',
    }
)

#: Reciprocal-rank-fusion constant (the value from the original RRF paper).
_RRF_K = 60

#: Weight of the "query terms appear in the title" tie-breaker.
_TITLE_BOOST = 0.5


@dataclass
class MetasearchOutcome:
    """Merged rows plus per-engine health, so the tool can report partial failures."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    engines_ok: list[str] = field(default_factory=list)
    engines_failed: dict[str, str] = field(default_factory=dict)


def normalize_url(raw: str) -> str:
    """Return a dedupe key for ``raw``, or ``''`` when it is not a usable http(s) URL."""

    text = str(raw or '').strip()
    if not text:
        return ''
    if text.startswith('//'):
        text = 'https:' + text
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return ''
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]
    kept = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith('utm_') and key.lower() not in _TRACKING_PARAMS
    ]
    path = parsed.path.rstrip('/') or '/'
    return urllib.parse.urlunsplit((parsed.scheme, host, path, urllib.parse.urlencode(sorted(kept)), ''))


def _query_terms(query: str) -> list[str]:
    return [term for term in re.split(r'\W+', query.lower()) if len(term) > 2]


def metasearch(
    query: str,
    *,
    limit: int = 8,
    engines: Iterable[str] | None = None,
) -> MetasearchOutcome:
    """Query every engine concurrently and return merged, ranked rows."""

    names = tuple(engines) if engines is not None else ENGINE_NAMES
    if not names:
        return MetasearchOutcome()

    # Ask each engine for more than we need: dedupe across engines eats the surplus.
    per_engine = max(limit * 2, 10)
    merged: dict[str, dict[str, Any]] = {}
    scores: dict[str, float] = {}
    outcome = MetasearchOutcome()

    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        futures = {pool.submit(run_engine, name, query, per_engine): name for name in names}
        for future in as_completed(futures):
            name = futures[future]
            try:
                hits = future.result()
            except Exception as exc:  # noqa: BLE001 - one engine must not sink the search
                outcome.engines_failed[name] = str(exc) or exc.__class__.__name__
                continue
            outcome.engines_ok.append(name)
            for rank, hit in enumerate(hits, start=1):
                key = normalize_url(hit.url)
                if not key:
                    continue
                entry = merged.get(key)
                if entry is None:
                    merged[key] = {
                        'title': hit.title,
                        'url': hit.url,
                        'content': hit.snippet,
                        'engines': [name],
                    }
                else:
                    if name not in entry['engines']:
                        entry['engines'].append(name)
                    if not entry['content'] and hit.snippet:
                        entry['content'] = hit.snippet
                scores[key] = scores.get(key, 0.0) + 1.0 / (_RRF_K + rank)

    terms = _query_terms(query)
    if terms:
        for key, entry in merged.items():
            title = str(entry['title']).lower()
            hits = sum(1 for term in terms if term in title)
            if hits:
                scores[key] += _TITLE_BOOST * hits / len(terms)

    ordered = sorted(merged.items(), key=lambda item: (-scores.get(item[0], 0.0), item[0]))
    outcome.rows = [
        {
            'title': entry['title'],
            'url': entry['url'],
            'content': entry['content'],
            'engine': ', '.join(entry['engines']),
        }
        for _key, entry in ordered[:limit]
    ]
    return outcome
