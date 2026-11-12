"""End-of-turn verification: mutation bookkeeping, evidence, the after-model gate and the protected checks file.

The end-to-end tests run the real Clara graph with the scripted chat model of ``test_subagents``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from clara_coder_backend.middleware import turn_verification_middleware as tvm
from clara_coder_backend.middleware.plan_pending_steps_middleware import PlanPendingStepsMiddleware
from clara_coder_backend.middleware.turn_verification_middleware import VERIFY_PILL_LABEL, TurnVerificationMiddleware
from clara_coder_backend.plan.build_plan_store import ActionStep, BuildPlanModel, FileChangeEntry, create_build_plan
from clara_coder_backend.plan.build_plan_tools import mark_build_plan_steps_complete
from clara_coder_backend.session import state
from clara_coder_backend.session.file_journal import emit_edit_journal, turn_touched_paths, turn_verify_state
from clara_coder_backend.session.state import current_session_id, runtime_config
from clara_coder_backend.tools.copy import copy_workspace_files
from clara_coder_backend.tools.delete import delete_workspace_entries
from clara_coder_backend.tools.edit import write_workspace_file
from clara_coder_backend.tools.run_command import background_command_jobs, run_harness_command
from clara_coder_backend.verify import evidence
from clara_coder_backend.verify.checks_config import WorkspaceCheck, WorkspaceChecks
from clara_coder_backend.verify.evidence import (
    FEEDBACK_HEADER,
    CheckOutcome,
    DiagnosticsEvidence,
    VerificationResult,
    collect_diagnostics,
    format_feedback,
    gather_evidence,
)
from clara_coder_backend.workspace.trust import trusted_workspace_keys
from test_subagents import (  # noqa: F401 (``checkpoints``, ``parent_session`` and ``use_model`` are fixtures)
    ScriptedChatModel,
    _call,
    _payloads,
    _pill,
    _run_turn,
    checkpoints,
    parent_session,
    use_model,
)

pytestmark = pytest.mark.asyncio(loop_scope='function')

_ERROR = {'severity_value': 1, 'source': 'pyright', 'code': 'E1', 'message': 'x is not defined', 'line': 3, 'character': 1}
_WARNING = {'severity_value': 2, 'source': 'pyright', 'code': 'W1', 'message': 'unused', 'line': 1, 'character': 1}


def _python_command(code: str) -> str:
    """Shell command running ``code`` in this interpreter (``code`` must not contain double quotes)."""
    py = sys.executable.replace('\\', '/')
    return f'"{py}" -c "{code}"'


def _touch(session, rel: str) -> None:
    emit_edit_journal(session, rel, '', before_existed=False, encoding='utf-8', newline='lf')


def _write_checks(workspace: Path, checks: list[dict[str, Any]]) -> None:
    (workspace / '.clara').mkdir(exist_ok=True)
    (workspace / '.clara' / 'checks.json').write_text(json.dumps({'checks': checks}), encoding='utf-8')


@pytest.fixture()
def turn(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """A main session in the middle of editor turn ``t1`` on a trusted temp workspace."""
    sid = 'verify-turn'
    workspace = (tmp_path / 'ws').resolve()
    workspace.mkdir()
    session = state.get_session(sid)
    session.workspace_path = str(workspace)
    session.worker_apply_mode = True
    session.current_user_message_id = 't1'
    session.planning_nested_events_q = asyncio.Queue()
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', trusted_workspace_keys([str(workspace)]))
    token = current_session_id.set(sid)
    yield session, workspace
    current_session_id.reset(token)
    state.sessions.pop(sid, None)


def _pills(session) -> list[dict[str, Any]]:
    out = []
    queue = session.planning_nested_events_q
    while not queue.empty():
        _tag, event = queue.get_nowait()
        status = event['data'].get('status') or {}
        if status.get('label') == VERIFY_PILL_LABEL:
            out.append(status)
    return out


def _failing(name: str = 'tests') -> VerificationResult:
    check = WorkspaceCheck(name, 'npm test')
    return VerificationResult(checks=[CheckOutcome(check, False, reason='exit code 1', output='1 failed')])


def _passing() -> VerificationResult:
    return VerificationResult(diagnostics=DiagnosticsEvidence(checked_paths=1))


class _Gather:
    """Stands in for ``gather_evidence``: returns the queued results in order and counts the calls."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *results: VerificationResult | Exception) -> None:
        self.results = list(results)
        self.calls: list[dict[str, Any]] = []
        monkeypatch.setattr(tvm, 'gather_evidence', self)

    async def __call__(self, session_id: str, root: Path, **kwargs: Any) -> VerificationResult:
        self.calls.append(kwargs)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


