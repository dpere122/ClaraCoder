"""Sub-agent roles (Settings, Subagents): binding to a source, tool limits, the spawn tool and the pin.

The end-to-end tests reuse the scripted-model harness of ``test_subagents``.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from langchain_core.messages import AIMessage

from clara_coder_backend.domain import (
    SUBAGENT_TOOL_GROUPS,
    RuntimeConnection,
    RuntimeSubagentRole,
    RuntimeSubagentsConfig,
    SessionState,
)
from clara_coder_backend.hitl.tool_registry import subagent_tool_group, worker_tools_and_map
from clara_coder_backend.lang_agent.subagents import (
    bind_subagent_role,
    parent_subagent_semaphore,
)
from clara_coder_backend.llm.messages import build_system_prompt
from clara_coder_backend.routes.runtime import _runtime_subagents_config
from clara_coder_backend.session import state
from clara_coder_backend.session.schemas import RuntimeSubagentsRequest
from clara_coder_backend.tools.spawn_subagent import bound_spawn_subagent_tool, spawn_subagent_tool
from test_subagents import (  # noqa: F401 (``checkpoints``, ``parent_session``, ``bus`` and ``use_model`` are fixtures)
    ScriptedChatModel,
    _run_turn,
    bus,
    checkpoints,
    parent_session,
    use_model,
)

pytestmark = pytest.mark.asyncio(loop_scope='function')


def _connection(conn_id: str, provider: str = 'openai', **kwargs: Any) -> RuntimeConnection:
    values: dict[str, Any] = {'name': conn_id, 'base_url': 'https://api.example.com/v1', 'model': f'{conn_id}-model'}
    values.update(kwargs)
    return RuntimeConnection(id=conn_id, provider=provider, **values)


def _role(name: str = 'explorer', **kwargs: Any) -> RuntimeSubagentRole:
    return RuntimeSubagentRole(id=name, name=name, **kwargs)


@pytest.fixture()
def sources():
    """Two sources (``main`` active, ``other``) and default sub-agent settings, restored afterwards."""
    cfg = state.runtime_config
    saved = (cfg.connections, cfg.active_connection_id, cfg.subagents)
    cfg.connections = [_connection('main'), _connection('other')]
    cfg.active_connection_id = 'main'
    cfg.subagents = RuntimeSubagentsConfig()
    yield cfg
    cfg.connections, cfg.active_connection_id, cfg.subagents = saved


# ---------------------------------------------------------------------------
# Binding a role to a source
# ---------------------------------------------------------------------------


async def test_no_role_and_a_role_on_the_main_source_pin_nothing(sources) -> None:
    assert bind_subagent_role(None).connection is None
    assert bind_subagent_role(_role()).connection is None
    assert bind_subagent_role(_role(connection_id='main')).connection is None
    # Naming the main source's own model changes nothing either.
    assert bind_subagent_role(_role(model='main-model')).connection is None


async def test_following_the_main_agent_takes_the_conversations_pinned_model_and_thinking(sources) -> None:
    # The parent turn pins its conversation's own model and thinking; the child runs in a blank
    # context, so the binding carries that pin across.
    pin = dataclasses.replace(sources.connections[1], thinking_mode='off')
    token = state.current_connection_override.set(pin)
    try:
        assert bind_subagent_role(None).connection is pin
        assert bind_subagent_role(_role()).connection is pin
        assert bind_subagent_role(_role(connection_id='other')).connection is pin
        # A role on another source still runs there.
        assert bind_subagent_role(_role(connection_id='main')).connection is sources.connections[0]
    finally:
        state.current_connection_override.reset(token)


async def test_a_role_on_another_source_or_model_pins_a_snapshot(sources) -> None:
    other = bind_subagent_role(_role(connection_id='other'))
    assert other.connection is sources.connections[1] and not other.note and not other.error

    sibling = bind_subagent_role(_role(connection_id='main', model='small'))
    assert sibling.connection is not None
    assert (sibling.connection.id, sibling.connection.model) == ('main', 'small')
    assert sources.connections[0].model == 'main-model'
    # A role that follows the main agent takes its model too: the id may belong to another source.
    assert bind_subagent_role(_role(model='small')).connection is None

    both = bind_subagent_role(_role(connection_id='other', model='tiny'))
    assert (both.connection.id, both.connection.model) == ('other', 'tiny')


async def test_a_roles_thinking_setting_pins_a_copy_even_on_the_main_source(sources) -> None:
    sources.connections[0] = _connection('main', thinking_mode='default', reasoning_effort='off')
    sources.connections[1] = _connection('other', reasoning_effort='high')

    off = bind_subagent_role(_role(thinking='off')).connection
    assert off is not None and off is not sources.connections[0]
    assert (off.id, off.thinking_mode, off.thinking_override) == ('main', 'off', 'off')

    on = bind_subagent_role(_role(thinking='on')).connection
    # An effort saved as off would keep thinking off: it is lifted. Any other effort stays.
    assert (on.thinking_mode, on.thinking_override, on.reasoning_effort) == ('on', 'on', 'medium')
    elsewhere = bind_subagent_role(_role(thinking='on', connection_id='other')).connection
    assert (elsewhere.id, elsewhere.thinking_mode, elsewhere.reasoning_effort) == ('other', 'on', 'high')

    # The sources themselves are untouched, and no setting pins nothing.
    assert (sources.connections[0].thinking_mode, sources.connections[0].thinking_override) == ('default', '')
    assert bind_subagent_role(_role()).connection is None


async def test_a_roles_thinking_level_replaces_the_sources_effort(sources) -> None:
    sources.connections[0] = _connection('main', reasoning_effort='high')

    leveled = bind_subagent_role(_role(thinking_level='low')).connection
    # Only the level changes: whether the source thinks at all stays the source's business.
    assert (leveled.id, leveled.reasoning_effort, leveled.thinking_mode, leveled.thinking_override) == (
        'main',
        'low',
        'default',
        '',
    )
    both = bind_subagent_role(_role(thinking='on', thinking_level='xhigh')).connection
    assert (both.thinking_mode, both.reasoning_effort) == ('on', 'xhigh')
    # Off wins: a level means nothing without thinking.
    off = bind_subagent_role(_role(thinking='off', thinking_level='xhigh')).connection
    assert (off.thinking_override, off.reasoning_effort) == ('off', 'high')
    # The source's own level pins nothing.
    assert bind_subagent_role(_role(thinking_level='high')).connection is None
    assert sources.connections[0].reasoning_effort == 'high'


async def test_a_thinking_level_reaches_the_model_client(sources) -> None:
    from clara_coder_backend.llm.factory import build_llm

    sources.connections[0] = _connection('main', provider='lmstudio', base_url='http://127.0.0.1:1234/v1')
    pinned = bind_subagent_role(_role(thinking_level='low')).connection
    token = state.current_connection_override.set(pinned)
    try:
        child = build_llm()
    finally:
        state.current_connection_override.reset(token)

    assert child.reasoning_effort == 'low'
    assert build_llm().reasoning_effort != 'low'


async def test_thinking_still_applies_when_a_role_falls_back_to_the_main_source(sources) -> None:
    binding = bind_subagent_role(_role(thinking='off', connection_id='gone'))
    assert 'no longer in Settings' in binding.note
    assert (binding.connection.id, binding.connection.thinking_override) == ('main', 'off')


async def test_thinking_off_builds_the_client_with_thinking_pinned_off(sources) -> None:
    from clara_coder_backend.llm.factory import build_llm

    sources.connections[0] = _connection('main', provider='lmstudio', base_url='http://127.0.0.1:1234/v1')
    pinned = bind_subagent_role(_role(thinking='off')).connection
    token = state.current_connection_override.set(pinned)
    try:
        child = build_llm()
    finally:
        state.current_connection_override.reset(token)
    parent = build_llm()

    assert child.extra_body['chat_template_kwargs']['enable_thinking'] is False
    assert child.reasoning_effort == 'none'
    assert (parent.extra_body or {}).get('chat_template_kwargs', {}).get('enable_thinking') is not False
    assert parent.reasoning_effort != 'none'


@pytest.mark.parametrize(
    ('change', 'reason'),
    [
        ('removed', 'no longer in Settings'),
        ('no_model', 'no model selected'),
        ('stopped', 'local server is not running'),
    ],
)
async def test_an_unavailable_source_follows_the_fallback_setting(sources, change: str, reason: str) -> None:
    if change == 'removed':
        sources.connections = sources.connections[:1]
    elif change == 'no_model':
        sources.connections[1] = _connection('other', model='')
    else:
        sources.connections[1] = _connection('other', provider='llamacpp', base_url='http://127.0.0.1:0/v1')
    role = _role(connection_id='other')

    fallen_back = bind_subagent_role(role)
    assert fallen_back.connection is None and not fallen_back.error
    assert reason in fallen_back.note and '`explorer`' in fallen_back.note

    sources.subagents.fallback = 'fail'
    failed = bind_subagent_role(role)
    assert failed.connection is None and failed.error.startswith('Tool error:') and reason in failed.error


async def test_each_source_has_its_own_cap(sources) -> None:
    sources.connections[1] = _connection('other', provider='lmstudio', base_url='http://127.0.0.1:1234/v1')
    sources.subagents.cloud_concurrency = 5
    parent = SessionState()

    cloud = parent_subagent_semaphore(parent)
    local = parent_subagent_semaphore(parent, sources.connections[1])
    assert (cloud._value, local._value) == (5, 1)
    assert parent_subagent_semaphore(parent) is cloud
    assert parent_subagent_semaphore(parent, sources.connections[1]) is local

    sources.subagents.cloud_concurrency = 2
    assert parent_subagent_semaphore(parent)._value == 2


# ---------------------------------------------------------------------------
# The spawn tool and a role's tools and prompt
# ---------------------------------------------------------------------------


def _properties(tool: Any) -> set[str]:
    return set(tool.tool_call_schema.model_json_schema()['properties'])


async def test_spawn_tool_lists_enabled_roles_and_never_their_source(sources) -> None:
    assert bound_spawn_subagent_tool() is spawn_subagent_tool
    assert 'role' not in _properties(spawn_subagent_tool)

    sources.subagents.roles = [
        _role(description='Find things.', read_only=True, connection_id='other', model='secret-model'),
        _role('worker', description='Edit things.'),
        _role('off', enabled=False),
    ]
    tool = bound_spawn_subagent_tool()
    assert tool.name == 'spawn_subagent' and 'role' in _properties(tool)
    assert '- `explorer`: Find things. Read-only.' in tool.description
    assert '- `worker`: Edit things.' in tool.description
    assert '`off`' not in tool.description
    assert 'other-model' not in tool.description and 'secret-model' not in tool.description
    # The shared tool object keeps its own description.
    assert 'Roles' not in spawn_subagent_tool.description


async def test_turning_subagents_off_unbinds_their_tools(sources) -> None:
    family = {'spawn_subagent', 'wait_for_subagents', 'stop_subagent'}

    def names() -> set[str]:
        return {t.name for t in worker_tools_and_map(True, session=SessionState(), include_subagent_tool=True)[0]}

    assert family <= names()
    sources.subagents.enabled = False
    assert not family & names()


async def test_tool_groups_cover_every_bound_tool() -> None:
    tools, _ = worker_tools_and_map(True, session=SessionState())
    assert {subagent_tool_group(t.name) for t in tools} <= set(SUBAGENT_TOOL_GROUPS)
    assert subagent_tool_group('read_workspace_file') == 'read'
    assert subagent_tool_group('search_workspace') == 'search'
    assert subagent_tool_group('lsp_hover') == 'lsp'
    assert subagent_tool_group('write_workspace_file') == 'edit'
    assert subagent_tool_group('run_command') == 'commands'
    assert subagent_tool_group('web_search') == 'web'


async def test_a_role_limits_the_childs_tools_to_its_groups() -> None:
    child = SessionState()
    child.subagent_parent_session_id = 'p'
    everything = {t.name for t in worker_tools_and_map(True, session=child)[0]}

    child.subagent_role = _role(tool_groups=frozenset({'read', 'search'}))
    tools, mapping = worker_tools_and_map(True, session=child)
    names = {t.name for t in tools}
    assert {'read_workspace_file', 'search_workspace'} <= names < everything
    assert {subagent_tool_group(name) for name in names} == {'read', 'search'}
    # A tool the role lacks cannot be reached by name either.
    assert set(mapping) == names


async def test_role_adds_its_purpose_and_instructions_to_the_childs_prompt() -> None:
    child = SessionState()
    child.subagent_parent_session_id = 'p'
    child.subagent_name = 'scout'
    child.subagent_role = _role(description='Find things.', read_only=True, instructions='Quote line numbers.')
    prompt = build_system_prompt(child, False)
    assert 'You are a sub-agent** named `scout`' in prompt
    assert 'Your role is `explorer`: Find things.' in prompt
    assert 'This role is read-only' in prompt
    assert 'Quote line numbers.' in prompt


async def test_settings_roles_are_normalised() -> None:
    request = RuntimeSubagentsRequest.model_validate(
        {
            'enabled': True,
            'cloudConcurrency': 4,
            'fallback': 'fail',
            'roles': [
                {'id': 'r1', 'name': '  explorer ', 'connectionId': ' other ', 'tools': ['read', 'bogus'], 'readOnly': True},
                {'id': 'r2', 'name': 'Explorer'},
                {'id': 'r3', 'name': '   '},
                {'id': 'r4', 'name': 'quiet', 'thinking': 'off', 'thinkingLevel': 'low'},
                {'id': 'r5', 'name': 'plain', 'thinking': 'source', 'thinkingLevel': 'ludicrous'},
            ],
        }
    )
    cfg = _runtime_subagents_config(request)
    assert (cfg.enabled, cfg.cloud_concurrency, cfg.fallback) == (True, 4, 'fail')
    assert [(r.id, r.name, r.connection_id, r.read_only, r.tool_groups) for r in cfg.roles[:1]] == [
        ('r1', 'explorer', 'other', True, frozenset({'read'}))
    ]
    assert [(r.name, r.thinking, r.thinking_level) for r in cfg.roles] == [
        ('explorer', '', ''),
        ('quiet', 'off', 'low'),
        ('plain', '', ''),
    ]


# ---------------------------------------------------------------------------
# End to end: the pin reaches the child's turn and nothing else
# ---------------------------------------------------------------------------


class _SourceRecordingModel(ScriptedChatModel):
    """Records the connection each agent's model call resolved (``agent key -> connection id, model``)."""

    sources_seen: dict[str, tuple[str, str]] = {}

    async def _astream(self, messages: list[Any], *args: Any, **kwargs: Any):
        connection = state.get_active_connection()
        self.sources_seen[self.agent_key(messages)] = (connection.id, connection.model)
        async for chunk in super()._astream(messages, *args, **kwargs):
            yield chunk


