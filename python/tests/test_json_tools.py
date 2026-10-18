"""Tests for JSON search-and-zoom tools."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.json.parser import clear_json_cache_for_tests
from clara_coder_backend.tools.structured_tools import read_structured_section, search_structured, structured_overview

SAMPLE_JSON = """{
  "service": "customer-api",
  "config": {
    "host": "api.example.com",
    "port": 443
  },
  "users": [
    {"id": 1, "name": "Ada"},
    {"id": 2, "name": "Grace"}
  ]
}
"""

SAMPLE_JSONC = """{
  // application config
  "enabled": true,
  "retries": 3
}
"""


@pytest.fixture()
def json_env():
    td = tempfile.TemporaryDirectory()
    root = Path(td.name)
    (root / 'app.json').write_text(SAMPLE_JSON, encoding='utf-8')
    (root / 'flags.jsonc').write_text(SAMPLE_JSONC, encoding='utf-8')

    session_id = 'test-json-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(root.resolve())
    clear_json_cache_for_tests()

    class _Env:
        pass

    env = _Env()
    env.root = root  # type: ignore[attr-defined]

    yield env

    clear_json_cache_for_tests()
    current_session_id.reset(token)
    td.cleanup()


def test_json_overview_lists_paths(json_env) -> None:
    out = structured_overview.invoke({'relative_path': 'app.json'})
    assert 'Root type: object' in out
    assert 'config.host' in out
    assert 'users[0].name' in out


def test_search_json_finds_key(json_env) -> None:
    out = search_structured.invoke(
        {'relative_path': 'app.json', 'query': 'host', 'scope': 'keys'}
    )
    assert 'section_ref=' in out
    assert 'config.host' in out


def test_read_json_section_returns_subtree(json_env) -> None:
    out = read_structured_section.invoke(
        {'relative_path': 'app.json', 'section_ref': 'path:users[0]'}
    )
    assert '"name": "Ada"' in out
    assert 'users[0]' in out


def test_json_overview_jsonc(json_env) -> None:
    out = structured_overview.invoke({'relative_path': 'flags.jsonc'})
    assert 'enabled' in out
    assert 'retries' in out


def test_json_missing_file(json_env) -> None:
    out = structured_overview.invoke({'relative_path': 'missing.json'})
    assert 'not on the workspace disk' in out


def test_json_invalid_extension(json_env) -> None:
    (json_env.root / 'data.txt').write_text('{}', encoding='utf-8')
    out = structured_overview.invoke({'relative_path': 'data.txt'})
    assert 'not a structured file' in out


def test_json_invalid_section_ref(json_env) -> None:
    out = read_structured_section.invoke(
        {'relative_path': 'app.json', 'section_ref': 'path:$missing'}
    )
    assert 'not found' in out