async def _finish(*earlier: Any, text: str = 'Done.') -> dict[str, Any] | None:
    messages = [HumanMessage(content='do it'), *earlier, AIMessage(content=text)]
    return await TurnVerificationMiddleware().aafter_model({'messages': messages}, MagicMock())


# ---------------------------------------------------------------------------
# Journal bookkeeping
# ---------------------------------------------------------------------------


async def test_every_mutation_counts_and_the_first_keeps_the_errors_the_file_had(turn) -> None:
    session, _workspace = turn
    session.lsp.lsp_diagnostics_by_scope['workspace']['b.py'] = [_ERROR, _WARNING]

    _touch(session, 'a.py')
    _touch(session, 'a.py')
    _touch(session, 'b.py')

    verify = turn_verify_state(session.edits, 't1')
    assert verify.mutations == 3
    assert verify.baseline_errors == {'b.py': ['pyright|E1|x is not defined']}
    assert turn_touched_paths(session) == ['a.py', 'b.py']


async def test_touched_paths_survive_an_older_turns_sub_agent_journaling_in_between(turn) -> None:
    session, _workspace = turn
    _touch(session, 'a.py')
    session.current_user_message_id = 't0'
    _touch(session, 'old.py')
    session.current_user_message_id = 't1'

    assert turn_touched_paths(session) == ['a.py']
    assert turn_verify_state(session.edits, 't1').mutations == 1
    assert turn_verify_state(session.edits, 't0').mutations == 1


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


async def test_diagnostics_report_only_errors_the_file_did_not_have(turn, monkeypatch: pytest.MonkeyPatch) -> None:
    _session, workspace = turn
    for name in ('a.py', 'b.py', 'notes.txt'):
        (workspace / name).write_text('x\n', encoding='utf-8')
    second = {**_ERROR, 'message': 'y is not defined', 'line': 9}
    rows = {'a.py': [_ERROR, second, _WARNING], 'b.py': [_ERROR]}
    synced: list[str] = []

    def fake_sync(session_id: str, server: str, rel: str, encoding: str):
        synced.append(rel)
        return rows[rel], True, ''

    monkeypatch.setattr(evidence, '_sync_path', fake_sync)
    found = await collect_diagnostics(
        'verify-turn',
        workspace,
        ['a.py', 'b.py', 'gone.py', 'notes.txt'],
        {'a.py': ['pyright|E1|x is not defined']},
        asyncio.Event(),
    )

    assert synced == ['a.py', 'b.py']  # a deleted file and a file without a language server are skipped
    assert found.checked_paths == 2 and found.preexisting == 1
    assert found.new_errors == {'a.py': [second], 'b.py': [_ERROR]}


async def test_a_file_the_server_never_opened_keeps_its_pre_edit_text_for_the_baseline(turn) -> None:
    session, _workspace = turn
    session.lsp.lsp_diagnostics_by_scope['workspace']['open.py'] = [_ERROR]

    emit_edit_journal(session, 'unopened.py', 'old text\n', before_existed=True, encoding='utf-8', newline='lf')
    emit_edit_journal(session, 'unopened.py', 'newer\n', before_existed=True, encoding='utf-8', newline='lf')
    emit_edit_journal(session, 'open.py', 'old\n', before_existed=True, encoding='utf-8', newline='lf')
    emit_edit_journal(session, 'notes.txt', 'old\n', before_existed=True, encoding='utf-8', newline='lf')
    _touch(session, 'new.py')

    verify = turn_verify_state(session.edits, 't1')
    # Only the first edit's text, only for a server-backed file whose errors were not cached.
    assert verify.baseline_texts == {'unopened.py': 'old text\n'}
    assert verify.baseline_errors == {'open.py': ['pyright|E1|x is not defined']}