def _spawn_with_role(call_id: str, name: str, role: str) -> dict[str, Any]:
    return {'name': 'spawn_subagent', 'args': {'task': 'look around', 'name': name, 'role': role}, 'id': call_id}


async def test_a_role_runs_its_child_on_its_source_and_the_parent_stays_on_the_main_one(
    checkpoints, parent_session, bus, use_model, sources
) -> None:
    sid, _parent = parent_session
    sources.subagents.roles = [
        _role(description='Find things.', read_only=True, connection_id='other', model='tiny'),
        _role('worker', description='Edit things.'),
    ]
    model = use_model(
        _SourceRecordingModel(
            scripts={
                'parent': [
                    AIMessage(
                        content='',
                        tool_calls=[_spawn_with_role('s1', 'scout', 'explorer'), _spawn_with_role('s2', 'hands', 'worker')],
                    ),
                    AIMessage(content='Done.'),
                ],
                'scout': [AIMessage(content='Found it.')],
                'hands': [AIMessage(content='Changed it.')],
            },
            sources_seen={},
        )
    )
    await _run_turn(sid, 'go', apply_mode=True)

    assert model.sources_seen == {'parent': ('main', 'main-model'), 'scout': ('other', 'tiny'), 'hands': ('main', 'main-model')}
    assert state.current_connection_override.get() is None
    scout_prompt = str(model.views('scout')[0][0].content)
    assert 'Your role is `explorer`: Find things.' in scout_prompt and 'This role is read-only' in scout_prompt
    reports = [str(m.content) for m in model.views()[-1] if m.type == 'tool']
    assert any('Found it.' in text for text in reports) and any('Changed it.' in text for text in reports)


