"""Prefix stability: the frozen workspace tree in the system prompt, and the changes told in its place.

Pushes go through the real ``/workspace-context`` handler. The end-to-end test runs the real Clara graph
and checkpointer with a scripted chat model and reads what each model call was given.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.domain import RuntimeConnection, SessionState
from clara_coder_backend.lang_agent.subagents import fork_subagent_session
from clara_coder_backend.llm.messages import (
    _TREE_SHORTENED_NOTE,
    build_system_prompt,
    compose_outer_turn_human_content,
    frozen_prompt_tree,
    normalize_prompt_tree,
    outer_turn_authority_preamble,
    prompt_tree_paths,
    tree_budget_chars,
    workspace_changes_line,
)
from clara_coder_backend.routes.session import _record_prompt_tree_changes, load_session, set_workspace_context
from clara_coder_backend.session import state
from clara_coder_backend.session.checkpointing import delete_outer_threads_for_session
from clara_coder_backend.session.schemas import LoadRequest, WorkspaceContextRequest

_CHANGES_PREFIX = 'Workspace changes since the tree above: '

# Shapes of ``buildWorkspaceTree`` (src/main/workspace/context-tree.ts).
BARE_TREE = (
    '|-- python/\n'
    '|  |-- clara/\n'
    '|  |  |-- deep/\n'
    '|  |  |  `-- leaf.py\n'
    '|  |  `-- app.py\n'
    '|  `-- setup.py\n'
    '|-- link/\n'
    '|  [symlink skipped]\n'
    '`-- README.md\n'
)


def _watcher_form(tree: str, *, workspace: str = 'C:\\work\\proj', staging_tree: str = '[empty]') -> str:
    """The push of ``buildWatchedContextSnapshot`` (src/main/workspace/watcher.ts)."""
    return '\n'.join(
        [
            f'Workspace tree ({workspace}):',
            tree.rstrip() or '[empty]',
            '',
            'Nested edit staging tree (C:\\data\\staging):',
            staging_tree,
            '',
            'Treat the staging tree as live pending-edit context; files there may not yet exist in the workspace.',
        ]
    )


@pytest.fixture()
def connection(monkeypatch: pytest.MonkeyPatch) -> RuntimeConnection:
    conn = RuntimeConnection(
        id='c',
        name='test',
        provider='openai',
        base_url='http://127.0.0.1:1234/v1',
        model='test-model',
    )
    monkeypatch.setattr('clara_coder_backend.llm.messages.get_active_connection', lambda: conn)
    return conn


@pytest.fixture()
def quiet_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """No background index build or language-server thread from the pushes under test."""
    monkeypatch.setattr('clara_coder_backend.routes.session.embeddings_available', lambda _conn: (False, ''))
    monkeypatch.setattr('clara_coder_backend.routes.session.notify_session_lsp_disk_changes', lambda *a, **k: None)


def _request(
    sid: str,
    workspace: Path | str,
    context: str,
    changes: dict[str, str] | None = None,
    **extra: Any,
) -> WorkspaceContextRequest:
    """A ``/workspace-context`` body; ``changes`` maps path to kind, as the watcher's batch does."""
    return WorkspaceContextRequest(
        session_id=sid,
        workspace_path=str(workspace),
        workspace_context=context,
        workspace_file_changes=(
            {'paths': list(changes), 'kinds': list(changes.values())} if changes is not None else None
        ),
        skip_env_bootstrap=True,
        **extra,
    )


def _push(*args: Any, **kwargs: Any) -> None:
    asyncio.run(set_workspace_context(_request(*args, **kwargs)))


def _frozen_session() -> SessionState:
    return SessionState(
        workspace_path='/ws',
        prompt_tree='|-- frozen.py\n|-- gone.py\n`-- .gitignore',
    )


def _record(sess: SessionState, changes: dict[str, str]) -> None:
    _record_prompt_tree_changes(sess, list(changes), list(changes.values()))


# ---------------------------------------------------------------------------
# Budget and normal form
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('n_ctx', 'chars'),
    [(0, 2000), (8192, 2000), (8334, 2000), (32768, 7864), (65536, 15728), (66667, 16000), (1_000_000, 16000)],
)
def test_tree_budget_is_six_percent_of_the_window_within_its_limits(n_ctx: int, chars: int) -> None:
    assert tree_budget_chars(n_ctx) == chars


def test_bare_and_watcher_forms_give_the_same_bytes() -> None:
    expected = BARE_TREE.rstrip()
    assert normalize_prompt_tree(BARE_TREE, 16000) == expected
    assert normalize_prompt_tree(_watcher_form(BARE_TREE), 16000) == expected
    assert normalize_prompt_tree(_watcher_form(BARE_TREE, staging_tree='`-- draft.py'), 16000) == expected


def test_header_is_stripped_when_the_path_has_parentheses() -> None:
    form = _watcher_form(BARE_TREE, workspace='C:\\Program Files (x86)\\proj (old)')
    assert normalize_prompt_tree(form, 16000) == BARE_TREE.rstrip()


