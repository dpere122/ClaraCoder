"""Search the public npm registry for packages and resolve latest published versions."""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from langchain_core.tools import tool

from nemo_backend.tools.node_deps import _validate_pkg_token
from nemo_backend.tools.tool_conventions import describe
from nemo_backend.tools.workspace import truncate_text_head_tail

SEARCH_NPM_PACKAGES_NAME = 'search_npm_packages'

_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
_REQUEST_TIMEOUT_SEC = 20.0
_MAX_OUTPUT_CHARS = 80_000
_MAX_QUERY_LEN = 256
_MAX_LIMIT = 25
_DEFAULT_LIMIT = 15
_MAX_EXACT_LOOKUPS = 20

__all__ = [
    'SEARCH_NPM_PACKAGES_NAME',
    'format_npm_search_report',
    'lookup_npm_package_latest',
    'search_npm_packages_tool',
    'search_npm_registry',
]


def _encode_package_name(name: str) -> str:
    return urllib.parse.quote(name.strip(), safe='')


def _http_get_json(url: str, *, timeout: float = _REQUEST_TIMEOUT_SEC) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            'Accept': 'application/json',
            'User-Agent': 'nemo-wrapper-npm-registry-tool',
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode('utf-8'))


def lookup_npm_package_latest(package_name: str) -> dict[str, Any] | None:
    """Return latest manifest from the registry, or ``None`` when the package is missing."""

    name = str(package_name or '').strip()
    if not name:
        return None
    url = f'{_REGISTRY_ORIGIN}/{_encode_package_name(name)}/latest'
    try:
        data = _http_get_json(url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if not isinstance(data, dict):
        return None
    return {
        'name': str(data.get('name') or name),
        'version': str(data.get('version') or '').strip(),
        'description': str(data.get('description') or '').strip(),
        'license': str(data.get('license') or '').strip() if isinstance(data.get('license'), str) else '',
        'homepage': str(data.get('homepage') or '').strip() if isinstance(data.get('homepage'), str) else '',
        'published': '',
    }


def search_npm_registry(query: str, *, limit: int = _DEFAULT_LIMIT) -> list[dict[str, Any]]:
    """Search npmjs.com registry; returns rows with ``name``, ``version`` (latest), and metadata."""

    params = urllib.parse.urlencode({'text': query.strip(), 'size': max(1, min(limit, _MAX_LIMIT))})
    url = f'{_SEARCH_URL}?{params}'
    payload = _http_get_json(url)
    objects = payload.get('objects') if isinstance(payload, dict) else None
    if not isinstance(objects, list):
        return []

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in objects:
        if not isinstance(item, dict):
            continue
        pkg = item.get('package')
        if not isinstance(pkg, dict):
            continue
        name = str(pkg.get('name') or '').strip()
        if not name or name in seen:
            continue
        seen.add(name)
        rows.append(
            {
                'name': name,
                'version': '',
                'description': str(pkg.get('description') or '').strip(),
                'keywords': [str(k) for k in (pkg.get('keywords') or []) if str(k).strip()][:8],
                'searchScore': float(item.get('score', {}).get('final', 0.0))
                if isinstance(item.get('score'), dict)
                else 0.0,
            }
        )
        if len(rows) >= limit:
            break

    for row in rows:
        latest = lookup_npm_package_latest(row['name'])
        if latest is None:
            continue
        row['version'] = str(latest.get('version') or '').strip()
        if not row['description']:
            row['description'] = str(latest.get('description') or '').strip()
        row['license'] = str(latest.get('license') or '').strip()
        row['homepage'] = str(latest.get('homepage') or '').strip()

    return rows


async def _lookup_many(package_names: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name in package_names:
        latest = await asyncio.to_thread(lookup_npm_package_latest, name)
        if latest is None:
            rows.append({'name': name, 'version': '', 'missing': True})
            continue
        rows.append(
            {
                'name': str(latest.get('name') or name),
                'version': str(latest.get('version') or '').strip(),
                'description': str(latest.get('description') or '').strip(),
                'license': str(latest.get('license') or '').strip(),
                'homepage': str(latest.get('homepage') or '').strip(),
                'missing': False,
            }
        )
    return rows


def _normalize_limit(limit: object) -> tuple[int | None, str | None]:
    if isinstance(limit, bool):
        return None, 'Tool error: `limit` must be an integer.'
    if isinstance(limit, int):
        value = limit
    elif isinstance(limit, float) and limit.is_integer():
        value = int(limit)
    else:
        return None, 'Tool error: `limit` must be an integer.'
    if value < 1 or value > _MAX_LIMIT:
        return None, f'Tool error: `limit` must be between 1 and {_MAX_LIMIT}.'
    return value, None


def _normalize_package_names(raw: object) -> tuple[list[str] | None, str | None]:
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, 'Tool error: `package_names` must be a list of strings.'
    names: list[str] = []
    for i, item in enumerate(raw):
        if not isinstance(item, str):
            return None, f'Tool error: `package_names[{i}]` must be a string.'
        cleaned = item.strip()
        if not cleaned:
            continue
        if not _validate_pkg_token(cleaned):
            return None, f'Tool error: unsupported package name `{cleaned}`.'
        if cleaned not in names:
            names.append(cleaned)
    if len(names) > _MAX_EXACT_LOOKUPS:
        return None, f'Tool error: at most {_MAX_EXACT_LOOKUPS} `package_names` entries are allowed.'
    return names, None


def format_npm_search_report(
    *,
    query: str,
    search_rows: list[dict[str, Any]],
    lookup_rows: list[dict[str, Any]],
) -> str:
    lines: list[str] = ['npm registry lookup (latest published versions):', '']

    if query.strip():
        lines.append(f'Search query: `{query.strip()}`')
        if not search_rows:
            lines.append('- Matches: none')
        else:
            lines.append(f'- Matches: {len(search_rows)}')
            lines.append('')
            for index, row in enumerate(search_rows, start=1):
                name = str(row.get('name') or '')
                version = str(row.get('version') or '').strip() or '(unknown)'
                desc = str(row.get('description') or '').strip()
                if len(desc) > 240:
                    desc = desc[:237] + '…'
                score = row.get('searchScore')
                score_text = f' (relevance {score:.2f})' if isinstance(score, (int, float)) else ''
                lines.append(f'{index}. `{name}` — latest `{version}`{score_text}')
                if desc:
                    lines.append(f'   {desc}')
                license_ = str(row.get('license') or '').strip()
                if license_:
                    lines.append(f'   License: `{license_}`')
                homepage = str(row.get('homepage') or '').strip()
                if homepage:
                    lines.append(f'   Homepage: {homepage}')
                lines.append(f'   Registry: https://www.npmjs.com/package/{_encode_package_name(name)}')
                lines.append('')

    if lookup_rows:
        if query.strip():
            lines.append('Exact package lookups:')
        for index, row in enumerate(lookup_rows, start=1):
            name = str(row.get('name') or '')
            if row.get('missing'):
                lines.append(f'{index}. `{name}` — not found on the public npm registry')
                lines.append('')
                continue
            version = str(row.get('version') or '').strip() or '(unknown)'
            desc = str(row.get('description') or '').strip()
            if len(desc) > 240:
                desc = desc[:237] + '…'
            lines.append(f'{index}. `{name}` — latest `{version}`')
            if desc:
                lines.append(f'   {desc}')
            license_ = str(row.get('license') or '').strip()
            if license_:
                lines.append(f'   License: `{license_}`')
            homepage = str(row.get('homepage') or '').strip()
            if homepage:
                lines.append(f'   Homepage: {homepage}')
            lines.append(f'   Registry: https://www.npmjs.com/package/{_encode_package_name(name)}')
            lines.append('')

    lines.append(
        'Versions are resolved from the registry `latest` dist-tag. '
        'Pass exact names to `install_npm_packages` (optionally with `@version`).'
    )
    body = '\n'.join(lines).rstrip() + '\n'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


@tool(SEARCH_NPM_PACKAGES_NAME, description=describe('Search the public npm registry and resolve latest published versions.',
        when='choosing packages or checking latest versions before install.',
        not_='installing packages.',
        shape=(
            '`query` for keyword search (name, description, keywords); `package_names` for exact lookups '
            '(including scoped like `@angular/core`); may pass both; read-only; follow with `install_npm_packages`.'
        ),))
async def search_npm_packages_tool(
    query: str = '',
    package_names: list[str] | None = None,
    limit: int = _DEFAULT_LIMIT,
) -> str:

    q = str(query or '').strip()
    if len(q) > _MAX_QUERY_LEN:
        return f'Tool error: `query` must be at most {_MAX_QUERY_LEN} characters.'
    if q and re.search(r'[\x00-\x1f\x7f]', q):
        return 'Tool error: `query` contains control characters.'

    limit_value, limit_err = _normalize_limit(limit)
    if limit_err:
        return limit_err
    assert limit_value is not None

    names, names_err = _normalize_package_names(package_names)
    if names_err:
        return names_err
    assert names is not None

    if not q and not names:
        return 'Tool error: provide a non-empty `query` and/or `package_names`.'

    search_rows: list[dict[str, Any]] = []
    lookup_rows: list[dict[str, Any]] = []

    try:
        if q:
            search_rows = await asyncio.to_thread(search_npm_registry, q, limit=limit_value)
        if names:
            lookup_rows = await _lookup_many(names)
    except urllib.error.HTTPError as exc:
        return f'Tool error: npm registry HTTP {exc.code} ({exc.reason}).'
    except urllib.error.URLError as exc:
        return f'Tool error: could not reach the npm registry ({exc.reason}).'
    except TimeoutError:
        return 'Tool error: npm registry request timed out.'
    except json.JSONDecodeError:
        return 'Tool error: npm registry returned invalid JSON.'

    return format_npm_search_report(query=q, search_rows=search_rows, lookup_rows=lookup_rows)
