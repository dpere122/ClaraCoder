"""Runs the real gdls binary against ``fixtures/godot_project`` through the session manager.

Skipped unless gdls is installed: set ``CLARA_TEST_GDLS_BINARY``, or ``CLARA_RUNTIME_DIR`` to a runtime
directory where it was installed from Dependencies.
"""

from __future__ import annotations

import os
import shutil
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from clara_coder_backend.lsp.editor_features import file_rename_edits, run_editor_feature, workspace_symbols
from clara_coder_backend.lsp.manager import SessionWorkspaceLspManager, shutdown_all_lsp_managers
from clara_coder_backend.runtime.deps.providers import gdls
from clara_coder_backend.session.state import current_session_id, get_session

FIXTURE = Path(__file__).parent / 'fixtures' / 'godot_project'


def _binary() -> Path | None:
    raw = os.environ.get('CLARA_TEST_GDLS_BINARY', '').strip()
    return Path(raw) if raw else gdls.installed_binary()


pytestmark = pytest.mark.skipif(_binary() is None, reason='gdls is not installed')

DOG = 'scripts/dog.gd'
ANIMAL = 'scripts/animal.gd'


@pytest.fixture
def godot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[SessionWorkspaceLspManager]:
    project = tmp_path / 'game'
    shutil.copytree(FIXTURE, project, ignore=shutil.ignore_patterns('.gdls', '.godot'))
    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.setattr(gdls, 'installed_binary', _binary)
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path / 'runtime'))
    # Keep the run independent of any Godot on this machine; gdls uses its bundled class surface.
    monkeypatch.setenv('GODOT', 'off')
    session_id = 'gdls-integration'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(project.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    manager = SessionWorkspaceLspManager(
        session_id=session_id,
        session=session,
        workspace_root=project,
        scope='workspace',
        server_kind='gdscript',
    )
    try:
        yield manager
    finally:
        manager.shutdown()
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def _position_of(manager: SessionWorkspaceLspManager, rel: str, needle: str, *, offset: int = 0) -> tuple[int, int]:
    text = (manager.workspace_root / rel).read_text(encoding='utf-8')
    for number, line in enumerate(text.splitlines(), start=1):
        column = line.find(needle)
        if column >= 0:
            return number, column + 1 + offset
    raise AssertionError(f'{needle!r} not found in {rel}')


def _wait_for(check, timeout_s: float = 30.0):  # noqa: ANN001, ANN202
    deadline = time.monotonic() + timeout_s
    while True:
        result = check()
        if result or time.monotonic() >= deadline:
            return result
        time.sleep(0.2)


def test_starts_without_an_editor_and_advertises_features(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    for provider in (
        'hoverProvider',
        'definitionProvider',
        'implementationProvider',
        'typeDefinitionProvider',
        'declarationProvider',
        'referencesProvider',
        'renameProvider',
        'foldingRangeProvider',
        'selectionRangeProvider',
        'colorProvider',
        'documentLinkProvider',
        'callHierarchyProvider',
        'typeHierarchyProvider',
        'workspaceSymbolProvider',
        'semanticTokensProvider',
        'inlayHintProvider',
        'codeActionProvider',
    ):
        assert godot.has_provider(provider), provider
    # What the client relies on not being served: requests must be gated, not sent.
    assert not godot.has_provider('codeLensProvider')
    assert not godot.has_provider('documentRangeFormattingProvider')
    assert not godot.has_provider('documentOnTypeFormattingProvider')
    assert godot.formatting(DOG) == []
    assert godot.range_formatting(DOG, 1, 1, 1, 1) == []
    assert godot.on_type_formatting(DOG, 1, 1, '\n') == []
    assert godot.code_lens(DOG) == []


def _fake_godot(tmp_path: Path) -> tuple[Path, Path]:
    """A stand-in engine that records being run. Returns ``(executable, marker)``."""

    marker = tmp_path / 'godot-was-run'
    if os.name == 'nt':
        script = tmp_path / 'fake-godot.cmd'
        script.write_text(f'@echo ran> "{marker}"\r\n', encoding='utf-8')
    else:
        script = tmp_path / 'fake-godot'
        script.write_text(f'#!/bin/sh\necho ran > "{marker}"\n', encoding='utf-8')
        script.chmod(0o755)
    return script, marker


def test_opening_a_script_does_not_run_a_discoverable_godot(
    godot: SessionWorkspaceLspManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """gdls's dump runs the engine on the project, which can load its native libraries."""

    executable, marker = _fake_godot(tmp_path)
    monkeypatch.delenv('CLARA_GODOT_BINARY', raising=False)
    monkeypatch.setenv('GODOT', str(executable))
    godot.sync_workspace_document(DOG)
    assert godot.lifecycle_phase() in {'running', 'indexing'}
    # Long enough for the background dump, which the opt-in test below sees start well within this.
    time.sleep(3.0)
    assert not marker.exists()


def test_naming_an_engine_opts_in_to_the_dump(
    godot: SessionWorkspaceLspManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The control for the test above: it shows this stand-in can detect a spawn at all."""

    executable, marker = _fake_godot(tmp_path)
    monkeypatch.setenv('CLARA_GODOT_BINARY', str(executable))
    godot.sync_workspace_document(DOG)
    assert _wait_for(marker.exists, timeout_s=3.0)


def test_diagnostics_are_pushed_for_a_warning(godot: SessionWorkspaceLspManager) -> None:
    diagnostics = godot.sync_workspace_document(DOG)
    assert any(d.get('code') == 'UNUSED_VARIABLE' for d in diagnostics), diagnostics


def test_diagnostics_are_published_for_a_clean_file_too(godot: SessionWorkspaceLspManager) -> None:
    """``GdscriptLspPlugin`` relies on this: a clean file doesn't sit out the wait for a publish."""

    assert godot.sync_workspace_document('scripts/bone.gd') == []
    assert godot.diagnostics_fresh('scripts/bone.gd')


def test_hover_definition_references(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    line, character = _position_of(godot, DOG, 'move(0.5)')
    hover = godot.hover(DOG, line, character)
    assert 'move' in str(hover.get('contents'))
    definition = godot.definition(DOG, line, character)
    assert ANIMAL.replace('/', '') in str(definition).replace('/', '')
    refs = godot.references(ANIMAL, *_position_of(godot, ANIMAL, 'func move', offset=5), include_declaration=True)
    assert any('dog.gd' in str(r.get('uri')) for r in refs)


def test_definition_of_an_engine_class_is_a_read_only_page(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    line, character = _position_of(godot, ANIMAL, 'Node2D')
    from clara_coder_backend.lsp.editor_monaco import serialize_locations_payload

    rows = serialize_locations_payload(godot, godot.definition(ANIMAL, line, character))
    assert rows, 'gdls should resolve Node2D to a generated page'
    assert rows[0].get('externalPath'), rows[0]
    assert Path(rows[0]['externalPath']).is_file()


def test_implementation_and_hierarchies(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    godot.sync_workspace_document(DOG)
    speak = _position_of(godot, ANIMAL, 'func speak', offset=5)
    implementations = run_editor_feature(
        godot, ANIMAL, 'implementation', {'line': speak[0], 'character': speak[1]}
    )['locations']
    assert any(row['relativePath'] == DOG for row in implementations), implementations

    callers = run_editor_feature(
        godot, ANIMAL, 'callHierarchy', {'line': speak[0], 'character': speak[1], 'direction': 'incoming'}
    )['locations']
    assert callers, 'say_it calls speak'
    assert all(row['name'] for row in callers)
    say_it = _position_of(godot, ANIMAL, 'func say_it', offset=5)
    callees = run_editor_feature(
        godot, ANIMAL, 'callHierarchy', {'line': say_it[0], 'character': say_it[1], 'direction': 'outgoing'}
    )['locations']
    assert any(row['name'] == 'speak' for row in callees), callees

    animal = _position_of(godot, ANIMAL, 'class_name Animal', offset=11)
    subtypes = run_editor_feature(
        godot, ANIMAL, 'typeHierarchy', {'line': animal[0], 'character': animal[1], 'direction': 'subtypes'}
    )['locations']
    assert any(row['name'] == 'Dog' for row in subtypes), subtypes
    dog = _position_of(godot, DOG, 'class_name Dog', offset=11)
    supertypes = run_editor_feature(
        godot, DOG, 'typeHierarchy', {'line': dog[0], 'character': dog[1], 'direction': 'supertypes'}
    )['locations']
    assert any(row['name'] == 'Animal' for row in supertypes), supertypes


def test_workspace_symbols(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    rows = _wait_for(lambda: workspace_symbols(godot, 'Animal'))
    assert any(row['name'] == 'Animal' and row['relativePath'] == ANIMAL for row in rows), rows


def test_document_features(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    folds = run_editor_feature(godot, ANIMAL, 'foldingRanges', {})['ranges']
    assert any(fold.get('kind') == 'region' for fold in folds), folds

    position = _position_of(godot, ANIMAL, 'SPEED * delta')
    chains = run_editor_feature(
        godot, ANIMAL, 'selectionRanges', {'positions': [{'lineNumber': position[0], 'column': position[1]}]}
    )['selections']
    assert len(chains) == 1
    assert len(chains[0]) > 1, 'the selection should grow through enclosing nodes'

    colors = run_editor_feature(godot, ANIMAL, 'documentColors', {})['colors']
    assert colors, 'the Color("#ff8800") literal is a document color'
    wire_range = colors[0]['range']
    presentations = run_editor_feature(
        godot,
        ANIMAL,
        'colorPresentations',
        {
            'color': colors[0]['color'],
            'start_line': wire_range['startLineNumber'],
            'start_character': wire_range['startColumn'],
            'end_line': wire_range['endLineNumber'],
            'end_character': wire_range['endColumn'],
        },
    )['presentations']
    assert presentations and presentations[0]['label']


def test_document_links_point_into_the_workspace(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    links = run_editor_feature(godot, DOG, 'documentLinks', {})['links']
    assert any(link.get('relativePath') == 'scripts/bone.gd' for link in links), links


def test_semantic_tokens_full_delta_and_range(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    full = godot.semantic_tokens_full(DOG)
    assert full.get('data'), full
    if full.get('resultId'):
        delta = godot.semantic_tokens_full_delta(DOG, full['resultId'])
        assert 'edits' in delta or 'data' in delta
    payload = run_editor_feature(
        godot, DOG, 'semanticTokensRange', {'start_line': 1, 'start_character': 1, 'end_line': 8, 'end_character': 1}
    )['payload']
    assert payload['data']


def test_inlay_hint_resolve(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    from clara_coder_backend.lsp.editor_monaco import serialize_inlay_hints_payload

    hints = serialize_inlay_hints_payload(godot.inlay_hints(DOG, 1, 1, 20, 1))
    assert hints, 'the := declarations carry inferred type hints'
    # We advertise ``inlayHint.resolveSupport``, so gdls leaves the tooltip for resolve.
    resolvable = next(h for h in hints if h.get('lspHint'))
    assert 'tooltip' not in resolvable
    resolved = run_editor_feature(godot, DOG, 'inlayHintResolve', {'hint': resolvable['lspHint']})['hint']
    assert resolved is not None
    assert resolved['label'] == resolvable['label']
    assert resolved['tooltip']


def test_prepare_rename_and_multi_file_rename(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    godot.sync_workspace_document(DOG)
    line, character = _position_of(godot, ANIMAL, 'func move', offset=5)
    prepared = run_editor_feature(godot, ANIMAL, 'prepareRename', {'line': line, 'character': character})
    assert prepared['range'] is not None
    assert prepared['placeholder'] == 'move'

    from clara_coder_backend.lsp.editor_monaco import serialize_rename_workspace_edit

    edit = serialize_rename_workspace_edit(godot, godot.rename(ANIMAL, line, character, 'walk'))
    assert set(edit['changes']) >= {ANIMAL, DOG}, edit
    # We don't advertise ``documentChanges``, so this is the plain shape our serializer handles.
    assert all(row['newText'] == 'walk' for rows in edit['changes'].values() for row in rows)


def test_prepare_rename_refuses_an_engine_symbol(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    line, character = _position_of(godot, ANIMAL, 'Node2D')
    try:
        prepared = run_editor_feature(godot, ANIMAL, 'prepareRename', {'line': line, 'character': character})
    except RuntimeError:
        return
    assert prepared['range'] is None


def test_code_action_edit_is_computed_eagerly(godot: SessionWorkspaceLspManager) -> None:
    from clara_coder_backend.lsp.editor_monaco import serialize_code_actions_payload

    diagnostics = godot.sync_workspace_document(DOG)
    target = next(d for d in diagnostics if d.get('code') == 'UNUSED_VARIABLE')
    actions = serialize_code_actions_payload(
        godot,
        godot.code_action(
            DOG,
            target['line'],
            target['character'],
            target.get('end_line', target['line']),
            target.get('end_character', target['character']),
            [target],
        ),
    )
    assert actions, 'gdls offers a fix for an unused variable'
    assert any(action.get('edit') for action in actions), actions


def test_will_rename_rewrites_preload_paths(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    changes = _wait_for(lambda: file_rename_edits(godot, [('scripts/bone.gd', 'scripts/skeleton.gd')]))
    assert DOG in changes, changes
    assert any('skeleton.gd' in row['newText'] for row in changes[DOG])
    godot.did_rename_files([('scripts/bone.gd', 'scripts/skeleton.gd')])


def test_scene_node_completion_comes_from_the_scene_index(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(DOG)
    from clara_coder_backend.lsp.editor_monaco import serialize_completion_result

    line, character = _position_of(godot, DOG, '$Tag', offset=1)
    result = serialize_completion_result(godot, godot.completion(DOG, line, character, trigger_kind=2, trigger_character='$'))
    assert any(item['label'] == 'Tag' for item in result['items']), result['items'][:10]


def test_agent_tools(godot: SessionWorkspaceLspManager) -> None:
    from clara_coder_backend.tools.lsp_tools import (
        lsp_call_hierarchy,
        lsp_find_implementations,
        lsp_type_hierarchy,
        lsp_workspace_symbols,
    )

    speak_line, speak_col = _position_of(godot, ANIMAL, 'func speak', offset=5)
    position = {'relative_path': ANIMAL, 'line': speak_line, 'character': speak_col}

    assert DOG in lsp_find_implementations.invoke(position)
    assert 'say_it' in lsp_call_hierarchy.invoke({**position, 'direction': 'incoming'})

    say_line, say_col = _position_of(godot, ANIMAL, 'func say_it', offset=5)
    callees = lsp_call_hierarchy.invoke(
        {'relative_path': ANIMAL, 'line': say_line, 'character': say_col, 'direction': 'outgoing'}
    )
    assert 'speak' in callees

    class_line, class_col = _position_of(godot, ANIMAL, 'class_name Animal', offset=11)
    subtypes = lsp_type_hierarchy.invoke(
        {'relative_path': ANIMAL, 'line': class_line, 'character': class_col, 'direction': 'subtypes'}
    )
    assert 'Dog' in subtypes

    found = _wait_for(lambda: ANIMAL in lsp_workspace_symbols.invoke({'relative_path': DOG, 'query': 'Animal'}))
    assert found


def test_completion_keeps_engine_classes_past_the_default_limit(godot: SessionWorkspaceLspManager) -> None:
    """gdls doesn't filter by the typed prefix, so a truncated list could never offer these."""

    godot.sync_workspace_document(DOG)
    from clara_coder_backend.lsp.editor_monaco import DEFAULT_COMPLETION_ITEM_LIMIT, serialize_completion_result

    line, character = _position_of(godot, DOG, 'move(0.5)', offset=1)
    raw = godot.completion(DOG, line, character)
    labels = [item['label'] for item in serialize_completion_result(godot, raw)['items']]
    assert len(labels) > DEFAULT_COMPLETION_ITEM_LIMIT
    assert 'Timer' in labels
    assert 'Sprite2D' in labels


def test_engine_pages_land_where_the_read_guard_expects(godot: SessionWorkspaceLspManager) -> None:
    """``read-absolute-file`` allows ``<runtime>/gdls/stubs``, so pages must be under it."""

    godot.sync_workspace_document(ANIMAL)
    from clara_coder_backend.lsp.editor_monaco import serialize_locations_payload
    from clara_coder_backend.runtime.deps.paths import gdls_stub_cache_dir

    rows = serialize_locations_payload(godot, godot.definition(ANIMAL, *_position_of(godot, ANIMAL, 'Node2D')))
    assert Path(rows[0]['externalPath']).resolve().is_relative_to(gdls_stub_cache_dir().resolve())


def test_completion_resolve_fills_documentation(godot: SessionWorkspaceLspManager) -> None:
    godot.sync_workspace_document(ANIMAL)
    from clara_coder_backend.lsp.editor_monaco import serialize_completion_result

    line, character = _position_of(godot, ANIMAL, 'spoke.emit', offset=1)
    result = serialize_completion_result(godot, godot.completion(ANIMAL, line, character))
    assert result['items'], 'identifiers in scope should complete'
    # ``speak`` carries a ``##`` comment in this file.
    speak = next((item for item in result['items'] if item['label'].startswith('speak')), None)
    assert speak is not None, [item['label'] for item in result['items'][:20]]
    assert not speak.get('documentation'), 'documentation is left for resolve'
    resolved = godot.completion_resolve({'label': speak['label'], 'kind': speak['kind'], 'data': speak.get('data')})
    assert resolved.get('label') == speak['label']
    assert 'what this animal says' in str(resolved.get('documentation'))
