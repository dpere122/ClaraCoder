"""Tests for Monaco-facing LSP completion and location serialization."""

from __future__ import annotations

from pathlib import Path

from clara_coder_backend.lsp.editor_monaco import (
    serialize_code_lenses_payload,
    serialize_completion_result,
    serialize_locations_payload,
    serialize_rename_workspace_edit,
)


class _Manager:
    """Serializer currently ignores the manager for completions."""


class _WorkspaceManager:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root.resolve()


def test_serialize_completion_preserves_jdtls_data() -> None:
    raw = {
        'isIncomplete': False,
        'items': [
            {
                'label': 'toString',
                'kind': 2,
                'insertText': 'toString()',
                'data': {'rid': '1', 'pid': '0'},
            }
        ],
    }
    out = serialize_completion_result(_Manager(), raw)
    assert out['items'][0]['data'] == {'rid': '1', 'pid': '0'}
    assert out['items'][0]['kind'] == 2


def test_serialize_completion_applies_item_defaults() -> None:
    raw = {
        'isIncomplete': True,
        'itemDefaults': {
            'insertTextFormat': 2,
            'data': {'shared': True},
            'editRange': {
                'start': {'line': 3, 'character': 2},
                'end': {'line': 3, 'character': 8},
            },
        },
        'items': [{'label': 'println'}],
    }
    out = serialize_completion_result(_Manager(), raw)
    item = out['items'][0]
    assert out['isIncomplete'] is True
    assert item['insertTextFormat'] == 2
    assert item['data'] == {'shared': True}
    assert item['textEdit']['newText'] == 'println'
    assert item['textEdit']['range'] == {
        'startLineNumber': 4,
        'startColumn': 3,
        'endLineNumber': 4,
        'endColumn': 9,
    }


def _sample_range() -> dict[str, dict[str, int]]:
    return {
        'start': {'line': 2, 'character': 4},
        'end': {'line': 2, 'character': 10},
    }


def test_serialize_locations_skips_jdt_uris(tmp_path: Path) -> None:
    src = tmp_path / 'src' / 'App.java'
    src.parent.mkdir(parents=True)
    src.write_text('class App {}\n', encoding='utf-8')
    mgr = _WorkspaceManager(tmp_path)
    raw = [
        {'uri': src.resolve().as_uri(), 'range': _sample_range()},
        {
            'uri': 'jdt://contents/java.base/java.lang/String.class',
            'range': _sample_range(),
        },
    ]
    out = serialize_locations_payload(mgr, raw)
    assert len(out) == 1
    assert out[0]['relativePath'] == 'src/App.java'
    assert out[0]['range']['startLineNumber'] == 3
    assert out[0]['range']['startColumn'] == 5


def test_serialize_workspace_edit_skips_jdt_uris(tmp_path: Path) -> None:
    src = tmp_path / 'src' / 'App.java'
    src.parent.mkdir(parents=True)
    src.write_text('class App {}\n', encoding='utf-8')
    mgr = _WorkspaceManager(tmp_path)
    edit = {
        'range': _sample_range(),
        'newText': 'Renamed',
    }
    raw = {
        'changes': {
            src.resolve().as_uri(): [edit],
            'jdt://contents/java.base/java.lang/Object.class': [edit],
        }
    }
    out = serialize_rename_workspace_edit(mgr, raw)
    assert out is not None
    assert list(out['changes'].keys()) == ['src/App.java']
    assert out['changes']['src/App.java'][0]['newText'] == 'Renamed'


def test_serialize_code_lenses_rewrites_java_show_references_args(tmp_path: Path) -> None:
    src = tmp_path / 'src' / 'App.java'
    other = tmp_path / 'src' / 'Other.java'
    src.parent.mkdir(parents=True)
    src.write_text('class App {}\n', encoding='utf-8')
    other.write_text('class Other {}\n', encoding='utf-8')
    mgr = _WorkspaceManager(tmp_path)
    raw = [
        {
            'range': _sample_range(),
            'command': {
                'title': '2 references',
                'command': 'java.show.references',
                'arguments': [
                    src.resolve().as_uri(),
                    {'line': 4, 'character': 1},
                    [
                        {'uri': other.resolve().as_uri(), 'range': _sample_range()},
                        {
                            'uri': 'jdt://contents/java.base/java.lang/Object.class',
                            'range': _sample_range(),
                        },
                    ],
                ],
            },
        }
    ]
    out = serialize_code_lenses_payload(raw, manager=mgr)
    cmd = out[0]['command']
    assert cmd['command'] == 'java.show.references'
    origin, locations = cmd['arguments']
    assert origin['relativePath'] == 'src/App.java'
    assert origin['position'] == {'lineNumber': 5, 'column': 2}
    assert len(locations) == 1
    assert locations[0]['relativePath'] == 'src/Other.java'