def test_only_a_leading_header_is_a_header() -> None:
    tree = '|-- Workspace tree (x):\n`-- a.py'
    assert normalize_prompt_tree(tree, 16000) == tree


def test_an_empty_workspace_is_empty_in_every_form() -> None:
    assert normalize_prompt_tree('', 16000) == ''
    assert normalize_prompt_tree('\n', 16000) == ''
    assert normalize_prompt_tree(_watcher_form(''), 16000) == ''


def test_a_tree_at_its_budget_is_untouched() -> None:
    tree = BARE_TREE.rstrip()
    assert normalize_prompt_tree(tree, len(tree)) == tree
    assert normalize_prompt_tree(tree, len(tree) - 1).endswith(_TREE_SHORTENED_NOTE)


def _nested_tree() -> str:
    lines: list[str] = []
    for top in range(4):
        lines.append(f'|-- top{top}/')
        for mid in range(4):
            lines.append(f'|  |-- mid{top}{mid}/')
            for low in range(4):
                lines.append(f'|  |  |-- low{top}{mid}{low}.py')
    lines.append('`-- last.md')
    return '\n'.join(lines)


def _size_with_note(lines: list[str]) -> int:
    return sum(len(line) + 1 for line in lines) + len(_TREE_SHORTENED_NOTE)


def test_over_budget_the_deepest_level_goes_first() -> None:
    tree = _nested_tree()
    no_deepest = [line for line in tree.split('\n') if 'low' not in line]
    assert normalize_prompt_tree(tree, _size_with_note(no_deepest)).split('\n') == [*no_deepest, _TREE_SHORTENED_NOTE]


def test_within_a_level_the_last_lines_go_first() -> None:
    lines = _nested_tree().split('\n')
    first_lows = [line for line in lines if 'low' in line][:2]
    kept = [line for line in lines if 'low' not in line or line in first_lows]
    out = normalize_prompt_tree('\n'.join(lines), _size_with_note(kept))
    assert out.split('\n') == [*kept, _TREE_SHORTENED_NOTE]


def test_a_flat_tree_over_budget_keeps_its_head() -> None:
    lines = [f'|-- file{i:03}.py' for i in range(100)]
    out = normalize_prompt_tree('\n'.join(lines), 500)
    assert len(out) <= 500
    *kept, note = out.split('\n')
    assert kept and kept == lines[: len(kept)]
    assert note == _TREE_SHORTENED_NOTE


def test_every_budget_holds_and_no_line_outlives_its_parent() -> None:
    tree = _nested_tree()
    for budget in range(len(_TREE_SHORTENED_NOTE), len(tree), 37):
        out = normalize_prompt_tree(tree, budget)
        assert len(out) <= budget
        kept = out.split('\n')
        for line in kept:
            if found := re.search(r'low(\d\d)', line):
                assert f'|  |-- mid{found[1]}/' in kept
            if found := re.search(r'mid(\d)', line):
                assert f'|-- top{found[1]}/' in kept


# ---------------------------------------------------------------------------
# Freezing
# ---------------------------------------------------------------------------


def test_the_tree_freezes_once(connection: RuntimeConnection) -> None:
    session = SessionState(workspace_path='/ws', workspace_context=BARE_TREE)
    assert frozen_prompt_tree(session) == BARE_TREE.rstrip()
    session.workspace_context = '`-- other.py'
    assert frozen_prompt_tree(session) == BARE_TREE.rstrip()
    assert session.prompt_tree == BARE_TREE.rstrip()


@pytest.mark.parametrize('empty', ['', _watcher_form('')])
def test_an_empty_tree_does_not_freeze(connection: RuntimeConnection, empty: str) -> None:
    session = SessionState(workspace_path='/ws', workspace_context=empty)
    assert frozen_prompt_tree(session) == ''
    assert 'Workspace tree snapshot:\n[empty]' in build_system_prompt(session, False)
    session.workspace_context = BARE_TREE
    assert frozen_prompt_tree(session) == BARE_TREE.rstrip()


def test_the_budget_comes_from_the_connection_window(connection: RuntimeConnection) -> None:
    tree = '\n'.join(f'|-- file{i:04}.py' for i in range(3000))
    connection.context_window_tokens = 8192
    assert 1500 < len(frozen_prompt_tree(SessionState(workspace_path='/ws', workspace_context=tree))) <= 2000
    connection.context_window_tokens = 32768
    assert 7000 < len(frozen_prompt_tree(SessionState(workspace_path='/ws', workspace_context=tree))) <= 7864


def test_an_unknown_window_uses_the_fallback(connection: RuntimeConnection) -> None:
    tree = '\n'.join(f'|-- file{i:04}.py' for i in range(3000))
    connection.context_window_tokens = 0
    assert 15000 < len(frozen_prompt_tree(SessionState(workspace_path='/ws', workspace_context=tree))) <= 16000