async def test_diagnostics_ask_the_server_about_the_pre_edit_text_once(turn, monkeypatch: pytest.MonkeyPatch) -> None:
    _session, workspace = turn
    (workspace / 'a.py').write_text('new\n', encoding='utf-8')
    second = {**_ERROR, 'message': 'y is not defined'}
    asked: list[str] = []

    def fake_baseline(session_id: str, server: str, rel: str, before_text: str) -> list[str]:
        asked.append(before_text)
        return ['pyright|E1|x is not defined']

    monkeypatch.setattr(evidence, '_baseline_keys', fake_baseline)
    monkeypatch.setattr(evidence, '_sync_path', lambda *_args: ([_ERROR, second], True, ''))
    baseline_errors: dict[str, list[str]] = {}
    baseline_texts = {'a.py': 'old\n'}

    for _round in range(2):
        found = await collect_diagnostics(
            'verify-turn', workspace, ['a.py'], baseline_errors, asyncio.Event(), baseline_texts
        )
        assert found.preexisting == 1 and found.new_errors == {'a.py': [second]}

    assert asked == ['old\n']  # the second round reuses the stored baseline
    assert baseline_texts == {} and baseline_errors == {'a.py': ['pyright|E1|x is not defined']}


async def test_a_language_server_that_cannot_start_is_a_note_not_a_failure(turn, monkeypatch) -> None:
    _session, workspace = turn
    (workspace / 'a.py').write_text('x\n', encoding='utf-8')

    def broken(*_args: Any):
        raise RuntimeError('server exited')

    monkeypatch.setattr(evidence, '_sync_path', broken)
    found = await collect_diagnostics('verify-turn', workspace, ['a.py'], {}, asyncio.Event())

    assert found.new_error_count == 0 and found.checked_paths == 0
    assert found.notes == ['no python diagnostics for `a.py`']


async def test_harness_command_reports_exit_code_output_and_timeout(turn) -> None:
    _session, workspace = turn

    passed = await run_harness_command(
        'verify-turn', command=_python_command("print('fine')"), cwd_label='.', cwd=str(workspace), timeout_sec=30
    )
    failed = await run_harness_command(
        'verify-turn',
        command=_python_command("import sys; print('boom'); sys.exit(3)"),
        cwd_label='.',
        cwd=str(workspace),
        timeout_sec=30,
    )
    slow = await run_harness_command(
        'verify-turn',
        command=_python_command('import time; time.sleep(60)'),
        cwd_label='.',
        cwd=str(workspace),
        timeout_sec=1,
    )

    assert passed.passed and 'fine' in passed.output
    assert not failed.passed and failed.exit_code == 3 and 'boom' in failed.output
    assert slow.timed_out and not slow.passed
    assert not [job for job in background_command_jobs().values() if job.session_id == 'verify-turn']


async def test_harness_command_stops_with_the_turn(turn) -> None:
    session, workspace = turn
    stop = asyncio.Event()
    asyncio.get_running_loop().call_later(0.5, stop.set)

    result = await run_harness_command(
        'verify-turn',
        command=_python_command('import time; time.sleep(60)'),
        cwd_label='.',
        cwd=str(workspace),
        timeout_sec=30,
        stop_event=stop,
    )

    assert result.stopped and not result.passed and not result.timed_out


