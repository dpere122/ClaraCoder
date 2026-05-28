"""Node.js workspace smoke-test helpers."""

from __future__ import annotations

import json
from pathlib import Path

from nemo_backend.agents.specialists.project_review_tools import (
    _discover_node_smoke_script,
    _package_json_scripts,
)


def test_discover_prefers_smoke_then_dev(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text(
        json.dumps({'scripts': {'build': 'tsc', 'dev': 'vite', 'smoke': 'node smoke.mjs'}}),
        encoding='utf-8',
    )
    assert _discover_node_smoke_script(tmp_path) == 'smoke'

    (tmp_path / 'package.json').write_text(
        json.dumps({'scripts': {'build': 'tsc', 'dev': 'vite'}}),
        encoding='utf-8',
    )
    assert _discover_node_smoke_script(tmp_path) == 'dev'


def test_package_json_scripts_empty_on_missing() -> None:
    assert _package_json_scripts(Path('/nonexistent')) == {}