def test_a_new_thread_freezes_the_current_tree(connection: RuntimeConnection) -> None:
    session = SessionState(workspace_path='/ws', workspace_context=BARE_TREE)
    frozen_prompt_tree(session)
    session.workspace_context = '`-- other.py'
    _record(session, {'other.py': 'created'})

    state.reset_for_new_thread(session)

    assert frozen_prompt_tree(session) == '`-- other.py'
    assert workspace_changes_line(session) == ''


def test_a_sub_agent_tells_nothing_of_its_parents_changes(connection: RuntimeConnection) -> None:
    parent = SessionState(workspace_path='/ws', workspace_context=BARE_TREE)
    frozen_prompt_tree(parent)
    _record(parent, {'a.py': 'created', 'b.py': 'created'})
    assert workspace_changes_line(parent)
    _record(parent, {'c.py': 'created'})
    try:
        child = fork_subagent_session('p', parent, 'prompt-tree-child', 'scout')
        assert workspace_changes_line(child) == ''
        assert child.prompt_tree_changes_reported == 0
        assert workspace_changes_line(parent) == f'{_CHANGES_PREFIX}+ c.py'
    finally:
        state.sessions.pop('prompt-tree-child', None)


# ---------------------------------------------------------------------------
# The system prompt across pushes
# ---------------------------------------------------------------------------


def test_the_system_prompt_shows_the_tree_without_header_or_staging(connection: RuntimeConnection) -> None:
    session = SessionState(
        workspace_path='C:\\work\\proj',
        workspace_context=_watcher_form(BARE_TREE, staging_tree='`-- draft.py'),
    )
    prompt = build_system_prompt(session, False)
    assert f'Workspace path: C:\\work\\proj\n\nWorkspace tree snapshot:\n{BARE_TREE.rstrip()}' in prompt
    assert 'Nested edit staging tree' not in prompt
    assert 'draft.py' not in prompt
    assert 'Workspace tree (' not in prompt


def test_no_workspace_means_no_tree(connection: RuntimeConnection) -> None:
    session = SessionState(workspace_context=BARE_TREE)
    assert 'No workspace is attached to this conversation.' in build_system_prompt(session, False)
    assert session.prompt_tree == ''


@pytest.mark.parametrize(
    ('first', 'second'),
    [
        (BARE_TREE, _watcher_form(BARE_TREE)),
        (_watcher_form(BARE_TREE), BARE_TREE),
    ],
)
def test_either_sync_form_first_gives_the_same_system_prompt(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path, first: str, second: str
) -> None:
    sid = 'prompt-tree-forms'
    _push(sid, tmp_path, first)
    session = state.get_session(sid)
    prompt = build_system_prompt(session, True)
    _push(sid, tmp_path, second)
    assert build_system_prompt(session, True) == prompt
    state.reset_for_new_thread(session)
    assert build_system_prompt(session, True) == prompt