async def test_checks_run_only_in_a_trusted_workspace_and_only_when_their_paths_match(turn, monkeypatch) -> None:
    _session, workspace = turn
    checks = WorkspaceChecks(
        (
            WorkspaceCheck('fails', _python_command("import sys; print('2 tests failed'); sys.exit(1)")),
            WorkspaceCheck('passes', _python_command('pass')),
            WorkspaceCheck('other', _python_command('import sys; sys.exit(9)'), paths=('docs/**',)),
            WorkspaceCheck('off', _python_command('import sys; sys.exit(9)'), enabled=False),
            WorkspaceCheck('nowhere', _python_command('pass'), cwd='missing'),
        ),
        problems=('check 9: `command` is required',),
    )
    args = {'touched_paths': ['src/a.txt'], 'baseline_errors': {}, 'checks': checks, 'stop_event': asyncio.Event()}

    result = await gather_evidence('verify-turn', workspace, **args)

    assert [(o.check.name, o.passed, o.reason) for o in result.checks] == [
        ('fails', False, 'exit code 1'),
        ('passes', True, ''),
        ('nowhere', False, 'folder `missing` does not exist'),
    ]
    assert result.failed
    assert result.summary().startswith('fails failed (exit code 1) · nowhere failed')
    assert '.clara/checks.json: check 9' in result.summary()
    feedback = format_feedback(result, fix_round=1, max_rounds=2)
    assert feedback.startswith(FEEDBACK_HEADER)
    assert 'Check `fails` failed (exit code 1)' in feedback and '2 tests failed' in feedback
    assert 'passes' not in feedback and '(Fix round 1 of 2.)' in feedback

    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', frozenset())
    untrusted = await gather_evidence('verify-turn', workspace, **args)
    assert untrusted.checks == [] and not untrusted.failed
    assert 'checks not run: this workspace is not trusted' in untrusted.notes


async def test_feedback_lists_new_errors(turn) -> None:
    result = VerificationResult(diagnostics=DiagnosticsEvidence(new_errors={'a.py': [_ERROR]}, checked_paths=1))
    feedback = format_feedback(result, fix_round=2, max_rounds=2)
    assert result.failed and result.summary() == '1 new error in 1 file'
    assert 'New errors: LSP diagnostics for `a.py` (1 issue(s)):' in feedback and 'x is not defined' in feedback


# ---------------------------------------------------------------------------
# The after-model gate
# ---------------------------------------------------------------------------


async def test_nothing_to_verify_leaves_the_turn_alone(turn, monkeypatch) -> None:
    session, _workspace = turn
    gather = _Gather(monkeypatch)

    assert await _finish() is None  # nothing was edited

    _touch(session, 'a.py')
    pending_call = AIMessage(content='', tool_calls=[{'name': 'read_workspace_file', 'args': {}, 'id': 'c1'}])
    state_with_call = {'messages': [HumanMessage(content='do it'), pending_call]}
    assert await TurnVerificationMiddleware().aafter_model(state_with_call, MagicMock()) is None

    monkeypatch.setattr(runtime_config.tools, 'verify_after_edits', False)
    assert await _finish() is None
    monkeypatch.setattr(runtime_config.tools, 'verify_after_edits', True)

    session.abort_event.set()
    assert await _finish() is None
    session.abort_event.clear()

    assert gather.calls == [] and _pills(session) == []


async def test_edits_no_language_server_or_check_covers_end_without_a_pill(turn, monkeypatch) -> None:
    session, _workspace = turn
    gather = _Gather(monkeypatch)
    _touch(session, 'notes.txt')

    assert await _finish() is None
    assert gather.calls == [] and _pills(session) == []
    assert turn_verify_state(session.edits, 't1').verified_mutations == 1


async def test_a_clean_result_ends_the_turn_and_is_not_repeated(turn, monkeypatch) -> None:
    session, _workspace = turn
    gather = _Gather(monkeypatch, _passing())
    _touch(session, 'a.py')

    assert await _finish() is None
    assert await _finish() is None  # same edits: nothing to verify again

    assert len(gather.calls) == 1 and gather.calls[0]['touched_paths'] == ['a.py']
    assert [(p['state'], p['detail']) for p in _pills(session)] == [('running', '1 file'), ('complete', 'no new errors')]
    assert session.verify_running is False


