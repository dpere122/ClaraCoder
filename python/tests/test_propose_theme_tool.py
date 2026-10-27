"""``propose_theme`` agent tool: registry-backed validation and non-blocking SSE delivery."""

from __future__ import annotations

import asyncio

import pytest

from clara_coder_backend.hitl.tool_registry import worker_tools_and_map
from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState, sse_lines_for_graph_event
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.theme import (
    PROPOSE_THEME_NAME,
    load_theme_registry,
    propose_theme_tool,
    theme_registry_summary,
    validate_theme_proposal,
)


def test_registry_loads_groups_and_tokens() -> None:
    reg = load_theme_registry()
    ids = {g['id'] for g in reg['groups']}
    assert 'chat.transcript' in ids
    assert 'editor.monaco' in ids
    names = {t['name'] for t in reg['tokens']}
    assert '--t-primary' in names
    assert '--t-hljs-keyword' in names
    summary = theme_registry_summary()
    assert 'chat.transcript (bg)' in summary
    assert '--t-primary' in summary
    # Alias tokens are omitted from the agent-facing summary.
    assert '--t-warn' not in summary


def test_validate_drops_unknown_tokens_groups_and_unsafe_values() -> None:
    doc, warnings = validate_theme_proposal(
        {
            'name': 'Neon Nights!',
            'mode': 'dark',
            'tokens': {
                '--t-primary': '#ff00ff',
                '--t-nope': '#000',
                '--t-bg': 'red; } body { display:none',
            },
            'groups': {
                'chat.transcript': {'css': '.a { color: red }', 'background': {'opacity': 40, 'fit': 'tile'}},
                'chat.composer': {'background': {'opacity': 0.5}},
                'nope.group': {'css': '.x{}'},
            },
            'assets': {'wall': 'data:image/png;base64,AAAA'},
        }
    )
    assert doc is not None
    assert doc['id'] == 'neon-nights'
    assert doc['name'] == 'Neon Nights!'
    assert doc['tokens'] == {'--t-primary': '#ff00ff'}
    assert set(doc['groups']) == {'chat.transcript'}
    bg = doc['groups']['chat.transcript']['background']
    assert bg == {'enabled': False, 'asset': '', 'opacity': 0.4, 'fit': 'tile'}
    assert 'assets' not in doc
    assert doc['author'] == 'Clara'
    joined = '\n'.join(warnings)
    assert 'tokens.--t-nope' in joined
    assert 'tokens.--t-bg' in joined
    assert 'groups.nope.group' in joined
    assert 'does not support background' in joined
    assert 'assets: dropped' in joined


def test_summary_lists_real_class_names_per_group() -> None:
    reg = load_theme_registry()
    composer = next(g for g in reg['groups'] if g['id'] == 'chat.composer')
    assert 'composer-stack' in composer['classes']
    summary = theme_registry_summary()
    assert '- chat.composer: .composer-stack' in summary


def test_css_notes_flag_unknown_classes_remote_urls_and_misplaced_css() -> None:
    doc, warnings = validate_theme_proposal(
        {
            'name': 'Notes',
            'css': '.composer-stack { color: red }',
            'groups': {
                'chat.composer': {
                    'css': (
                        '& { border-radius: 0 } .composer-stack { padding: 0; &:hover { opacity: 1 } } '
                        '.made-up-input, .also-fake { color: red } '
                        '.composer-stack::after { content: ".not-a-class"; background: url(https://x.example/a.png) } '
                        '@media (min-width: 0.5em) { .composer-stack { gap: 0 } }'
                    )
                },
            },
        }
    )
    assert doc is not None
    # Notes never change the css; the renderer sanitizer is the source of truth.
    assert doc['groups']['chat.composer']['css'].startswith('& { border-radius: 0 }')
    joined = '\n'.join(warnings)
    assert '.made-up-input, .also-fake not found' in joined
    assert '.not-a-class' not in joined
    assert '.composer-stack not found' not in joined
    assert 'remote url()' in joined
    assert 'css: dropped; advanced CSS goes per group' in joined


def test_validate_rejects_non_objects_and_bad_versions() -> None:
    assert validate_theme_proposal('not json')[0] is None
    assert validate_theme_proposal(42)[0] is None
    assert validate_theme_proposal({'version': 2, 'name': 'x'})[0] is None
    assert validate_theme_proposal({})[0] is None
    parsed, _ = validate_theme_proposal('{"name": "From String", "mode": "light"}')
    assert parsed is not None and parsed['mode'] == 'light'