def test_a_watcher_push_leaves_the_system_prompt_byte_identical(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'prompt-tree-watcher'
    _push(sid, tmp_path, _watcher_form(BARE_TREE))
    session = state.get_session(sid)
    prompt = build_system_prompt(session, True)

    newer = BARE_TREE.replace('`-- README.md', '|-- new.py\n`-- README.md')
    _push(sid, tmp_path, _watcher_form(newer), {'new.py': 'created'})

    assert build_system_prompt(session, True) == prompt
    assert 'new.py' not in prompt
    # The live tree still moves (the next thread freezes it); the change waits for the next turn.
    assert 'new.py' in session.workspace_context
    assert session.prompt_tree_changes == [('created', 'new.py')]


def test_a_new_workspace_path_starts_over(connection: RuntimeConnection, quiet_route: None, tmp_path: Path) -> None:
    sid = 'prompt-tree-move'
    first = tmp_path / 'first'
    second = tmp_path / 'second'
    first.mkdir()
    second.mkdir()
    _push(sid, first, _watcher_form(BARE_TREE))
    session = state.get_session(sid)
    build_system_prompt(session, True)
    _record(session, {'told.py': 'created'})
    assert workspace_changes_line(session)
    _record(session, {'pending.py': 'created'})

    # A batch that arrives with the switch describes the new folder, which has no snapshot yet.
    _push(sid, second, '`-- second.py', {'second.py': 'created'})

    assert session.prompt_tree == ''
    assert session.prompt_tree_changes == []
    assert session.prompt_tree_changes_reported == 0
    assert 'Workspace tree snapshot:\n`-- second.py' in build_system_prompt(session, True)
    assert workspace_changes_line(session) == ''


def test_detaching_the_workspace_drops_the_snapshot(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'prompt-tree-detach'
    _push(sid, tmp_path, BARE_TREE)
    session = state.get_session(sid)
    build_system_prompt(session, True)
    assert session.prompt_tree

    _push(sid, '', '')

    assert session.prompt_tree == ''
    assert 'No workspace is attached' in build_system_prompt(session, True)


def test_a_tree_that_moved_with_no_batch_freezes_again(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'prompt-tree-moved'
    _push(sid, tmp_path, _watcher_form(BARE_TREE))
    session = state.get_session(sid)
    build_system_prompt(session, True)
    _record(session, {'told.py': 'created'})
    assert workspace_changes_line(session)
    _record(session, {'pending.py': 'created'})
    session.activated_context_packs.add('pack')

    # The push says nothing of what moved: the model can only learn it from the tree.
    newer = BARE_TREE.replace('`-- README.md', '`-- away.py')
    _push(sid, tmp_path, newer)

    assert session.prompt_tree == ''
    assert f'Workspace tree snapshot:\n{newer.rstrip()}' in build_system_prompt(session, True)
    assert workspace_changes_line(session) == ''
    assert session.prompt_tree_changes == []
    assert session.prompt_tree_changes_reported == 0
    # The kept thread still holds what its packs put in it.
    assert session.activated_context_packs == {'pack'}


@pytest.mark.parametrize(
    'push',
    [
        pytest.param(BARE_TREE, id='the same tree'),
        pytest.param(_watcher_form(BARE_TREE, staging_tree='`-- draft.py'), id='the same tree with staging'),
        pytest.param('', id='a failed read'),
        pytest.param(_watcher_form(''), id='an empty tree'),
    ],
)
def test_a_push_with_no_batch_that_moves_nothing_keeps_the_frozen_tree(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path, push: str
) -> None:
    sid = 'prompt-tree-same'
    _push(sid, tmp_path, _watcher_form(BARE_TREE))
    session = state.get_session(sid)
    prompt = build_system_prompt(session, True)
    _record(session, {'pending.py': 'created'})

    _push(sid, tmp_path, push)

    assert build_system_prompt(session, True) == prompt
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ pending.py'


# ---------------------------------------------------------------------------
# Recording and telling changes
# ---------------------------------------------------------------------------


def test_nothing_is_recorded_before_the_tree_freezes() -> None:
    session = SessionState(workspace_path='/ws')
    _record(session, {'a.py': 'created'})
    assert session.prompt_tree_changes == []


def test_only_tree_changes_are_recorded() -> None:
    session = _frozen_session()
    _record(
        session,
        {'made.py': 'created', 'gone.py': 'deleted', 'moved.py': 'renamed', 'edited.py': 'updated', 'odd.py': 'unknown'},
    )
    assert session.prompt_tree_changes == [('created', 'made.py'), ('deleted', 'gone.py'), ('renamed', 'moved.py')]


def test_kinds_shorter_than_paths_record_nothing_for_the_rest() -> None:
    session = _frozen_session()
    _record_prompt_tree_changes(session, ['a.py', 'b.py'], ['created'])
    assert session.prompt_tree_changes == [('created', 'a.py')]


def test_staging_git_and_root_paths_are_skipped() -> None:
    session = _frozen_session()
    _record(
        session,
        {
            '[staging] draft.py': 'created',
            '.git': 'created',
            '.git/index': 'created',
            '.git\\HEAD': 'deleted',
            'vendor/lib/.git/config': 'created',
            '.': 'created',
            '': 'created',
            '.github/ci.yml': 'created',
            '.gitignore': 'deleted',
        },
    )
    assert session.prompt_tree_changes == [('created', '.github/ci.yml'), ('deleted', '.gitignore')]


def test_paths_are_workspace_relative_with_forward_slashes() -> None:
    session = _frozen_session()
    _record(session, {'src\\a.py': 'created', '/src/b.py': 'created'})
    assert session.prompt_tree_changes == [('created', 'src/a.py'), ('created', 'src/b.py')]


def test_a_repeated_change_is_kept_and_told_once() -> None:
    session = _frozen_session()
    _record(session, {'a.py': 'created'})
    _record(session, {'a.py': 'created'})
    assert session.prompt_tree_changes == [('created', 'a.py')]
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ a.py'
    # An atomic rewrite looks like another create: not news.
    _record(session, {'a.py': 'created'})
    assert workspace_changes_line(session) == ''


def test_the_latest_kind_of_a_path_wins() -> None:
    session = _frozen_session()
    _record(session, {'a.py': 'created', 'b.py': 'created'})
    _record(session, {'a.py': 'deleted'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ b.py, - a.py'


def test_a_path_that_comes_back_after_being_told_is_told_again() -> None:
    session = _frozen_session()
    _record(session, {'a.py': 'created', 'b.py': 'created'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ a.py, + b.py'
    _record(session, {'a.py': 'deleted'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}- a.py'
    _record(session, {'a.py': 'created'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ a.py'
    # The full record stays for later use, one entry per path.
    assert session.prompt_tree_changes == [('created', 'b.py'), ('created', 'a.py')]


def test_the_cap_keeps_the_newest_and_what_is_left_to_tell() -> None:
    session = _frozen_session()
    for batch in range(12):
        _record(session, {f'b{batch}-{i}.py': 'created' for i in range(20)})
        if batch < 11:
            assert workspace_changes_line(session)

    assert len(session.prompt_tree_changes) == 200
    assert session.prompt_tree_changes[0] == ('created', 'b2-0.py')
    assert session.prompt_tree_changes_reported == 180
    line = workspace_changes_line(session)
    assert line.startswith(f'{_CHANGES_PREFIX}+ b11-0.py, ')
    assert line.endswith('+ b11-19.py')


def test_changes_are_told_once_with_kinds_marked() -> None:
    session = _frozen_session()
    assert workspace_changes_line(session) == ''
    _record(session, {'a.py': 'created', 'gone.py': 'deleted', 'c.py': 'renamed'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ a.py, - gone.py, + c.py'
    assert workspace_changes_line(session) == ''
    _record(session, {'d.py': 'created'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ d.py'
    assert session.prompt_tree_changes_reported == 4


def test_more_changes_than_the_line_names_freeze_the_tree_again() -> None:
    """A build or a checkout: naming twenty of them would leave the tree wrong for the rest of the thread."""
    session = _frozen_session()
    _record(session, {f'f{i:02}.py': 'created' for i in range(21)})
    assert session.prompt_tree == ''
    assert session.prompt_tree_changes == []
    assert workspace_changes_line(session) == ''


def test_exactly_twenty_has_no_remainder() -> None:
    session = _frozen_session()
    _record(session, {f'f{i:02}.py': 'created' for i in range(20)})
    assert 'more' not in workspace_changes_line(session)


def test_the_preamble_carries_the_line_once() -> None:
    session = _frozen_session()
    plain = outer_turn_authority_preamble(session, True)
    assert 'Workspace changes' not in plain

    _record(session, {'a.py': 'created', 'gone.py': 'deleted'})
    with_changes = outer_turn_authority_preamble(session, True)
    assert with_changes == f'{plain}- {_CHANGES_PREFIX}+ a.py, - gone.py\n'

    assert outer_turn_authority_preamble(session, True) == plain


def test_the_user_turn_carries_the_line_ahead_of_the_message() -> None:
    session = _frozen_session()
    _record(session, {'a.py': 'created'})
    turn = compose_outer_turn_human_content(session, True, 'Do the thing')
    assert isinstance(turn, str)
    assert turn.startswith('**Session truth')
    assert turn.endswith(f'- {_CHANGES_PREFIX}+ a.py\n\nDo the thing')


# ---------------------------------------------------------------------------
# Python language server across pushes
# ---------------------------------------------------------------------------


@pytest.fixture()
def interpreter_route(monkeypatch: pytest.MonkeyPatch, quiet_route: None) -> list[str]:
    """Interpreter discovery and env writes stubbed; returns the sessions whose Python LSP was stopped."""
    stops: list[str] = []

    def apply_entry(session: SessionState, _root: Path, entry: dict[str, Any]) -> None:
        session.python_interpreter_choice_id = entry['id']

    monkeypatch.setattr(
        'clara_coder_backend.routes.session.find_interpreter_entry_by_id',
        lambda _root, wanted: {'id': wanted} if wanted != 'unknown' else None,
    )
    monkeypatch.setattr('clara_coder_backend.routes.session.apply_python_interpreter_entry', apply_entry)
    monkeypatch.setattr('clara_coder_backend.routes.session.shutdown_session_python_lsp', stops.append)
    return stops


def test_the_same_interpreter_id_keeps_the_language_server(interpreter_route: list[str], tmp_path: Path) -> None:
    sid = 'prompt-tree-lsp-same'
    _push(sid, tmp_path, BARE_TREE, python_interpreter_id='dot-venv')
    assert interpreter_route == [sid]
    assert state.get_session(sid).python_interpreter_choice_id == 'dot-venv'

    _push(sid, tmp_path, _watcher_form(BARE_TREE), {'a.py': 'updated'}, python_interpreter_id='dot-venv')
    _push(sid, tmp_path, _watcher_form(BARE_TREE), {'b.py': 'updated'}, python_interpreter_id='dot-venv')

    assert interpreter_route == [sid]


def test_a_new_interpreter_id_restarts_the_language_server(interpreter_route: list[str], tmp_path: Path) -> None:
    sid = 'prompt-tree-lsp-new'
    _push(sid, tmp_path, BARE_TREE, python_interpreter_id='dot-venv')
    _push(sid, tmp_path, BARE_TREE, python_interpreter_id='other-venv')
    assert interpreter_route == [sid, sid]
    assert state.get_session(sid).python_interpreter_choice_id == 'other-venv'


def test_an_unknown_interpreter_id_keeps_the_language_server(interpreter_route: list[str], tmp_path: Path) -> None:
    sid = 'prompt-tree-lsp-unknown'
    _push(sid, tmp_path, BARE_TREE, python_interpreter_id='dot-venv')
    _push(sid, tmp_path, BARE_TREE, python_interpreter_id='unknown')
    assert interpreter_route == [sid]
    assert state.get_session(sid).python_interpreter_choice_id == 'dot-venv'


# ---------------------------------------------------------------------------
# End to end: real graph, real checkpointer, scripted model
# ---------------------------------------------------------------------------


class _RecordingChatModel(BaseChatModel):
    """Answers every call with one word; keeps the messages of each call."""

    seen: list[list[Any]] = []

    def bind_tools(self, tools: Any, **_kwargs: Any) -> _RecordingChatModel:
        return self

    @property
    def _llm_type(self) -> str:
        return 'recording'

    def _generate(self, messages: list[Any], stop: Any = None, run_manager: Any = None, **_kwargs: Any) -> ChatResult:
        self.seen.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content='Done.'))])

    async def _astream(
        self, messages: list[Any], stop: Any = None, run_manager: Any = None, **_kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        self.seen.append(list(messages))
        yield ChatGenerationChunk(message=AIMessageChunk(content='Done.'))


@pytest_asyncio.fixture(loop_scope='function')
async def checkpoints(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'prompt-tree.sqlite'))
    from clara_coder_backend.session.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing

    await init_graph_checkpointing()
    yield
    await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_the_model_sees_one_prefix_and_each_change_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, checkpoints: None, quiet_route: None
) -> None:
    model = _RecordingChatModel(seen=[])
    monkeypatch.setattr('clara_coder_backend.lang_agent.graph.build_llm', lambda *a, **k: model)
    monkeypatch.setattr('clara_coder_backend.composer.build_llm', lambda *a, **k: model)
    sid = 'prompt-tree-e2e'
    workspace = tmp_path / 'ws'
    workspace.mkdir()

    async def turn(text: str) -> tuple[str, list[str]]:
        """Run a turn; the system prompt and the Human texts its model call was given."""
        calls_before = len(model.seen)
        async for _line in stream_agent_reply(sid, text, apply_mode=False, user_message_id=text):
            pass
        assert len(model.seen) == calls_before + 1
        messages = model.seen[-1]
        assert isinstance(messages[0], SystemMessage)
        return str(messages[0].content), [str(m.content) for m in messages if isinstance(m, HumanMessage)]

    # Both syncs land before the first turn, in either order.
    await set_workspace_context(_request(sid, workspace, _watcher_form(BARE_TREE)))
    await set_workspace_context(_request(sid, workspace, BARE_TREE))

    system_1, humans_1 = await turn('first')
    assert f'Workspace tree snapshot:\n{BARE_TREE.rstrip()}' in system_1
    assert 'Workspace changes' not in humans_1[-1]

    # The user adds a file and removes another between turns.
    newer = BARE_TREE.replace('`-- README.md', '`-- new.py')
    changes = {'new.py': 'created', 'README.md': 'deleted'}
    await set_workspace_context(_request(sid, workspace, _watcher_form(newer), changes))

    system_2, humans_2 = await turn('second')
    assert system_2 == system_1
    assert humans_2[-1].endswith(f'- {_CHANGES_PREFIX}+ new.py, - README.md\n\nsecond')
    assert humans_2[:-1] == humans_1

    system_3, humans_3 = await turn('third')
    assert system_3 == system_1
    assert humans_3[:-1] == humans_2
    assert 'Workspace changes' not in humans_3[-1]

    # The thread goes away: the next turn has no checkpoint, so it freezes the tree as it is now.
    await delete_outer_threads_for_session(sid)
    await set_workspace_context(_request(sid, workspace, _watcher_form(newer), {'later.py': 'created'}))

    system_4, humans_4 = await turn('fourth')
    assert f'Workspace tree snapshot:\n{newer.rstrip()}' in system_4
    assert 'Workspace changes' not in humans_4[-1]


# ---------------------------------------------------------------------------
# End to end: two conversations on one workspace, only one active
# ---------------------------------------------------------------------------

_TREE = '|-- old.py\n`-- README.md\n'
_TREE_WITH_OWN = '|-- old.py\n|-- own.py\n`-- README.md\n'
_TREE_MOVED = '|-- new_module.py\n`-- README.md\n'
_TREE_MOVED_MORE = '|-- later.py\n|-- new_module.py\n`-- README.md\n'
_MOVED_BATCH = {'new_module.py': 'created', 'old.py': 'deleted'}


def _shows_tree(system: str, tree: str) -> bool:
    return f'Workspace tree snapshot:\n{tree.rstrip()}' in system


class _Conversations:
    """Sends what the app sends. The watcher's batches reach only the active conversation (watcher.ts)."""

    def __init__(self, workspace: Path, model: _RecordingChatModel) -> None:
        self.workspace = workspace
        self.model = model
        self.history: dict[str, list[dict[str, Any]]] = {}

    async def activate(self, sid: str, tree: str) -> None:
        """Opening a conversation: the main process's push and ``/load`` (conversations.ts), then the renderer's."""
        await set_workspace_context(_request(sid, self.workspace, _watcher_form(tree)))
        history = self.history.get(sid, [])
        loaded = await load_session(LoadRequest(session_id=sid, messages=history, keep_matching_checkpoint=True))
        assert bool(loaded.get('kept_checkpoint')) == bool(history)
        await self.renderer_push(sid, tree)

    async def renderer_push(self, sid: str, tree: str) -> None:
        await set_workspace_context(_request(sid, self.workspace, tree))

    async def watcher_batch(self, sid: str, tree: str, changes: dict[str, str]) -> None:
        await set_workspace_context(_request(sid, self.workspace, _watcher_form(tree), changes))

    async def turn(self, sid: str, text: str) -> tuple[str, str]:
        """Run a turn; the system prompt and the last Human text of its model call."""
        async for _line in stream_agent_reply(sid, text, apply_mode=True, user_message_id=text):
            pass
        messages = self.model.seen[-1]
        self.history.setdefault(sid, []).extend(
            [{'role': 'user', 'message': text}, {'role': 'assistant', 'content': 'Done.'}]
        )
        return str(messages[0].content), str(messages[-1].content)


@pytest_asyncio.fixture(loop_scope='function')
async def conversations(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, checkpoints: None, quiet_route: None
) -> _Conversations:
    model = _RecordingChatModel(seen=[])
    monkeypatch.setattr('clara_coder_backend.lang_agent.graph.build_llm', lambda *a, **k: model)
    monkeypatch.setattr('clara_coder_backend.composer.build_llm', lambda *a, **k: model)
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    return _Conversations(workspace, model)


@pytest.mark.asyncio(loop_scope='function')
async def test_a_tree_moved_while_another_conversation_was_active_reaches_the_model(
    conversations: _Conversations,
) -> None:
    await conversations.activate('A', _TREE)
    system_1, _human_1 = await conversations.turn('A', 'first')
    assert _shows_tree(system_1, _TREE)

    await conversations.activate('B', _TREE)
    await conversations.turn('B', 'first')
    await conversations.watcher_batch('B', _TREE_MOVED, _MOVED_BATCH)

    await conversations.activate('A', _TREE_MOVED)
    system_2, human_2 = await conversations.turn('A', 'second')
    assert _shows_tree(system_2, _TREE_MOVED)
    assert 'Workspace changes' not in human_2

    # The new tree is frozen like the first: what moves next is told, and the prefix stays.
    await conversations.watcher_batch('A', _TREE_MOVED_MORE, {'later.py': 'created'})
    system_3, human_3 = await conversations.turn('A', 'third')
    assert system_3 == system_2
    assert human_3.endswith(f'- {_CHANGES_PREFIX}+ later.py\n\nthird')


@pytest.mark.asyncio(loop_scope='function')
async def test_a_return_with_nothing_moved_keeps_the_prefix(conversations: _Conversations) -> None:
    """The frozen tree lags the pushes by design once a change was told: that lag is no reason to freeze again."""
    await conversations.activate('A', _TREE)
    system_1, _human_1 = await conversations.turn('A', 'first')
    await conversations.watcher_batch('A', _TREE_WITH_OWN, {'own.py': 'created'})
    system_2, human_2 = await conversations.turn('A', 'second')
    assert system_2 == system_1
    assert human_2.endswith(f'- {_CHANGES_PREFIX}+ own.py\n\nsecond')

    await conversations.activate('B', _TREE_WITH_OWN)
    await conversations.turn('B', 'first')
    await conversations.activate('A', _TREE_WITH_OWN)

    system_3, human_3 = await conversations.turn('A', 'third')
    assert system_3 == system_1
    assert 'Workspace changes' not in human_3


@pytest.mark.asyncio(loop_scope='function')
async def test_a_change_not_told_yet_is_still_told_after_a_return(conversations: _Conversations) -> None:
    await conversations.activate('A', _TREE)
    system_1, _human_1 = await conversations.turn('A', 'first')
    await conversations.watcher_batch('A', _TREE_WITH_OWN, {'own.py': 'created'})

    await conversations.activate('B', _TREE_WITH_OWN)
    await conversations.activate('A', _TREE_WITH_OWN)

    system_2, human_2 = await conversations.turn('A', 'second')
    assert system_2 == system_1
    assert human_2.endswith(f'- {_CHANGES_PREFIX}+ own.py\n\nsecond')
    _system_3, human_3 = await conversations.turn('A', 'third')
    assert 'Workspace changes' not in human_3


@pytest.mark.asyncio(loop_scope='function')
async def test_a_return_that_skips_the_activation_push_still_reaches_the_model(conversations: _Conversations) -> None:
    """A stream was live on A, so the main process sends nothing (conversations.ts); the renderer still pushes."""
    await conversations.activate('A', _TREE)
    await conversations.turn('A', 'first')
    await conversations.activate('B', _TREE)
    await conversations.watcher_batch('B', _TREE_MOVED, _MOVED_BATCH)

    await conversations.renderer_push('A', _TREE_MOVED)

    system_2, _human_2 = await conversations.turn('A', 'second')
    assert _shows_tree(system_2, _TREE_MOVED)


# ---------------------------------------------------------------------------
# What the tree already agrees with, and pushes that move it quietly
# ---------------------------------------------------------------------------


def test_a_tree_lists_its_paths_with_their_folders() -> None:
    assert prompt_tree_paths(BARE_TREE) == {
        'python',
        'python/clara',
        'python/clara/deep',
        'python/clara/deep/leaf.py',
        'python/clara/app.py',
        'python/setup.py',
        'link',
        'README.md',
    }
    assert prompt_tree_paths('|-- run [symlink]\n`-- a.py\n' + _TREE_SHORTENED_NOTE) == {'run', 'a.py'}


def test_an_atomic_save_of_a_listed_file_is_no_change() -> None:
    """Agent edits are a temp file and a replace, which ``fs.watch`` reports as created."""
    session = SessionState(workspace_path='/ws', prompt_tree=BARE_TREE)
    _record(session, {'python/setup.py': 'created'})
    assert session.prompt_tree_changes == []
    assert workspace_changes_line(session) == ''


def test_a_file_the_tree_never_listed_going_away_is_no_change() -> None:
    session = SessionState(workspace_path='/ws', prompt_tree=BARE_TREE)
    _record(session, {'scratch.py': 'deleted'})
    assert session.prompt_tree_changes == []


def test_a_listed_file_deleted_and_made_again_is_told_both_times() -> None:
    session = SessionState(workspace_path='/ws', prompt_tree=BARE_TREE)
    _record(session, {'README.md': 'deleted'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}- README.md'
    _record(session, {'README.md': 'created'})
    assert workspace_changes_line(session) == f'{_CHANGES_PREFIX}+ README.md'


def test_a_gitignore_edit_that_moves_the_tree_freezes_it_again(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'gitignore-moves'
    _push(sid, tmp_path, BARE_TREE)
    session = state.get_session(sid)
    assert frozen_prompt_tree(session) == BARE_TREE.rstrip()

    moved = BARE_TREE.replace('`-- README.md', '|-- docs/\n`-- README.md')
    _push(sid, tmp_path, moved, {'.gitignore': 'updated'})

    assert frozen_prompt_tree(session) == moved.rstrip()


def test_an_edit_batch_with_the_same_tree_keeps_it(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'edit-keeps'
    _push(sid, tmp_path, BARE_TREE)
    session = state.get_session(sid)
    frozen_prompt_tree(session)
    session.prompt_tree = 'unchanged marker'

    _push(sid, tmp_path, BARE_TREE, {'README.md': 'updated'})

    assert session.prompt_tree == 'unchanged marker'


def test_an_empty_push_does_not_make_the_same_tree_a_move(
    connection: RuntimeConnection, quiet_route: None, tmp_path: Path
) -> None:
    sid = 'empty-push'
    _push(sid, tmp_path, BARE_TREE)
    session = state.get_session(sid)
    frozen_prompt_tree(session)
    session.prompt_tree = 'unchanged marker'

    _push(sid, tmp_path, '')
    _push(sid, tmp_path, BARE_TREE)

    assert session.prompt_tree == 'unchanged marker'


@pytest.mark.asyncio(loop_scope='function')
async def test_a_kept_thread_gets_the_tree_as_it_is_now(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, checkpoints: None, quiet_route: None
) -> None:
    """A second plan runs on threads the first one kept; what was told since went to another thread."""
    model = _RecordingChatModel(seen=[])
    monkeypatch.setattr('clara_coder_backend.lang_agent.graph.build_llm', lambda *a, **k: model)
    monkeypatch.setattr('clara_coder_backend.composer.build_llm', lambda *a, **k: model)
    sid = 'kept-thread'
    workspace = tmp_path / 'ws'
    workspace.mkdir()

    async def turn(text: str, *, apply_mode: bool) -> str:
        async for _line in stream_agent_reply(sid, text, apply_mode=apply_mode, user_message_id=text):
            pass
        return str(model.seen[-1][0].content)

    await set_workspace_context(_request(sid, workspace, _watcher_form(BARE_TREE)))
    await turn('read one', apply_mode=False)
    await turn('edit one', apply_mode=True)

    newer = BARE_TREE.replace('`-- README.md', '`-- new.py')
    await set_workspace_context(
        _request(sid, workspace, _watcher_form(newer), {'new.py': 'created', 'README.md': 'deleted'})
    )
    await turn('edit two', apply_mode=True)
    system = await turn('read two', apply_mode=False)

    assert f'Workspace tree snapshot:\n{newer.rstrip()}' in system