async def test_a_failure_goes_back_to_the_model_until_the_rounds_run_out(turn, monkeypatch) -> None:
    session, _workspace = turn
    monkeypatch.setattr(runtime_config.tools, 'verify_max_fix_rounds', 2)
    gather = _Gather(monkeypatch, _failing(), _failing(), _failing())
    _touch(session, 'a.py')
    session.hitl_sse_queue = asyncio.Queue()

    first = await _finish()
    assert first is not None and first['jump_to'] == 'model'
    feedback = first['messages'][0]
    assert isinstance(feedback, HumanMessage) and feedback.content.startswith(FEEDBACK_HEADER)
    assert '(Fix round 1 of 2.)' in feedback.content
    assert session.hitl_sse_queue.get_nowait() == ('agent_nudge', {'reason': 'verify'})

    _touch(session, 'a.py')  # the model's fix
    second = await _finish()
    assert second is not None and '(Fix round 2 of 2.)' in second['messages'][0].content

    _touch(session, 'a.py')
    assert await _finish() is None  # no rounds left: the turn ends with the failure showing
    assert await _finish() is None  # and is not verified again without new edits

    assert len(gather.calls) == 3
    pills = _pills(session)
    assert [p['state'] for p in pills] == ['running', 'error', 'running', 'error', 'running', 'error']
    assert pills[1]['detail'] == 'tests failed (exit code 1)'
    assert pills[-1]['detail'] == 'tests failed (exit code 1) · not fixed after 2 fix round(s)'


async def test_zero_fix_rounds_only_reports(turn, monkeypatch) -> None:
    session, _workspace = turn
    monkeypatch.setattr(runtime_config.tools, 'verify_max_fix_rounds', 0)
    _Gather(monkeypatch, _failing())
    _touch(session, 'a.py')

    assert await _finish() is None
    assert [(p['state'], p['detail']) for p in _pills(session)][-1] == ('error', 'tests failed (exit code 1)')


async def test_an_answer_that_explains_instead_of_fixing_stands(turn, monkeypatch) -> None:
    session, _workspace = turn
    gather = _Gather(monkeypatch, _failing(), _failing())
    _touch(session, 'a.py')
    first = await _finish()
    assert first is not None

    # No tool call since the feedback: the same checks would only fail the same way.
    assert await _finish(AIMessage(content='Done.'), first['messages'][0], text='That test failed before my change.') is None
    assert len(gather.calls) == 1

    # A command run since the feedback may have fixed it, though no file tool journaled anything.
    command = AIMessage(content='', tool_calls=[{'name': 'run_command', 'args': {}, 'id': 'c1'}])
    ran = ToolMessage(content='Command report: exit 0', tool_call_id='c1', name='run_command')
    again = await _finish(AIMessage(content='Done.'), first['messages'][0], command, ran, text='Regenerated.')
    assert again is not None and len(gather.calls) == 2


async def test_verification_that_breaks_never_fails_the_turn(turn, monkeypatch) -> None:
    session, _workspace = turn
    _Gather(monkeypatch, RuntimeError('boom'))
    _touch(session, 'a.py')

    assert await _finish() is None
    assert [(p['state'], p['detail']) for p in _pills(session)] == [('running', '1 file'), ('complete', 'could not run')]
    assert session.verify_running is False


async def test_sub_agents_and_stopped_runs_are_left_alone(turn, monkeypatch) -> None:
    session, _workspace = turn
    gather = _Gather(monkeypatch, VerificationResult(stopped=True))
    _touch(session, 'a.py')

    session.subagent_pending_reports['child'] = object()
    assert await _finish() is None and gather.calls == []
    session.subagent_pending_reports.clear()

    assert await _finish() is None  # stopped while gathering: the result is not acted on
    assert turn_verify_state(session.edits, 't1').verified_mutations == -1
    assert _pills(session)[-1]['detail'] == 'stopped'

    child = state.get_session('verify-child')
    child.subagent_parent_session_id = 'verify-turn'
    child.edits, child.current_user_message_id, child.workspace_path = session.edits, 't1', session.workspace_path
    token = current_session_id.set('verify-child')
    try:
        assert await _finish() is None and len(gather.calls) == 1
    finally:
        current_session_id.reset(token)
        state.sessions.pop('verify-child', None)


# ---------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------


def _content_check(workspace: Path) -> dict[str, Any]:
    """A check that passes only once ``a.txt`` says ``good``."""
    (workspace / 'check.py').write_text(
        "import pathlib, sys\n"
        "text = pathlib.Path('a.txt').read_text(encoding='utf-8').strip()\n"
        "print('a.txt says', text)\n"
        "sys.exit(0 if text == 'good' else 1)\n",
        encoding='utf-8',
    )
    py = sys.executable.replace('\\', '/')
    return {'name': 'content', 'command': f'"{py}" check.py', 'paths': ['*.txt']}