def test_validate_normalizes_monaco_block() -> None:
    doc, warnings = validate_theme_proposal(
        {
            'name': 'M',
            'monaco': {
                'base': 'hc-black',
                'colors': {'editor.background': '#123', 'bad key!': '#000000', 'editor.foreground': 'red'},
                'rules': [{'token': 'comment', 'foreground': '#AABBCC', 'fontStyle': 'italic'}, {'token': 'bad token!'}, 'x'],
            },
        }
    )
    assert doc is not None
    assert doc['monaco'] == {
        'base': 'hc-black',
        'colors': {'editor.background': '#112233'},
        'rules': [{'token': 'comment', 'foreground': 'aabbcc', 'fontStyle': 'italic'}],
    }
    assert any('bad key!' in w for w in warnings)


def test_monaco_base_follows_mode_and_empty_block_is_dropped() -> None:
    light, _ = validate_theme_proposal({'name': 'L', 'mode': 'light', 'monaco': {'colors': {'editor.background': '#fff'}}})
    assert light is not None and light['monaco']['base'] == 'vs'
    dark, _ = validate_theme_proposal({'name': 'D', 'mode': 'dark', 'monaco': {'colors': {'editor.background': '#000'}}})
    assert dark is not None and dark['monaco']['base'] == 'vs-dark'
    empty, warnings = validate_theme_proposal({'name': 'E', 'mode': 'light', 'monaco': {}})
    assert empty is not None and 'monaco' not in empty
    assert any(w.startswith('monaco: empty') for w in warnings)


def test_opacity_percent_heuristic_only_applies_to_whole_numbers() -> None:
    doc, _ = validate_theme_proposal(
        {
            'name': 'O',
            'groups': {
                'chat.transcript': {'background': {'opacity': 60}},
                'editor.monaco': {'background': {'opacity': 1.5}},
            },
        }
    )
    assert doc is not None
    assert doc['groups']['chat.transcript']['background']['opacity'] == 0.6
    assert doc['groups']['editor.monaco']['background']['opacity'] == 1.0


def test_tool_is_bound_for_the_outer_agent() -> None:
    tools, mapping = worker_tools_and_map(False)
    assert PROPOSE_THEME_NAME in mapping
    assert any(t.name == PROPOSE_THEME_NAME for t in tools)


@pytest.mark.asyncio
async def test_tool_emits_theme_proposal_event_without_pausing() -> None:
    sid = 'propose-theme-ok'
    token = current_session_id.set(sid)
    session = get_session(sid)
    queue: asyncio.Queue = asyncio.Queue()
    session.planning_nested_events_q = queue
    try:
        out = await propose_theme_tool.ainvoke(
            {'theme': {'name': 'Ocean', 'mode': 'dark', 'tokens': {'--t-primary': '#00aaff'}}, 'summary': 'Cool blues.'}
        )
    finally:
        session.planning_nested_events_q = None
        current_session_id.reset(token)

    assert 'Proposed theme "Ocean"' in out
    assert 'preview, save, or dismiss' in out
    stream_tag, event = queue.get_nowait()
    assert stream_tag == 'agent'
    assert event['event'] == 'theme_proposal'
    payload = event['data']
    assert payload['version'] == 1
    assert payload['requestId'].startswith('theme-')
    assert payload['title'] == 'Theme proposal: Ocean'
    assert payload['summary'] == 'Cool blues.'
    assert payload['theme']['tokens'] == {'--t-primary': '#00aaff'}


@pytest.mark.asyncio
async def test_tool_reports_errors_and_missing_stream() -> None:
    sid = 'propose-theme-nostream'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.planning_nested_events_q = None
    try:
        bad = await propose_theme_tool.ainvoke({'theme': {'version': 3}})
        assert bad.startswith('Tool error:')
        no_stream = await propose_theme_tool.ainvoke({'theme': {'name': 'x'}})
        assert 'no live chat stream' in no_stream
    finally:
        current_session_id.reset(token)


def _sse_lines(event: dict) -> list[str]:
    return sse_lines_for_graph_event(
        event,
        GraphStreamState(),
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
    )


def test_nested_event_maps_to_sse_line() -> None:
    payload = {'version': 1, 'requestId': 'theme-abc', 'title': 'Theme proposal: X', 'summary': '', 'theme': {'id': 'x'}}
    lines = _sse_lines({'event': 'theme_proposal', 'data': payload})
    assert len(lines) == 1
    assert 'theme_proposal' in lines[0]
    assert 'themeProposal' in lines[0]
    # Malformed payloads are dropped rather than forwarded.
    assert _sse_lines({'event': 'theme_proposal', 'data': {'requestId': 'x'}}) == []
