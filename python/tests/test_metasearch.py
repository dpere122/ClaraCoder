"""Built-in metasearch backend: DOM helpers, engine parsers, aggregation and cache."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest

from clara_coder_backend.tools.metasearch.aggregate import metasearch, normalize_url
from clara_coder_backend.tools.metasearch.cache import clear_cache, get_cached, put_cached
from clara_coder_backend.tools.metasearch.dom import find_all, find_first, parse_html, text_of
from clara_coder_backend.tools.metasearch.engines import ENGINE_NAMES, RawResult, run_engine

_DDG_HTML = """
<div class="result results_links results_links_deep web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
  <a class="result__snippet">A guide to things.</a>
</div>
"""

_BING_HTML = """
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/bing">Bing Hit</a></h2>
    <p>Bing snippet.</p>
  </li>
</ol>
"""

_MOJEEK_HTML = """
<ul class="results-standard">
  <li>
    <h2><a class="ob" href="https://example.com/mojeek">Mojeek Hit</a></h2>
    <p class="s">Mojeek snippet.</p>
  </li>
</ul>
"""

_WIKIPEDIA_JSON = json.dumps(
    {
        'query': {
            'search': [
                {
                    'title': 'LangGraph',
                    'pageid': 123,
                    'snippet': '<span class="searchmatch">LangGraph</span> is a library',
                }
            ]
        }
    }
)


def test_parse_html_finds_by_tag_and_class() -> None:
    root = parse_html('<div class="a"><p class="b">hi</p><p>bye</p></div>')
    assert len(find_all(root, tag='p')) == 2
    assert len(find_all(root, class_='b')) == 1
    assert text_of(find_first(root, class_='b')) == 'hi'


def test_text_of_skips_script_and_style() -> None:
    root = parse_html('<div><script>alert(1)</script><style>.x{}</style><p>Hello <b>world</b></p></div>')
    assert text_of(root) == 'Hello world'


def test_normalize_url_strips_tracking_and_www() -> None:
    assert normalize_url('https://www.Example.com/docs/?utm_source=x&b=2&a=1#frag') == (
        'https://example.com/docs?a=1&b=2'
    )
    assert normalize_url('https://example.com/docs') == normalize_url('https://example.com/docs/')


def test_normalize_url_rejects_non_http() -> None:
    assert normalize_url('javascript:alert(1)') == ''
    assert normalize_url('') == ''
    assert normalize_url('mailto:a@b.c') == ''


def test_duckduckgo_parser_unwraps_redirect() -> None:
    with patch('clara_coder_backend.tools.metasearch.engines._http_get', return_value=_DDG_HTML):
        rows = run_engine('duckduckgo', 'docs', 5)
    assert len(rows) == 1
    assert rows[0].url == 'https://example.com/docs'
    assert rows[0].title == 'Example Docs'
    assert rows[0].snippet == 'A guide to things.'


def test_bing_parser() -> None:
    with patch('clara_coder_backend.tools.metasearch.engines._http_get', return_value=_BING_HTML):
        rows = run_engine('bing', 'hit', 5)
    assert len(rows) == 1
    assert rows[0].url == 'https://example.com/bing'
    assert rows[0].snippet == 'Bing snippet.'


def test_bing_parser_unwraps_click_tracking() -> None:
    target = 'https://example.com/real'
    encoded = base64.urlsafe_b64encode(target.encode()).decode().rstrip('=')
    html = (
        '<li class="b_algo"><h2>'
        f'<a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1{encoded}">Real</a>'
        '</h2></li>'
    )
    with patch('clara_coder_backend.tools.metasearch.engines._http_get', return_value=html):
        rows = run_engine('bing', 'real', 5)
    assert len(rows) == 1
    assert rows[0].url == target


def test_mojeek_parser() -> None:
    with patch('clara_coder_backend.tools.metasearch.engines._http_get', return_value=_MOJEEK_HTML):
        rows = run_engine('mojeek', 'hit', 5)
    assert len(rows) == 1
    assert rows[0].url == 'https://example.com/mojeek'
    assert rows[0].snippet == 'Mojeek snippet.'


def test_wikipedia_parser_strips_markup() -> None:
    with patch('clara_coder_backend.tools.metasearch.engines._http_get', return_value=_WIKIPEDIA_JSON):
        rows = run_engine('wikipedia', 'langgraph', 5)
    assert len(rows) == 1
    assert rows[0].url == 'https://en.wikipedia.org/?curid=123'
    assert rows[0].snippet == 'LangGraph is a library'


def test_unknown_engine_raises() -> None:
    with pytest.raises(KeyError):
        run_engine('nope', 'q', 1)


def test_metasearch_dedupes_and_ranks_by_agreement() -> None:
    def fake_engine(name: str, query: str, limit: int) -> list[RawResult]:
        del query, limit
        if name == 'a':
            return [
                RawResult('X', 'https://example.com/x?utm_source=1', 'x snippet'),
                RawResult('Y', 'https://other.com/y', 'y snippet'),
            ]
        return [
            RawResult('Y', 'https://www.other.com/y/', ''),
            RawResult('Z', 'https://third.com/z', 'z snippet'),
        ]

    with patch('clara_coder_backend.tools.metasearch.aggregate.run_engine', side_effect=fake_engine):
        outcome = metasearch('test query', limit=5, engines=('a', 'b'))

    assert [row['url'] for row in outcome.rows][0] == 'https://other.com/y'
    assert len(outcome.rows) == 3
    merged = next(row for row in outcome.rows if row['url'] == 'https://other.com/y')
    assert merged['engine'] == 'a, b'
    assert merged['content'] == 'y snippet'
    assert sorted(outcome.engines_ok) == ['a', 'b']


def test_metasearch_isolates_engine_failure() -> None:
    def fake_engine(name: str, query: str, limit: int) -> list[RawResult]:
        del query, limit
        if name == 'bad':
            raise RuntimeError('HTTP 503')
        return [RawResult('Good', 'https://good.example/page', 'ok')]

    with patch('clara_coder_backend.tools.metasearch.aggregate.run_engine', side_effect=fake_engine):
        outcome = metasearch('q', limit=5, engines=('bad', 'good'))

    assert outcome.engines_failed == {'bad': 'HTTP 503'}
    assert outcome.engines_ok == ['good']
    assert len(outcome.rows) == 1


def test_metasearch_respects_limit() -> None:
    def fake_engine(name: str, query: str, limit: int) -> list[RawResult]:
        del name, query, limit
        return [RawResult(f'T{i}', f'https://example.com/{i}', '') for i in range(10)]

    with patch('clara_coder_backend.tools.metasearch.aggregate.run_engine', side_effect=fake_engine):
        outcome = metasearch('q', limit=3, engines=('a',))

    assert len(outcome.rows) == 3


def test_cache_roundtrip_and_clear() -> None:
    clear_cache()
    assert get_cached(('k',)) is None
    put_cached(('k',), 'v')
    assert get_cached(('k',)) == 'v'
    clear_cache()
    assert get_cached(('k',)) is None


def test_shared_engine_list_matches_backend() -> None:
    """The renderer's engine list must stay in sync with ``ENGINE_NAMES``."""

    path = Path(__file__).resolve().parents[2] / 'src' / 'shared' / 'web-search-engines.ts'
    if not path.is_file():
        pytest.skip('renderer sources not present')
    ids = re.findall(r"\{ id: '([a-z0-9]+)'", path.read_text(encoding='utf-8'))
    assert tuple(ids) == ENGINE_NAMES
    clear_cache()
    assert get_cached(('k',)) is None
