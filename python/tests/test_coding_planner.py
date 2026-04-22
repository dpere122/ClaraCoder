"""Unit tests for the coding planner pipeline and supporting components."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage

from nemo_backend.agents.coding_planner.pipeline import (
    _StepProxyQueue,
    _had_new_workspace_transfer_since,
    _parse_plan_steps,
    _plan_requirements_text,
    _planner_has_incomplete_work,
    _planner_progress_snapshot,
    _planner_terminal_phase,
    _select_step_for_execution,
    _snapshot_workspace_applied_flags,
    _task_complexity_profile,
    _truncate_step_result,
    _validate_initial_plan_steps,
    run_coding_planner_stream,
)
from nemo_backend.agents.coding_planner.prompts import (
    build_coding_planner_reflection_prompt,
    build_coding_planner_system_prompt,
    build_coding_planner_task_prompt,
)
from nemo_backend.agents.specialists.prompts import (
    build_code_review_specialist_system_prompt,
    build_create_specialist_system_prompt,
    build_dependency_specialist_system_prompt,
    build_project_review_specialist_system_prompt,
    build_router_system_prompt,
    build_write_specialist_system_prompt,
)
from nemo_backend.agents.orchestration.nested_pipeline import NESTED_WORKER_STREAM_END
from nemo_backend.config import NEMO_PLANNER_MAX_STEP_TEXT_CHARS, NEMO_PLANNER_STEP_RESULT_MAX_CHARS
from nemo_backend.domain import EditStagingEntry, SessionState
from nemo_backend.tool_registry import staging_workspace_write_tools
from nemo_backend.planner_task_retry_middleware import PlannerTaskRetryMiddleware
from nemo_backend.state import runtime_config
from nemo_backend.python_env import PythonWorkspaceEnvResult, workspace_python_executable

pytestmark = pytest.mark.asyncio(loop_scope='function')


# ---------------------------------------------------------------------------
# _StepProxyQueue
# ---------------------------------------------------------------------------


class TestStepProxyQueue:
    async def test_forwards_regular_tuples(self) -> None:
        outer_q: asyncio.Queue = asyncio.Queue()
        proxy = _StepProxyQueue(outer_q)

        event = ('planning', {'event': 'on_chat_model_start', 'data': {}})
        await proxy.put(event)

        assert not outer_q.empty()
        assert outer_q.get_nowait() == event

    async def test_swallows_nested_worker_stream_end(self) -> None:
        outer_q: asyncio.Queue = asyncio.Queue()
        proxy = _StepProxyQueue(outer_q)

        await proxy.put(NESTED_WORKER_STREAM_END)

        assert outer_q.empty()

    async def test_mixed_events_and_sentinels(self) -> None:
        outer_q: asyncio.Queue = asyncio.Queue()
        proxy = _StepProxyQueue(outer_q)

        ev1 = ('spec-create-abc', {'event': 'on_tool_start', 'data': {}})
        ev2 = ('planning', {'event': 'on_chat_model_end', 'data': {}})

        await proxy.put(ev1)
        await proxy.put(NESTED_WORKER_STREAM_END)
        await proxy.put(ev2)
        await proxy.put(NESTED_WORKER_STREAM_END)

        items = []
        while not outer_q.empty():
            items.append(outer_q.get_nowait())

        assert items == [ev1, ev2]


# ---------------------------------------------------------------------------
# _truncate_step_result
# ---------------------------------------------------------------------------


class TestTruncateStepResult:
    def test_short_text_unchanged(self) -> None:
        text = 'Step completed: created foo.py'
        assert _truncate_step_result(text) == text

    def test_long_text_truncated(self) -> None:
        text = 'x' * (NEMO_PLANNER_STEP_RESULT_MAX_CHARS + 1000)
        result = _truncate_step_result(text)
        assert len(result) < len(text)
        assert result.startswith('x' * 100)
        assert 'truncated' in result.lower()

    def test_exact_limit_not_truncated(self) -> None:
        text = 'a' * NEMO_PLANNER_STEP_RESULT_MAX_CHARS
        assert _truncate_step_result(text) == text


class TestPlannerStepParsing:
    def test_parse_numbered_steps(self) -> None:
        steps = _parse_plan_steps('1. Inspect renderer state\n2. Add planner checklist')
        assert steps == [
            {'id': 'step-1', 'text': 'Inspect renderer state', 'state': 'pending'},
            {'id': 'step-2', 'text': 'Add planner checklist', 'state': 'pending'},
        ]

    def test_parse_bulleted_steps(self) -> None:
        steps = _parse_plan_steps('- Read app.ts\n* Update chat-box.html')
        assert [step['text'] for step in steps] == ['Read app.ts', 'Update chat-box.html']

    def test_parse_numbered_steps_single_line_with_spaces(self) -> None:
        text = (
            '1. Create calculator.py: Init Tkinter and theme. '
            '2. In calculator.py: Grid layout for buttons. '
            '3. In calculator.py: Wire handlers and mainloop.'
        )
        steps = _parse_plan_steps(text)
        assert len(steps) == 3
        assert 'Init Tkinter' in steps[0]['text']
        assert 'Grid layout' in steps[1]['text']
        assert 'mainloop' in steps[2]['text']

    def test_initial_plan_requires_min_steps_for_complexity_profile(self) -> None:
        parsed = _parse_plan_steps('1. Do everything')
        profile = _task_complexity_profile('Update the planner and the renderer task list flow.')
        error = _validate_initial_plan_steps(parsed, profile, discovery_completed=True)
        assert error is not None
        floor_min = max(2, profile.min_steps - 1)
        assert f'at least {floor_min}' in error.lower()

    def test_complex_tasks_require_discovery_before_plan(self) -> None:
        profile = _task_complexity_profile(
            'Break this long prompt into weighted build steps, update backend scheduling, enforce build-only '
            'planner tasks, and sync the renderer so execution waits for the checklist.'
        )
        parsed = _parse_plan_steps('1. Update backend planner logic\n2. Update renderer gating\n3. Add tests')
        error = _validate_initial_plan_steps(parsed, profile, discovery_completed=False)
        assert error is not None
        assert 'gather missing workspace context' in error.lower()

    def test_validate_initial_plan_requires_discovery_for_code_paths_when_flagged(self) -> None:
        """Low-complexity tasks that still name a programming path must pass explicit requires_discovery."""
        profile = _task_complexity_profile('Tweak tasks_app.py only.')
        assert profile.requires_discovery is False
        parsed = _parse_plan_steps('1. Adjust helper\n2. Wire entrypoint')
        err = _validate_initial_plan_steps(
            parsed,
            profile,
            discovery_completed=False,
            requires_discovery=True,
        )
        assert err is not None
        assert 'gather missing workspace context' in err.lower()
        assert (
            _validate_initial_plan_steps(
                parsed,
                profile,
                discovery_completed=True,
                requires_discovery=True,
            )
            is None
        )

    def test_plan_requirements_text_mentions_discovery_for_programming_paths(self) -> None:
        profile = _task_complexity_profile('Short non-code note.')
        text = _plan_requirements_text(profile, 'Update `tasks_app.py` docstring.')
        assert 'Perform discovery reads/searches' in text

    def test_validation_rejects_read_only_plan_steps(self) -> None:
        profile = _task_complexity_profile('Update planner UI')
        parsed = _parse_plan_steps('1. Inspect planner state\n2. Update the renderer view')
        error = _validate_initial_plan_steps(parsed, profile, discovery_completed=True)
        assert error is not None
        assert 'build steps only' in error.lower()

    def test_validation_rejects_overlong_steps(self) -> None:
        profile = _task_complexity_profile('Update planner UI')
        long_step = '1. ' + ('x' * (NEMO_PLANNER_MAX_STEP_TEXT_CHARS + 5))
        parsed = _parse_plan_steps(long_step + '\n2. Update the renderer view')
        error = _validate_initial_plan_steps(parsed, profile, discovery_completed=True)
        assert error is not None
        assert str(NEMO_PLANNER_MAX_STEP_TEXT_CHARS) in error

    def test_complexity_profile_scales_up_large_requests(self) -> None:
        small = _task_complexity_profile('Update config.')
        large = _task_complexity_profile(
            'Refactor the coding planner discovery flow, add weighted step sizing, update the renderer task '
            'ordering, wire IPC planner progress, and add backend plus frontend tests.'
        )
        assert large.target_steps > small.target_steps
        assert large.min_steps >= small.min_steps

    def test_execute_selection_does_not_invent_extra_steps(self) -> None:
        steps = [{'id': 'step-1', 'text': 'Only step', 'state': 'complete'}]
        assert _select_step_for_execution(steps, 'Do more work') is None

    def test_execute_selection_retries_earliest_incomplete_step(self) -> None:
        steps = [
            {'id': 'step-1', 'text': 'Blocked step', 'state': 'error'},
            {'id': 'step-2', 'text': 'Later step', 'state': 'pending'},
        ]
        selected = _select_step_for_execution(steps, 'Retry the blocked step')
        assert selected is steps[0]

    def test_incomplete_work_detects_missing_plan_or_unfinished_steps(self) -> None:
        assert _planner_has_incomplete_work(False, []) is True
        assert _planner_has_incomplete_work(True, [{'id': 'step-1', 'text': 'Done', 'state': 'complete'}]) is False
        assert _planner_has_incomplete_work(
            True,
            [{'id': 'step-1', 'text': 'Still running', 'state': 'running'}],
        ) is True


class TestPlannerProgressSnapshot:
    def test_snapshot_includes_active_step(self) -> None:
        planner = _planner_progress_snapshot(
            [{'id': 'step-1', 'text': 'Do work', 'state': 'running'}],
            'executing',
            active_step_id='step-1',
            plan_ready=True,
        )
        assert planner['streamTag'] == 'planner'
        assert planner['phase'] == 'executing'
        assert planner['planReady'] is True
        assert planner['activeStepId'] == 'step-1'
        assert planner['steps'][0]['state'] == 'running'

    def test_snapshot_can_represent_discovery_before_plan_exists(self) -> None:
        planner = _planner_progress_snapshot([], 'discovery', plan_ready=False)
        assert planner['phase'] == 'discovery'
        assert planner['planReady'] is False
        assert planner['steps'] == []

    def test_terminal_phase_resolves_complete(self) -> None:
        phase = _planner_terminal_phase(
            [
                {'id': 'step-1', 'text': 'One', 'state': 'complete'},
                {'id': 'step-2', 'text': 'Two', 'state': 'complete'},
            ]
        )
        assert phase == 'complete'

    def test_terminal_phase_prefers_error(self) -> None:
        phase = _planner_terminal_phase(
            [
                {'id': 'step-1', 'text': 'One', 'state': 'complete'},
                {'id': 'step-2', 'text': 'Two', 'state': 'error'},
            ]
        )
        assert phase == 'error'

    def test_terminal_phase_without_steps_is_discovery(self) -> None:
        assert _planner_terminal_phase([]) == 'discovery'


# ---------------------------------------------------------------------------
# build_coding_planner_system_prompt
# ---------------------------------------------------------------------------


class TestCodingPlannerPrompt:
    def _make_session(self) -> SessionState:
        s = SessionState()
        s.workspace_path = '/tmp/test-workspace'
        s.workspace_context = 'src/\n  main.py\n  utils.py'
        return s

    @patch('nemo_backend.messages.get_active_connection')
    @patch('nemo_backend.messages.runtime_config')
    def test_prompt_contains_key_instructions(self, mock_rc: Any, mock_conn: Any) -> None:
        mock_conn.return_value = MagicMock(name='test', provider='openai', model='gpt-4o')
        mock_rc.host = MagicMock(platform='win32', release='10', arch='x86_64', version='10.0', label='Windows')
        session = self._make_session()
        prompt = build_coding_planner_system_prompt(session)

        assert 'deterministic coding orchestrator' in prompt.lower()
        assert '## Role' in prompt
        assert '## Workflow' in prompt
        assert 'outer clara' in prompt.lower()
        assert '**Debugger:**' in prompt
        assert '**Systems engineer:**' in prompt
        assert 'execute_plan_step' in prompt
        assert 'record_plan' in prompt
        assert 'nested mutation pipeline' in prompt.lower()
        assert 'Structured build plan' in prompt
        assert 'Final review' in prompt
        assert 'run_final_project_review' not in prompt
        assert '/tmp/test-workspace' in prompt
        assert 'Python workspace playbook' in prompt

    @patch('nemo_backend.messages.get_active_connection')
    @patch('nemo_backend.messages.runtime_config')
    def test_only_code_review_prompt_receives_staging_tree(self, mock_rc: Any, mock_conn: Any) -> None:
        mock_conn.return_value = MagicMock(name='test', provider='openai', model='gpt-4o')
        mock_rc.host = MagicMock(platform='win32', release='10', arch='x86_64', version='10.0', label='Windows')
        session = self._make_session()
        session.workspace_context = (
            'Workspace tree (/tmp/test-workspace):\n'
            'src/\n'
            '  main.py\n'
            '\n'
            'Nested edit staging tree (/tmp/staging):\n'
            'abc123_main.py\n'
            '\n'
            'Treat the staging tree as live pending-edit context; files there may not yet exist in the workspace.'
        )

        create_prompt = build_create_specialist_system_prompt(session)
        review_prompt = build_code_review_specialist_system_prompt(session)

        assert 'Nested edit staging tree' not in create_prompt
        assert 'abc123_main.py' not in create_prompt
        assert 'Nested edit staging tree' in review_prompt
        assert 'abc123_main.py' in review_prompt

    def test_task_prompt_injects_tool_reference(self) -> None:
        prompt = build_coding_planner_task_prompt('Update auth flow', '- Record between 2 and 3 build steps.')
        assert 'Update auth flow' in prompt
        assert 'Expected pipeline' in prompt
        assert 'record_plan' in prompt
        assert 'execute_plan_step' in prompt
        assert 'transfer_staged_file_to_workspace' in prompt
        assert 'Deterministic coding orchestrator' in prompt
        assert 'run_planning_nested_stream' in prompt
        assert '**Existence:**' in prompt
        assert 'Discovery' in prompt
        assert 'lsp_get_diagnostics' in prompt
        assert 'lsp_find_references' in prompt
        assert 'Record between 2 and 3 build steps.' in prompt
        assert 'plan_and_modify' in prompt
        assert 'run_final_project_review' not in prompt
        assert 'Python workspace playbook' in prompt

    def test_task_prompt_without_lsp_discovery_omits_bound_lsp_tool_reference(self) -> None:
        prompt = build_coding_planner_task_prompt(
            'Update README.md',
            '- Record between 2 and 3 build steps.',
            include_lsp_discovery=False,
        )
        # Planner tool reference replaces LSP tool bullets with a scope note (playbook may still mention LSP generically).
        assert 'LSP tools are not available for this task scope' in prompt
        assert 'read/search/list tools only' in prompt

    def test_reflection_prompt_requires_continuing_same_checklist(self) -> None:
        prompt = build_coding_planner_reflection_prompt(
            reflection_attempt=1,
            plan_ready=True,
            steps=[
                {'id': 'step-1', 'text': 'Update planner loop', 'state': 'complete'},
                {'id': 'step-2', 'text': 'Update tests', 'state': 'complete'},
            ],
            latest_feedback='Final review has not run yet.',
        )
        assert 'Reflection required' in prompt
        assert '[COMPLETE] Update tests' in prompt
        assert 'orchestrator-driven' in prompt.lower()
        assert 'Current step to continue:' in prompt
        assert 'all recorded steps are already complete' in prompt
        assert 'Latest failure or reviewer feedback:' in prompt
        assert 'Final review has not run yet.' in prompt
        assert 'remediation checklist step' in prompt.lower()

    def test_reflection_prompt_handles_missing_plan(self) -> None:
        prompt = build_coding_planner_reflection_prompt(
            reflection_attempt=2,
            plan_ready=False,
            steps=[],
        )
        assert 'before finishing the initial plan setup' in prompt
        assert 'Continue discovery' in prompt
        assert 'reflection attempt 2' in prompt.lower()

    def test_reflection_prompt_handles_incomplete_recorded_steps(self) -> None:
        prompt = build_coding_planner_reflection_prompt(
            reflection_attempt=1,
            plan_ready=True,
            steps=[
                {'id': 'step-1', 'text': 'Create base app', 'state': 'complete'},
                {'id': 'step-2', 'text': 'Add CRUD behavior', 'state': 'pending'},
            ],
            next_step_text='Add CRUD behavior',
            latest_feedback='The previous step summary only covered the skeleton.',
        )
        assert 'recorded checklist still has unfinished work' in prompt
        assert '[PENDING] Add CRUD behavior' in prompt
        assert 'retry `plan_and_modify`' in prompt
        assert 'Add CRUD behavior' in prompt
        assert 'Do not give a final summary yet' in prompt
        assert 'final review runs only after every recorded step is complete' in prompt.lower()
        assert 'routing handoff block' in prompt.lower()

    def test_reflection_prompt_when_remediation_step_is_pending(self) -> None:
        prompt = build_coding_planner_reflection_prompt(
            reflection_attempt=1,
            plan_ready=True,
            steps=[
                {'id': 'step-1', 'text': 'Update planner loop', 'state': 'complete'},
                {'id': 'step-2', 'text': 'Update tests', 'state': 'complete'},
                {'id': 'step-3', 'text': 'Fix final review failures', 'state': 'pending'},
            ],
            next_step_text='Fix final review failures',
            latest_feedback='Final project review failed; remediation step appended.',
            final_review_state='pending',
        )
        assert 'unfinished work' in prompt
        assert 'orchestrator' in prompt.lower()
        assert 'checklist' in prompt.lower()

    @patch('nemo_backend.messages.get_active_connection')
    @patch('nemo_backend.messages.runtime_config')
    def test_router_and_review_prompts_treat_transfer_as_approval(self, mock_rc: Any, mock_conn: Any) -> None:
        mock_conn.return_value = MagicMock(name='test', provider='openai', model='gpt-4o')
        mock_rc.host = MagicMock(platform='win32', release='10', arch='x86_64', version='10.0', label='Windows')
        session = self._make_session()

        router_prompt = build_router_system_prompt(session)
        review_prompt = build_code_review_specialist_system_prompt(session)
        dependency_prompt = build_dependency_specialist_system_prompt(session)
        write_prompt = build_write_specialist_system_prompt(session)
        project_review_prompt = build_project_review_specialist_system_prompt(session)

        assert 'approval signal' in router_prompt
        assert '**Return to Clara:**' in router_prompt
        assert 'Exploration before staging' in router_prompt
        assert 'file-write specialist' in router_prompt
        assert 'route_dependency_specialist' in router_prompt
        assert 'route_node_dependency_specialist' in router_prompt
        assert 'workspace_path_status' in router_prompt
        assert '**Operation:**' in router_prompt
        assert 'related test-file references' in router_prompt
        assert 'completion-check task' in router_prompt
        assert 'route_write_specialist' in router_prompt
        assert 'revises pending staged drafts' in router_prompt
        assert 'That handoff owns the review-to-revision loop' in router_prompt
        assert 'separate retry step' in router_prompt
        assert 'route_project_review_specialist' not in router_prompt
        assert 'Do not attempt a final whole-project review in this router pass' in router_prompt
        assert 'orchestrator runs that after the **full**' in router_prompt
        assert 'Do not run the workspace test suite from this specialist' in review_prompt
        assert 'file-write specialist' in review_prompt
        assert 'workspace dependency specialist' in dependency_prompt
        assert 'write a frozen requirements file' in dependency_prompt
        assert 'final approval signal' in review_prompt
        assert '**Return to Clara:**' in review_prompt
        assert 'reviewed and complete' in review_prompt
        assert 'Do not write prose like "Action: Transfer to workspace"' in review_prompt
        assert 'minimum changes needed for approval' in review_prompt
        assert 'do not ask for unrelated refactors' in review_prompt
        assert 'read_workspace_file' in write_prompt
        assert 'read_staged_edit' in write_prompt
        assert 'file-write specialist' in write_prompt
        assert 'ensure_python_workspace_env' in project_review_prompt
        assert 'run_workspace_pytest_tests' in project_review_prompt
        assert 'run_workspace_python_smoke_test' in project_review_prompt
        assert 'approve_project_review' in project_review_prompt
        assert 'reject_project_review' in project_review_prompt
        assert 'prefer the LSP-directed inspection tools' in project_review_prompt
        assert 'Do not create placeholder infrastructure' in project_review_prompt
        assert 'real pytest signal' in project_review_prompt


# ---------------------------------------------------------------------------
# Legacy ``TestRunCodingPlannerStream`` targeted the removed LangGraph planner
# (``create_agent`` + ``record_plan`` tools). The deterministic orchestrator
# is covered by ``TestDeterministicOrchestratorStream`` and ``test_plan_orchestrator``.
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason='Legacy LangGraph nemo_coding_planner agent removed; use deterministic orchestrator tests.')
class TestRunCodingPlannerStream:
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_record_plan_emits_planner_progress(self, mock_create: Any, mock_build: Any) -> None:
        mock_build.return_value = MagicMock()
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        result = await record_plan_tool.ainvoke({'plan_steps': '1. Update UI\n2. Render checklist'})
        assert 'Initial build checklist recorded' in result

        release_stream.set()
        await task

        planner_events = []
        while not nested_q.empty():
            item = nested_q.get_nowait()
            if item is NESTED_WORKER_STREAM_END:
                continue
            planner_events.append(item)

        assert any(
            tag == 'planner'
            and event.get('event') == 'planner_progress'
            and event['data']['planner']['steps']
            and event['data']['planner']['steps'][0]['text'] == 'Update UI'
            for tag, event in planner_events
        )

    @patch('nemo_backend.agents.coding_planner.pipeline.list_workspace_directory')
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_record_plan_requires_discovery_when_task_names_code_path(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_list_tool: MagicMock,
    ) -> None:
        """Even low-complexity tasks must run a discovery tool once the task text names a programming path."""
        mock_build.return_value = MagicMock()
        mock_list_tool.name = 'list_workspace_directory'
        mock_list_tool.invoke.return_value = 'tasks_app.py'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task_summary = 'Update `tasks_app.py` docstring only.'
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', task_summary, nested_q, None))
        await asyncio.sleep(0)

        list_tool = next(tool for tool in captured_tools if tool.name == 'list_workspace_directory')
        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')

        first = await record_plan_tool.ainvoke({'plan_steps': '1. Edit docstring\n2. Verify imports'})
        assert 'gather missing workspace context' in first.lower()

        await list_tool.ainvoke({'relative_path': '.'})
        second = await record_plan_tool.ainvoke({'plan_steps': '1. Edit docstring\n2. Verify imports'})
        assert 'Initial build checklist recorded' in second

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.list_workspace_directory')
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_discovery_reads_allowed_before_plan_and_retry_follow_up_after(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_list_tool: MagicMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_list_tool.name = 'list_workspace_directory'
        mock_list_tool.invoke.return_value = 'src/\npython/'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        list_tool = next(tool for tool in captured_tools if tool.name == 'list_workspace_directory')
        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')

        list_result = await list_tool.ainvoke({'relative_path': '.'})
        assert 'src/' in list_result
        mock_list_tool.invoke.assert_called_once()

        await record_plan_tool.ainvoke({'plan_steps': '1. Update UI\n2. Render checklist'})
        follow_up_result = await list_tool.ainvoke({'relative_path': '.'})
        assert 'src/' in follow_up_result
        assert 'checklist is recorded and locked until final review completes' in follow_up_result
        assert 'locked until final review completes' in follow_up_result
        assert mock_list_tool.invoke.call_count == 2

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_execute_plan_step_requires_recorded_plan(self, mock_create: Any, mock_build: Any) -> None:
        mock_build.return_value = MagicMock()
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        result = await execute_tool.ainvoke({'step_instruction': 'Update the chat box UI'})
        assert 'finish discovery and call `record_plan`' in result

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_execute_plan_step_updates_step_states(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.return_value = 'Step completed successfully.'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update chat box\n2. Verify chat box'})
        await execute_tool.ainvoke({'step_instruction': 'Update the chat box UI'})

        assert 'allow_project_review' not in mock_run_step.await_args.kwargs

        release_stream.set()
        await task

        planner_phases = []
        planner_states = []
        while not nested_q.empty():
            item = nested_q.get_nowait()
            if item is NESTED_WORKER_STREAM_END:
                continue
            tag, event = item
            if tag == 'planner' and event.get('event') == 'planner_progress':
                planner = event['data']['planner']
                planner_phases.append(planner['phase'])
                if planner['steps']:
                    planner_states.append(planner['steps'][0]['state'])

        assert planner_phases[0] == 'discovery'
        assert 'planning' in planner_phases
        assert 'executing' in planner_phases
        assert 'running' in planner_states
        assert planner_states[-1] == 'complete'

    async def test_workspace_applied_snapshot_detects_new_transfer(self) -> None:
        session = SessionState()
        assert _snapshot_workspace_applied_flags(session) == {}
        session.pending_edit_stagings['src/x.py'] = EditStagingEntry(
            temp_path='/tmp/x',
            old_text='',
            merged_text='a',
            disk_encoding='utf-8',
            disk_newline='lf',
            edit_mode='full-file',
            workspace_applied=False,
        )
        before = _snapshot_workspace_applied_flags(session)
        assert before == {'src/x.py': False}
        session.pending_edit_stagings['src/x.py'].workspace_applied = True
        assert _had_new_workspace_transfer_since(session, before) is True
        assert _had_new_workspace_transfer_since(session, {'src/x.py': True}) is False

    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_execute_plan_step_tool_error_appends_retry_hint_when_no_transfer(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.return_value = 'Tool error: nested pipeline failed.'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update chat box\n2. Verify chat box'})
        result = await execute_tool.ainvoke({'step_instruction': 'x'})
        assert 'Tool error: nested pipeline failed.' in result
        assert 'Planner note: no staged file was approved into the workspace' in result

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_execute_plan_step_tool_error_omits_hint_after_workspace_transfer(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()

        async def _fail_after_transfer(sess: SessionState, *_a: Any, **_kw: Any) -> str:
            sess.pending_edit_stagings['a.py'] = EditStagingEntry(
                temp_path='/tmp/a',
                old_text='',
                merged_text='b',
                disk_encoding='utf-8',
                disk_newline='lf',
                edit_mode='full-file',
                workspace_applied=True,
            )
            return 'Tool error: nested pipeline failed after transfer.'

        mock_run_step.side_effect = _fail_after_transfer
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update chat box\n2. Verify chat box'})
        result = await execute_tool.ainvoke({'step_instruction': 'x'})
        assert 'Tool error: nested pipeline failed after transfer.' in result
        assert 'Planner note: no staged file was approved into the workspace' not in result

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_record_plan_rejects_single_step(self, mock_create: Any, mock_build: Any) -> None:
        mock_build.return_value = MagicMock()
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        result = await record_plan_tool.ainvoke({'plan_steps': '1. Do the task'})
        assert 'at least' in result.lower()
        assert 'build steps' in result.lower()

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_record_plan_can_only_be_called_once(self, mock_create: Any, mock_build: Any) -> None:
        mock_build.return_value = MagicMock()
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        first = await record_plan_tool.ainvoke({'plan_steps': '1. Update UI\n2. Render checklist'})
        second = await record_plan_tool.ainvoke({'plan_steps': '1. Replace the plan\n2. Do something else'})

        assert 'Initial build checklist recorded' in first
        assert 'already recorded' in second
        assert 'final project review completes' in second
        assert 'Your next tool call should be `execute_plan_step`' in second
        assert 'Update UI' in second

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_execute_plan_step_refuses_unplanned_extra_work(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.return_value = 'Step completed successfully.'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update chat box\n2. Verify chat box'})
        await execute_tool.ainvoke({'step_instruction': 'Update the chat box UI'})
        await execute_tool.ainvoke({'step_instruction': 'Update the chat box UI'})
        result = await execute_tool.ainvoke({'step_instruction': 'Do an extra unplanned verification pass'})
        assert 'no pending planned step to execute' in result.lower()
        assert 'run_final_project_review' in result.lower()

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_final_project_review_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_run_final_project_review_failure_appends_remediation_step_and_clears_reentry(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
        mock_run_final: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.side_effect = [
            'Updated the implementation files.',
            'Updated the tests.',
        ]
        mock_run_final.return_value = (
            'Tool error: final project review failed. Use the reviewer feedback to make the minimum workspace fixes '
            'needed for another final review pass.\n\nProject review rejected.\n\nReviewer feedback:\nFix failing pytest assertion.'
        )
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        final_review_tool = next(tool for tool in captured_tools if tool.name == 'run_final_project_review')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update implementation\n2. Update tests'})
        await execute_tool.ainvoke({'step_instruction': 'Update implementation files'})
        await execute_tool.ainvoke({'step_instruction': 'Update test files'})
        result = await final_review_tool.ainvoke({})

        assert 'appended automatically' in result
        assert 'execute_plan_step' in result
        assert 'Call `record_plan` with' not in result
        assert mock_run_step.await_count == 2
        assert mock_run_final.await_count == 1
        assert session.pending_project_review_reentry is None
        assert 'Fix failing pytest assertion.' in result

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_final_project_review_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_run_final_project_review_success_clears_reentry_request(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
        mock_run_final: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.side_effect = [
            'Updated the implementation files.',
            'Updated the tests.',
        ]
        mock_run_final.return_value = 'Project review approved.\n\nSummary:\nWorkspace tests passed.'
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        final_review_tool = next(tool for tool in captured_tools if tool.name == 'run_final_project_review')
        await record_plan_tool.ainvoke({'plan_steps': '1. Update implementation\n2. Update tests'})
        await execute_tool.ainvoke({'step_instruction': 'Update implementation files'})
        await execute_tool.ainvoke({'step_instruction': 'Update test files'})
        result = await final_review_tool.ainvoke({})

        assert 'Workspace tests passed.' in result
        assert mock_run_step.await_count == 2
        assert mock_run_final.await_count == 1
        assert session.pending_project_review_reentry is None

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.run_final_project_review_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.run_planning_nested_stream', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_record_plan_followup_after_final_review_succeeds(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_run_step: AsyncMock,
        mock_run_final: AsyncMock,
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_run_step.side_effect = [
            'Phase1 step A done.',
            'Phase1 step B done.',
            'Phase2 step A done.',
            'Phase2 step B done.',
        ]
        mock_run_final.side_effect = [
            'Project review approved.\n\nSummary:\nPhase 1 ok.',
            'Project review approved.\n\nSummary:\nPhase 2 ok.',
        ]
        release_stream = asyncio.Event()
        captured_tools: list[Any] = []

        async def _fake_stream(*_a: Any, **_kw: Any):
            await release_stream.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream

        def _capture_create(*args: Any, **_kwargs: Any) -> Any:
            captured_tools.extend(args[1])
            return mock_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None))
        await asyncio.sleep(0)

        record_plan_tool = next(tool for tool in captured_tools if tool.name == 'record_plan')
        execute_tool = next(tool for tool in captured_tools if tool.name == 'execute_plan_step')
        final_review_tool = next(tool for tool in captured_tools if tool.name == 'run_final_project_review')

        await record_plan_tool.ainvoke({'plan_steps': '1. Phase one A\n2. Phase one B'})
        await execute_tool.ainvoke({'step_instruction': 'Phase 1 A'})
        await execute_tool.ainvoke({'step_instruction': 'Phase 1 B'})
        await final_review_tool.ainvoke({})

        second_plan = await record_plan_tool.ainvoke({'plan_steps': '1. Phase two A\n2. Phase two B'})
        assert 'Follow-up build checklist recorded' in second_plan

        await execute_tool.ainvoke({'step_instruction': 'Phase 2 A'})
        await execute_tool.ainvoke({'step_instruction': 'Phase 2 B'})
        final2 = await final_review_tool.ainvoke({})
        assert 'Phase 2 ok.' in final2
        assert mock_run_step.await_count == 4
        assert mock_run_final.await_count == 2

        release_stream.set()
        await task

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_task_prompt_is_sent_to_planner(self, mock_create: Any, mock_build: Any) -> None:
        mock_build.return_value = MagicMock()

        async def _fake_stream(*args: Any, **_kw: Any):
            inputs = args[0]
            message = inputs['messages'][0]
            assert 'Required opening behavior' in message.content
            assert 'Planner tool reference' in message.content
            assert 'record_plan' in message.content
            assert 'Start with discovery' in message.content
            assert 'Plan sizing requirements' in message.content
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream
        mock_create.return_value = mock_graph

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()

        await run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None)
        planner_tools = mock_create.call_args.args[1]
        edit_names = [t.name for t in staging_workspace_write_tools(runtime_config.tools.edit_tools_strict)]
        assert [tool.name for tool in planner_tools] == [
            'ensure_python_workspace_env',
            'record_plan',
            'list_workspace_directory',
            'read_workspace_file',
            'search_workspace',
            'retrieve_workspace_semantic',
            'lsp_get_diagnostics',
            'lsp_hover',
            'lsp_find_definition',
            'lsp_find_references',
            'lsp_get_document_symbols',
            *edit_names,
            'execute_plan_step',
            'run_final_project_review',
        ]
        middleware = mock_create.call_args.kwargs['middleware']
        assert isinstance(middleware[0], PlannerTaskRetryMiddleware)

    async def test_planner_retry_middleware_reprompts_incomplete_stop(self) -> None:
        should_retry = True
        middleware = PlannerTaskRetryMiddleware(
            should_retry=lambda: should_retry,
            build_retry_prompt=lambda attempt: f'reflect attempt {attempt}',
            max_retries=2,
        )

        first = await middleware.aafter_model(
            {'messages': [AIMessage(content='All done?')]},
            MagicMock(),
        )
        assert first is not None
        assert first['jump_to'] == 'model'
        assert first['planner_task_retry_streak'] == 1
        assert first['messages'][0].content == 'reflect attempt 1'

        second = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Still done?')],
                'planner_task_retry_streak': 1,
            },
            MagicMock(),
        )
        assert second is not None
        assert second['planner_task_retry_streak'] == 2

        third = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Stopping again')],
                'planner_task_retry_streak': 2,
            },
            MagicMock(),
        )
        assert third is None

        should_retry = False
        reset = await middleware.aafter_model(
            {'messages': [AIMessage(content='Actually complete')]},
            MagicMock(),
        )
        assert reset == {'planner_task_retry_streak': 0}

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    async def test_llm_build_failure_sends_sentinel(self, mock_build: Any) -> None:
        mock_build.side_effect = RuntimeError('No API key')
        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()

        with pytest.raises(RuntimeError, match='No API key'):
            await run_coding_planner_stream(session, 'sess-1', 'do stuff', nested_q, None)

        assert nested_q.get_nowait() is NESTED_WORKER_STREAM_END

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_abort_breaks_event_loop(self, mock_create: Any, mock_build: Any) -> None:
        """When abort_event is set, the planner should stop streaming and emit the sentinel."""
        mock_build.return_value = MagicMock()

        async def _fake_stream(*_a: Any, **_kw: Any):
            yield {'event': 'on_chain_start', 'data': {}}
            yield {'event': 'on_chain_end', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream
        mock_create.return_value = mock_graph

        session = SessionState()
        session.abort_event.set()
        nested_q: asyncio.Queue = asyncio.Queue()

        result = await run_coding_planner_stream(session, 'sess-1', 'task', nested_q, None)

        sentinel_found = False
        while not nested_q.empty():
            item = nested_q.get_nowait()
            if item is NESTED_WORKER_STREAM_END:
                sentinel_found = True
        assert sentinel_found

    @patch('nemo_backend.agents.coding_planner.pipeline.ensure_session_python_workspace_env', new_callable=AsyncMock)
    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_python_workspace_bootstraps_env_before_planning(
        self,
        mock_create: Any,
        mock_build: Any,
        mock_ensure_env: AsyncMock,
        tmp_path: Path,
    ) -> None:
        workspace_root = tmp_path / 'workspace'
        workspace_root.mkdir()
        (workspace_root / 'todo_app.py').write_text('print("hello")\n', encoding='utf-8')
        python_executable = workspace_python_executable(workspace_root)
        python_executable.parent.mkdir(parents=True, exist_ok=True)
        python_executable.write_text('', encoding='utf-8')

        async def _fake_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Planner finished.')},
            }

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream
        mock_create.return_value = mock_graph
        mock_build.return_value = MagicMock()

        async def _fake_ensure(
            session_arg: SessionState,
            *,
            allow_workspace_root_fallback: bool,
            bootstrap_dependencies: bool = False,
            emit_chunk=None,
        ):
            del emit_chunk
            assert allow_workspace_root_fallback is False
            assert bootstrap_dependencies is True
            session_arg.python_workspace_root = str(workspace_root)
            session_arg.python_workspace_root_label = '.'
            session_arg.python_workspace_venv_path = str(workspace_root / '.venv')
            session_arg.python_workspace_python_executable = str(python_executable)
            session_arg.python_workspace_bin_path = str(python_executable.parent)
            return PythonWorkspaceEnvResult(
                ok=True,
                project_root=workspace_root,
                project_root_label='.',
                venv_path=workspace_root / '.venv',
                python_executable=python_executable,
                created=True,
                installed_requirements=['requirements.txt'],
                summary='ready',
            )

        mock_ensure_env.side_effect = _fake_ensure

        session = SessionState(workspace_path=str(workspace_root.resolve()))
        nested_q: asyncio.Queue = asyncio.Queue()

        result = await run_coding_planner_stream(session, 'sess-1', 'Complete `todo_app.py`', nested_q, None)

        assert result == 'Planner finished.'
        assert mock_ensure_env.await_count == 1

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_orphaned_stagings_survive_coding_planner_error(
        self, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()

        async def _failing_stream(*_a: Any, **_kw: Any):
            raise ValueError('specialist boom')
            yield  # pragma: no cover  -- make it an async generator

        mock_graph = MagicMock()
        mock_graph.astream_events = _failing_stream
        mock_create.return_value = mock_graph

        session = SessionState()
        session.pending_edit_stagings = {'foo.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()

        with pytest.raises(ValueError, match='specialist boom'):
            await run_coding_planner_stream(session, 'sess-1', 'task', nested_q, None)

        assert list(session.pending_edit_stagings.keys()) == ['foo.py']
        sentinel_found = False
        while not nested_q.empty():
            if nested_q.get_nowait() is NESTED_WORKER_STREAM_END:
                sentinel_found = True
        assert sentinel_found

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_planner_events_tagged_planner(self, mock_create: Any, mock_build: Any) -> None:
        """Planner graph events should be enqueued with the 'planner' stream tag."""
        mock_build.return_value = MagicMock()

        events = [
            {'event': 'on_chain_start', 'data': {}},
            {'event': 'on_chat_model_start', 'data': {}},
            {'event': 'on_chain_end', 'data': {}},
        ]

        async def _fake_stream(*_a: Any, **_kw: Any):
            for ev in events:
                yield ev

        mock_graph = MagicMock()
        mock_graph.astream_events = _fake_stream
        mock_create.return_value = mock_graph

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()

        await run_coding_planner_stream(session, 'sess-1', 'test task', nested_q, None)

        tagged_events = []
        while not nested_q.empty():
            item = nested_q.get_nowait()
            if item is NESTED_WORKER_STREAM_END:
                continue
            assert isinstance(item, tuple)
            tag, ev = item
            assert tag == 'planner'
            tagged_events.append(ev)

        assert len(tagged_events) >= len(events)
        assert any(ev.get('event') == 'planner_progress' for ev in tagged_events)

    @patch('nemo_backend.agents.coding_planner.pipeline.build_llm')
    @patch('nemo_backend.agents.coding_planner.pipeline.create_agent')
    async def test_empty_final_text_fallback(self, mock_create: Any, mock_build: Any) -> None:
        """When the planner produces no final text, a fallback message is returned."""
        mock_build.return_value = MagicMock()

        async def _empty_stream(*_a: Any, **_kw: Any):
            yield {'event': 'on_chain_start', 'data': {}}

        mock_graph = MagicMock()
        mock_graph.astream_events = _empty_stream
        mock_create.return_value = mock_graph

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()

        result = await run_coding_planner_stream(session, 'sess-1', 'task', nested_q, None)
        assert 'finished without a final text response' in result


class TestPlannerTaskRetryMiddlewareUnit:
    """Middleware is no longer on the planner graph; keep unit coverage for the helper."""

    async def test_planner_retry_middleware_reprompts_incomplete_stop(self) -> None:
        should_retry = True
        middleware = PlannerTaskRetryMiddleware(
            should_retry=lambda: should_retry,
            build_retry_prompt=lambda attempt: f'reflect attempt {attempt}',
            max_retries=2,
        )

        first = await middleware.aafter_model(
            {'messages': [AIMessage(content='All done?')]},
            MagicMock(),
        )
        assert first is not None
        assert first['jump_to'] == 'model'
        assert first['planner_task_retry_streak'] == 1
        assert first['messages'][0].content == 'reflect attempt 1'

        second = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Still done?')],
                'planner_task_retry_streak': 1,
            },
            MagicMock(),
        )
        assert second is not None
        assert second['planner_task_retry_streak'] == 2

        third = await middleware.aafter_model(
            {
                'messages': [AIMessage(content='Stopping again')],
                'planner_task_retry_streak': 2,
            },
            MagicMock(),
        )
        assert third is None

        should_retry = False
        reset = await middleware.aafter_model(
            {'messages': [AIMessage(content='Actually complete')]},
            MagicMock(),
        )
        assert reset == {'planner_task_retry_streak': 0}


class TestOrchestratorDeterministicStream:
    @patch('nemo_backend.agents.coding_planner.orchestrator.build_llm')
    async def test_build_llm_failure_puts_sentinel_then_raises(self, mock_build: Any) -> None:
        mock_build.side_effect = RuntimeError('No API key')
        session = SessionState()
        session.workspace_path = str(Path(__file__).resolve().parent)
        nested_q: asyncio.Queue = asyncio.Queue()
        with pytest.raises(RuntimeError, match='No API key'):
            await run_coding_planner_stream(session, 'sess-1', 'do stuff', nested_q, None)
        assert nested_q.get_nowait() is NESTED_WORKER_STREAM_END
