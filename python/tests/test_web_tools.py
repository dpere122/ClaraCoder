"""SearXNG web_search + fetch_url tools."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES, maybe_await_hitl_for_deferred_tool
from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools.fetch_url import fetch_url_tool, html_to_text
from clara_coder_backend.tools.http_guards import assert_public_http_url, normalize_http_base_url
from clara_coder_backend.tools.web_search import format_searxng_search_report, search_searxng, web_search_tool
from clara_coder_backend.tools.metasearch import ENGINE_NAMES, MetasearchOutcome, clear_cache
from clara_coder_backend.hitl.tool_registry import worker_tools_and_map


@pytest.fixture
def enable_web(monkeypatch: pytest.MonkeyPatch):
    clear_cache()
    tools = RuntimeToolsConfig(
        allow_web_access=True,
        searxng_base_url='http://127.0.0.1:8080',
    )
    monkeypatch.setattr(runtime_config, 'tools', tools)
    return tools


def test_normalize_http_base_url() -> None:
    assert normalize_http_base_url(' http://127.0.0.1:8080/ ') == 'http://127.0.0.1:8080'
    assert normalize_http_base_url('ftp://example.com') == ''
    assert normalize_http_base_url('') == ''


def test_assert_public_http_url_blocks_loopback() -> None:
    err = assert_public_http_url('http://127.0.0.1/secret')
    assert err is not None
    assert 'non-public' in err


def test_assert_public_http_url_blocks_private_literal() -> None:
    err = assert_public_http_url('http://10.0.0.5/x')
    assert err is not None


def test_html_to_text_strips_scripts() -> None:
    text = html_to_text('<html><script>alert(1)</script><p>Hello <b>world</b></p></html>')
    assert 'alert' not in text
    assert 'Hello' in text
    assert 'world' in text


def test_format_searxng_report() -> None:
    text = format_searxng_search_report(
        query='langgraph',
        rows=[{'title': 'LangGraph', 'url': 'https://example.com', 'content': 'docs', 'engine': 'duckduckgo'}],
    )
    assert 'langgraph' in text
    assert 'https://example.com' in text
    assert 'fetch_url' in text


def test_search_searxng_parses_results() -> None:
    payload = {
        'results': [
            {'title': 'A', 'url': 'https://a.example', 'content': 'alpha', 'engine': 'google'},
            {'title': 'B', 'url': 'https://b.example', 'content': 'beta'},
        ]
    }

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(payload).encode('utf-8')

    with patch('clara_coder_backend.tools.web_search.urllib.request.urlopen', return_value=_Resp()):
        rows = search_searxng('q', base_url='http://127.0.0.1:8080', limit=1)
    assert len(rows) == 1
    assert rows[0]['title'] == 'A'


@pytest.mark.asyncio
async def test_web_search_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config, 'tools', RuntimeToolsConfig(allow_web_access=False))
    out = await web_search_tool.ainvoke({'query': 'test'})
    assert 'web access is disabled' in out


@pytest.mark.asyncio
async def test_web_search_missing_base_url(enable_web) -> None:
    enable_web.searxng_base_url = ''
    enable_web.web_search_provider = 'searxng'
    sid = 'web-search-no-url'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    try:
        out = await web_search_tool.ainvoke({'query': 'test'})
    finally:
        current_session_id.reset(token)
    assert 'SearXNG base URL' in out


@pytest.mark.asyncio
async def test_web_search_hitl_when_auto_apply_off(enable_web) -> None:
    sid = 'web-search-hitl'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = False
    session.pending_accept_command_request = None
    try:
        out = await web_search_tool.ainvoke({'query': 'fastapi docs'})
        assert 'Pending user confirmation' in out
        pending = session.pending_accept_command_request
        assert pending is not None
        assert pending['action']['tool_name'] == 'web_search'
        assert pending['command_text'] == 'fastapi docs'
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_web_search_happy_path(enable_web) -> None:
    sid = 'web-search-ok'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    rows = [{'title': 'Docs', 'url': 'https://example.com/d', 'content': 'guide', 'engine': 'bing'}]
    try:
        with patch('clara_coder_backend.tools.web_search.search_searxng', return_value=rows):
            out = await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert 'Docs' in out
    assert 'https://example.com/d' in out


@pytest.mark.asyncio
async def test_fetch_url_ssrf_blocked(enable_web) -> None:
    sid = 'fetch-ssrf'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    try:
        out = await fetch_url_tool.ainvoke({'url': 'http://127.0.0.1:8080/'})
    finally:
        current_session_id.reset(token)
    assert 'non-public' in out or 'blocked' in out


@pytest.mark.asyncio
async def test_fetch_url_hitl_when_auto_apply_off(enable_web) -> None:
    sid = 'fetch-hitl'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = False
    session.pending_accept_command_request = None
    try:
        out = await fetch_url_tool.ainvoke({'url': 'https://example.com/docs'})
        assert 'Pending user confirmation' in out
        pending = session.pending_accept_command_request
        assert pending is not None
        assert pending['action']['tool_name'] == 'fetch_url'
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_fetch_url_happy_path(enable_web) -> None:
    sid = 'fetch-ok'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True

    class _Resp:
        headers = {'Content-Type': 'text/html; charset=utf-8'}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, n: int = -1):
            body = b'<html><body><p>Hello fetch</p></body></html>'
            return body if n < 0 else body[:n]

        def geturl(self):
            return 'https://example.com/page'

    try:
        with (
            patch('clara_coder_backend.tools.fetch_url.assert_public_http_url', return_value=None),
            patch('clara_coder_backend.tools.fetch_url._OPENER.open', return_value=_Resp()),
        ):
            out = await fetch_url_tool.ainvoke({'url': 'https://example.com/page'})
    finally:
        current_session_id.reset(token)
    assert 'Hello fetch' in out
    assert 'Fetched:' in out


def test_web_tools_in_deferred_hitl_set() -> None:
    assert 'web_search' in DEFERRED_HITL_TOOL_NAMES
    assert 'fetch_url' in DEFERRED_HITL_TOOL_NAMES


def test_web_tools_bound_when_enabled(enable_web) -> None:
    tools, mapping = worker_tools_and_map(False)
    names = {getattr(t, 'name', '') for t in tools}
    assert 'web_search' in names
    assert 'fetch_url' in names
    assert 'web_search' in mapping


def test_web_tools_unbound_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config, 'tools', RuntimeToolsConfig(allow_web_access=False))
    tools, _ = worker_tools_and_map(False)
    names = {getattr(t, 'name', '') for t in tools}
    assert 'web_search' not in names
    assert 'fetch_url' not in names


def test_maybe_await_hitl_presentation_for_web_search() -> None:
    session = get_session('web-hitl-present')
    session.auto_apply_mode = False
    session.pending_accept_command_request = None
    msg = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name='web_search',
        tool_input={'query': 'q', 'limit': 5},
    )
    assert msg is not None
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['title'] == 'Web search'
    assert pending['command_text'] == 'q'


def test_fetch_url_redirect_to_private_host_is_blocked_before_request() -> None:
    import urllib.error

    import pytest as _pytest

    from clara_coder_backend.tools.fetch_url import _PublicOnlyRedirectHandler

    handler = _PublicOnlyRedirectHandler()
    with _pytest.raises(urllib.error.URLError):
        handler.redirect_request(None, None, 302, 'Found', {}, 'http://127.0.0.1:8080/admin')

@pytest.mark.asyncio
async def test_web_search_uses_builtin_when_provider_internal(enable_web) -> None:
    enable_web.web_search_provider = 'internal'
    enable_web.searxng_base_url = ''
    sid = 'web-search-internal'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    outcome = MetasearchOutcome(
        rows=[{'title': 'Docs', 'url': 'https://example.com/d', 'content': 'guide', 'engine': 'duckduckgo'}],
        engines_ok=['duckduckgo'],
    )
    try:
        with patch('clara_coder_backend.tools.web_search.metasearch', return_value=outcome):
            out = await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert 'built-in' in out
    assert 'https://example.com/d' in out


@pytest.mark.asyncio
async def test_web_search_auto_prefers_searxng_when_base_url_set(enable_web) -> None:
    enable_web.web_search_provider = 'auto'
    sid = 'web-search-auto'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    rows = [{'title': 'Docs', 'url': 'https://example.com/d', 'content': 'guide', 'engine': 'bing'}]
    try:
        with patch('clara_coder_backend.tools.web_search.search_searxng', return_value=rows) as searxng:
            out = await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert searxng.called
    assert 'SearXNG' in out


@pytest.mark.asyncio
async def test_web_search_reports_when_every_engine_fails(enable_web) -> None:
    enable_web.web_search_provider = 'internal'
    enable_web.searxng_base_url = ''
    sid = 'web-search-all-fail'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    outcome = MetasearchOutcome(rows=[], engines_ok=[], engines_failed={'bing': 'HTTP 503'})
    try:
        with patch('clara_coder_backend.tools.web_search.metasearch', return_value=outcome):
            out = await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert 'every built-in search engine failed' in out
    assert 'bing' in out

@pytest.mark.asyncio
async def test_web_search_passes_configured_engines(enable_web) -> None:
    enable_web.web_search_provider = 'internal'
    enable_web.searxng_base_url = ''
    enable_web.web_search_engines = ['wikipedia', 'bogus']
    sid = 'web-search-engines'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    outcome = MetasearchOutcome(rows=[], engines_ok=['wikipedia'])
    try:
        with patch('clara_coder_backend.tools.web_search.metasearch', return_value=outcome) as ms:
            await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert ms.call_args.kwargs['engines'] == ('wikipedia',)


@pytest.mark.asyncio
async def test_web_search_empty_engine_list_means_all(enable_web) -> None:
    enable_web.web_search_provider = 'internal'
    enable_web.searxng_base_url = ''
    enable_web.web_search_engines = []
    sid = 'web-search-engines-all'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.auto_apply_mode = True
    outcome = MetasearchOutcome(rows=[], engines_ok=list(ENGINE_NAMES))
    try:
        with patch('clara_coder_backend.tools.web_search.metasearch', return_value=outcome) as ms:
            await web_search_tool.ainvoke({'query': 'guide'})
    finally:
        current_session_id.reset(token)
    assert ms.call_args.kwargs['engines'] == ENGINE_NAMES