async def test_a_failing_check_sends_the_turn_back_and_the_fix_ends_it(
    checkpoints, parent_session, use_model, monkeypatch
) -> None:
    sid, session = parent_session
    workspace = Path(session.workspace_path)
    _write_checks(workspace, [_content_check(workspace)])
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', trusted_workspace_keys([str(workspace)]))
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_call('w1', 'write_workspace_file', relative_path='a.txt', content='bad\n')]),
                    AIMessage(content='All done.'),
                    AIMessage(content='', tool_calls=[_call('w2', 'write_workspace_file', relative_path='a.txt', content='good\n')]),
                    AIMessage(content='Fixed it.'),
                ]
            }
        )
    )

    lines = await _run_turn(sid, 'write a.txt', apply_mode=True, umid='turn-1')

    pills = _pill(lines, VERIFY_PILL_LABEL)
    assert [(p['state'], p['detail']) for p in pills] == [
        ('running', '1 file'),
        ('error', 'content failed (exit code 1)'),
        ('running', '1 file'),
        ('complete', 'content passed'),
    ]
    feedback = [str(m.content) for m in model.views()[2] if isinstance(m, HumanMessage)][-1]
    assert feedback.startswith(FEEDBACK_HEADER) and 'a.txt says bad' in feedback
    payloads = _payloads(lines)
    assert [p for p in payloads if p['type'] == 'promote_primary_to_nudge']
    assert [p['text'] for p in payloads if p['type'] == 'final_text'] == ['Fixed it.']
    assert (workspace / 'a.txt').read_text(encoding='utf-8') == 'good\n'
    assert model.scripts['parent'] == []


async def test_an_untrusted_workspace_runs_no_check_and_the_turn_just_ends(
    checkpoints, parent_session, use_model, monkeypatch
) -> None:
    sid, session = parent_session
    workspace = Path(session.workspace_path)
    _write_checks(workspace, [_content_check(workspace)])
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', frozenset())
    use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_call('w1', 'write_workspace_file', relative_path='a.txt', content='bad\n')]),
                    AIMessage(content='All done.'),
                ]
            }
        )
    )

    lines = await _run_turn(sid, 'write a.txt', apply_mode=True, umid='turn-1')

    assert [(p['state'], p['detail']) for p in _pill(lines, VERIFY_PILL_LABEL)] == [
        ('running', '1 file'),
        ('complete', 'checks not run: this workspace is not trusted'),
    ]
    assert [p['text'] for p in _payloads(lines) if p['type'] == 'final_text'] == ['All done.']


async def test_the_finish_gates_cost_one_graph_step_however_many_there_are(checkpoints, parent_session) -> None:
    """Each after-model node is a step against the turn's step limit on every model call."""
    from clara_coder_backend.lang_agent.graph import build_clara_single_outer_graph

    _sid, session = parent_session
    model = ScriptedChatModel(scripts={'parent': []})

    def hook_nodes(**kwargs: Any) -> list[str]:
        graph = build_clara_single_outer_graph(model, session, **kwargs)
        return sorted(name for name in graph.get_graph().nodes if name.endswith(('.after_model', '.before_model')))

    read_only_chat = hook_nodes(apply_mode=False, allow_subagents=True)
    editor_chat = hook_nodes(apply_mode=True, allow_subagents=True)
    plan_executor = hook_nodes(apply_mode=True, allow_subagents=True, finish_middleware=[PlanPendingStepsMiddleware()])

    assert 'SubagentResultsMiddleware.after_model' in read_only_chat
    assert 'FinishGatesMiddleware.after_model' in editor_chat and 'FinishGatesMiddleware.before_model' in editor_chat
    assert not [name for name in editor_chat if name.startswith(('TurnVerification', 'SubagentResults'))]
    assert len(read_only_chat) == len(editor_chat) == len(plan_executor)