async def test_an_unknown_role_is_a_tool_error_and_starts_nothing(
    checkpoints, parent_session, bus, use_model, sources
) -> None:
    sid, parent = parent_session
    sources.subagents.roles = [_role(description='Find things.')]
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn_with_role('s1', 'scout', 'wizard')]),
                    AIMessage(content='Fine.'),
                ]
            }
        )
    )
    await _run_turn(sid, 'go', apply_mode=False)

    result = next(str(m.content) for m in model.views()[-1] if m.type == 'tool')
    assert 'no role named `wizard`' in result and '`explorer`' in result
    assert not parent.subagent_children and not bus.started('scout')


async def test_a_fallen_back_role_tells_the_main_agent(checkpoints, parent_session, bus, use_model, sources) -> None:
    sid, _parent = parent_session
    sources.subagents.roles = [_role(description='Find things.', connection_id='gone')]
    model = use_model(
        _SourceRecordingModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn_with_role('s1', 'scout', 'explorer')]),
                    AIMessage(content='Done.'),
                ],
                'scout': [AIMessage(content='Found it.')],
            },
            sources_seen={},
        )
    )
    await _run_turn(sid, 'go', apply_mode=False)

    assert model.sources_seen['scout'] == ('main', 'main-model')
    result = next(str(m.content) for m in model.views()[-1] if m.type == 'tool')
    assert result.startswith('Role `explorer` ran on your own model because its source is no longer in Settings.')
    assert 'Found it.' in result


async def test_the_semantic_index_ignores_a_pin(sources) -> None:
    token = state.current_connection_override.set(dataclasses.replace(sources.connections[1]))
    try:
        assert state.get_active_connection().id == 'other'
        assert state.get_main_connection().id == 'main'
    finally:
        state.current_connection_override.reset(token)
