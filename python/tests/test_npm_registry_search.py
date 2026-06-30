"""npm registry search tool."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from nemo_backend.tools.npm_search import (
    format_npm_search_report,
    lookup_npm_package_latest,
    search_npm_packages_tool,
    search_npm_registry,
)


def test_lookup_latest_returns_version() -> None:
    payload = {'name': 'left-pad', 'version': '1.3.0', 'description': 'pad strings'}
    with patch('nemo_backend.tools.npm_search._http_get_json', return_value=payload):
        row = lookup_npm_package_latest('left-pad')
    assert row is not None
    assert row['version'] == '1.3.0'


def test_search_enriches_with_latest_version() -> None:
    search_payload = {
        'objects': [
            {
                'package': {'name': 'lodash', 'description': 'utility'},
                'score': {'final': 0.99},
            }
        ]
    }
    latest_payload = {'name': 'lodash', 'version': '4.17.21', 'description': 'utility lib'}

    def fake_http(url: str, *, timeout: float = 20.0) -> object:
        if '/-/v1/search' in url:
            return search_payload
        if url.endswith('/lodash/latest'):
            return latest_payload
        raise AssertionError(url)

    with patch('nemo_backend.tools.npm_search._http_get_json', side_effect=fake_http):
        rows = search_npm_registry('lodash', limit=5)
    assert len(rows) == 1
    assert rows[0]['name'] == 'lodash'
    assert rows[0]['version'] == '4.17.21'


def test_format_report_includes_registry_links() -> None:
    text = format_npm_search_report(
        query='lodash',
        search_rows=[{'name': 'lodash', 'version': '4.17.21', 'description': 'utils', 'searchScore': 0.9}],
        lookup_rows=[],
    )
    assert 'lodash' in text
    assert '4.17.21' in text
    assert 'npmjs.com/package' in text


@pytest.mark.asyncio
async def test_tool_requires_query_or_names() -> None:
    out = await search_npm_packages_tool.ainvoke({'query': '', 'package_names': []})
    assert 'provide a non-empty' in out


@pytest.mark.asyncio
async def test_tool_exact_lookup() -> None:
    latest = {'name': '@types/node', 'version': '22.10.1', 'description': 'types'}
    with patch('nemo_backend.tools.npm_search.lookup_npm_package_latest', return_value=latest):
        out = await search_npm_packages_tool.ainvoke({'package_names': ['@types/node']})
    assert '@types/node' in out
    assert '22.10.1' in out


@pytest.mark.asyncio
async def test_tool_reports_missing_package() -> None:
    with patch('nemo_backend.tools.npm_search.lookup_npm_package_latest', return_value=None):
        out = await search_npm_packages_tool.ainvoke({'package_names': ['definitely-not-a-real-pkg-xyz']})
    assert 'not found' in out