async def test_a_read_only_turn_is_never_verified(checkpoints, parent_session, use_model) -> None:
    sid, _session = parent_session
    use_model(ScriptedChatModel(scripts={'parent': [AIMessage(content='It is a text file.')]}))

    lines = await _run_turn(sid, 'what is a.txt?', apply_mode=False, umid='turn-1')

    assert _pill(lines, VERIFY_PILL_LABEL) == []


# ---------------------------------------------------------------------------
# The checks file belongs to the user
# ---------------------------------------------------------------------------


async def test_file_tools_refuse_the_checks_file(turn) -> None:
    _session, workspace = turn
    _write_checks(workspace, [])
    checks_file = workspace / '.clara' / 'checks.json'
    before = checks_file.read_text(encoding='utf-8')
    (workspace / 'mine.json').write_text('{"checks": [{"command": "evil"}]}', encoding='utf-8')

    # Windows drops trailing dots and spaces and opens a file's main stream for ``::$DATA``.
    for path in (
        '.clara/checks.json',
        '.CLARA/Checks.JSON',
        './.clara/../.clara/checks.json',
        '.nemo/checks.json',
        '.clara/checks.json.',
        '.clara/checks.json ',
        '.clara./checks.json',
        '.clara/checks.json::$DATA',
    ):
        out = write_workspace_file.invoke({'relative_path': path, 'content': '{}'})
        assert out.startswith('Tool error:') and 'only the user changes it' in out, path
    copied = copy_workspace_files.invoke(
        {'copies': [{'source_path': 'mine.json', 'destination_path': '.clara/checks.json'}], 'overwrite': True}
    )
    assert 'only the user changes it' in copied
    for paths in (['.clara/checks.json'], ['.clara']):
        deleted = delete_workspace_entries.invoke({'relative_paths': paths, 'recursive': True})
        assert deleted.startswith('Tool error:') and 'only the user changes it' in deleted

    assert checks_file.read_text(encoding='utf-8') == before
    assert not (workspace / '.nemo').exists()
    # Other files in the folder stay editable.
    assert write_workspace_file.invoke({'relative_path': '.clara/notes.md', 'content': 'x\n'}).startswith('Created')


# ---------------------------------------------------------------------------
# Plan execution: unchecked steps
# ---------------------------------------------------------------------------


async def test_plan_executor_gets_its_unchecked_steps_back_once(turn) -> None:
    session, workspace = turn
    session.hitl_sse_queue = asyncio.Queue()
    plan = BuildPlanModel(
        title='Gate test',
        task='Check the gate',
        current_implementation='Baseline',
        files_to_change=[FileChangeEntry(path='src/x.ts', operation='modify', rationale='edit')],
        action_steps=[ActionStep(id='step-1', goal='First milestone'), ActionStep(id='step-2', goal='Second milestone')],
    )
    create_build_plan(str(workspace), 'verify-turn', plan, session=session)
    mark_build_plan_steps_complete.invoke({'step_ids': ['step-1']})
    middleware = PlanPendingStepsMiddleware()
    done = {'messages': [HumanMessage(content='run the plan'), AIMessage(content='Plan finished.')]}

    first = await middleware.aafter_model(done, MagicMock())

    assert first is not None and first['jump_to'] == 'model'
    text = first['messages'][0].content
    assert 'step-2: Second milestone' in text and 'step-1' not in text
    assert session.hitl_sse_queue.get_nowait() == ('agent_nudge', {'reason': 'plan_steps'})
    assert await middleware.aafter_model(done, MagicMock()) is None  # its second answer stands


async def test_plan_executor_with_every_step_checked_just_ends(turn) -> None:
    session, workspace = turn
    plan = BuildPlanModel(
        title='Gate test',
        task='Check the gate',
        current_implementation='Baseline',
        files_to_change=[FileChangeEntry(path='src/x.ts', operation='modify', rationale='edit')],
        action_steps=[ActionStep(id='step-1', goal='Only milestone')],
    )
    create_build_plan(str(workspace), 'verify-turn', plan, session=session)
    mark_build_plan_steps_complete.invoke({'step_ids': ['step-1']})
    done = {'messages': [HumanMessage(content='run the plan'), AIMessage(content='Plan finished.')]}

    assert await PlanPendingStepsMiddleware().aafter_model(done, MagicMock()) is None
