"""Tests for the nested router/specialist planning pipeline."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage

from nemo_backend.agents.orchestration.nested_pipeline import (
    NESTED_WORKER_STREAM_END,
    run_final_project_review_stream,
    run_planning_nested_stream,
)
from nemo_backend.domain import EditStagingEntry, SessionState

pytestmark = pytest.mark.asyncio(loop_scope='function')


class TestRunPlanningNestedStream:
    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    async def test_dependency_specialist_route_is_available_and_returns_result(
        self, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _dependency_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Installed workspace packages and refreshed requirements.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        dependency_graph = MagicMock()
        dependency_graph.astream_events = _dependency_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return dependency_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'dependency task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_dependency_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Install missing Python packages for the workspace.'})

        assert result == 'Installed workspace packages and refreshed requirements.'

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_handoff_includes_staged_paths_and_test_refs(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        captured_review_messages: list[str] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_stream(inputs: Any, *_a: Any, **_kw: Any):
            captured_review_messages.append(inputs['messages'][0].content)
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `python/nemo_backend/main.py` to the workspace apply flow.'},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {
            'python/nemo_backend/main.py': MagicMock(),
            'python/tests/test_main.py': MagicMock(),
        }
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        await route_tool.ainvoke({'task_instruction': 'Review the Python backend change.'})

        release_router.set()
        await task

        assert len(captured_review_messages) == 1
        review_message = captured_review_messages[0]
        assert 'Staged paths:' in review_message
        assert '`python/nemo_backend/main.py`' in review_message
        assert 'Related staged test files:' in review_message
        assert '`python/tests/test_main.py`' in review_message

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_specialist_activates_staging_lsp_scope(
        self, mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `task_manager.py` to the workspace apply flow.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Approved and transferred.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'task_manager.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert result == 'Approved and transferred.'
        mock_activate_scope.assert_called_once_with('sess-1', scope='staging')

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_specialist_requires_real_decision_tool(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Action: Transfer to workspace')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'task_manager.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert 'finished without calling' in result
        assert 'transfer_staged_file_to_workspace' in result
        assert 'task_manager.py' in result

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_specialist_retries_once_after_missing_decision_tool(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        captured_review_messages: list[str] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_stream(inputs: Any, *_a: Any, **_kw: Any):
            captured_review_messages.append(inputs['messages'][0].content)
            if len(captured_review_messages) == 1:
                yield {
                    'event': 'on_chat_model_end',
                    'data': {'output': AIMessage(content='Action: Transfer to workspace')},
                }
                return
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `task_manager.py` to the workspace apply flow.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Approved and transferred.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'task_manager.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert result == 'Approved and transferred.'
        assert len(captured_review_messages) == 2
        assert 'previous review turn ended without calling the required decision tool' in captured_review_messages[1]

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_specialist_accepts_successful_transfer_tool(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `task_manager.py` to the workspace apply flow.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Approved and transferred.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'task_manager.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert result == 'Approved and transferred.'

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_write_specialist_auto_handoffs_staged_code_review(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        captured_review_messages: list[str] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _create_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_chat_model_end',
                'data': {
                    'output': AIMessage(
                        content='Staged `main.py` for code review (nested planning). The workspace file is not updated yet.'
                    )
                },
            }

        async def _review_stream(inputs: Any, *_a: Any, **_kw: Any):
            captured_review_messages.append(inputs['messages'][0].content)
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `main.py` to the workspace apply flow.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Approved and transferred.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        create_graph = MagicMock()
        create_graph.astream_events = _create_stream
        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        specialist_graphs = [create_graph, review_graph]

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return specialist_graphs.pop(0)

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'main.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_write_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Create `main.py` with the requested app.'})

        assert 'Code review outcome:' in result
        assert 'Approved and transferred.' in result
        assert len(captured_review_messages) == 1
        assert 'Complete the staged review now.' in captured_review_messages[0]
        assert 'Create `main.py` with the requested app.' in captured_review_messages[0]

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_rejection_stays_inside_nested_writer_reviewer_loop(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        captured_update_messages: list[str] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_reject_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'reject_staged_workspace_edit',
                'data': {
                    'output': (
                        'Rejected staged edit for `task_manager.py`. Return this to the router so it can hand off '
                        'to the create/update specialist again.\n\nReviewer feedback:\nUse `json.load()` in the '
                        'same method and keep the change scoped to `load_from_json`.'
                    )
                },
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Please revise and try again.')},
            }

        async def _update_stream(inputs: Any, *_a: Any, **_kw: Any):
            captured_update_messages.append(inputs['messages'][0].content)
            session.pending_edit_stagings['task_manager.py'].merged_text = 'draft v2\n'
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Revised the staged implementation.')},
            }

        async def _review_accept_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'transfer_staged_file_to_workspace',
                'data': {'output': 'Transferred staged `task_manager.py` to the workspace apply flow.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Approved after revision.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        reject_review_graph = MagicMock()
        reject_review_graph.astream_events = _review_reject_stream
        update_graph = MagicMock()
        update_graph.astream_events = _update_stream
        accept_review_graph = MagicMock()
        accept_review_graph.astream_events = _review_accept_stream

        specialist_graphs = [reject_review_graph, update_graph, accept_review_graph]

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return specialist_graphs.pop(0)

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {'task_manager.py': MagicMock()}
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert result == 'Approved after revision.'
        assert len(captured_update_messages) == 1
        assert 'Code review revision round: 1' in captured_update_messages[0]
        assert 'Reviewer feedback:' in captured_update_messages[0]
        assert 'load_from_json' in captured_update_messages[0]
        assert 'Do not create a new plan' in captured_update_messages[0]

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    async def test_code_review_rejection_stops_when_update_leaves_staged_draft_unchanged(
        self, _mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        async def _review_reject_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'reject_staged_workspace_edit',
                'data': {
                    'output': (
                        'Rejected staged edit for `task_manager.py`. Return this to the router so it can hand off '
                        'to the create/update specialist again. Stop this review turn after calling this tool.\n\n'
                        'Reviewer feedback:\nTighten the validation logic in `Task.save`.'
                    )
                },
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Please revise and try again.')},
            }

        async def _update_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Revised the staged implementation.')},
            }

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream
        reject_review_graph = MagicMock()
        reject_review_graph.astream_events = _review_reject_stream
        update_graph = MagicMock()
        update_graph.astream_events = _update_stream

        specialist_graphs = [reject_review_graph, update_graph]

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
                return router_graph
            return specialist_graphs.pop(0)

        mock_create.side_effect = _capture_create

        session = SessionState()
        session.pending_edit_stagings = {
            'task_manager.py': EditStagingEntry(
                temp_path='staged/task_manager.py',
                old_text='old\n',
                merged_text='draft v1\n',
                disk_encoding='utf-8',
                disk_newline='lf',
                edit_mode='full-file',
            )
        }
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(run_planning_nested_stream(session, 'sess-1', 'review task', nested_q, None))
        await asyncio.sleep(0)

        route_tool = next(tool for tool in captured_router_tools if tool.name == 'route_code_review_specialist')
        result = await route_tool.ainvoke({'task_instruction': 'Review `task_manager.py`'})

        assert 'write specialist finished after a code review rejection' in result
        assert 'staged draft did not change' in result

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch(
        'nemo_backend.agents.orchestration.nested_pipeline.maybe_bootstrap_python_workspace_env_for_project_review',
        new_callable=AsyncMock,
    )
    async def test_project_review_specialist_is_blocked_during_regular_step_execution(
        self, mock_bootstrap: AsyncMock, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        captured_router_tools: list[Any] = []
        release_router = asyncio.Event()

        async def _router_stream(*_a: Any, **_kw: Any):
            await release_router.wait()
            yield {'event': 'on_chain_start', 'data': {}}

        router_graph = MagicMock()
        router_graph.astream_events = _router_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get('name') == 'nemo_planning_router':
                captured_router_tools.extend(args[1])
            return router_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(
            run_planning_nested_stream(
                session,
                'sess-1',
                'regular step task',
                nested_q,
                None,
            )
        )
        await asyncio.sleep(0)

        tool_names = {tool.name for tool in captured_router_tools}
        assert 'route_dependency_specialist' in tool_names
        assert 'route_project_review_specialist' not in tool_names
        mock_bootstrap.assert_not_awaited()

        release_router.set()
        await task

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    @patch(
        'nemo_backend.agents.orchestration.nested_pipeline.maybe_bootstrap_python_workspace_env_for_project_review',
        new_callable=AsyncMock,
    )
    async def test_run_final_project_review_stream_accepts_approval_tool(
        self, mock_bootstrap: AsyncMock, mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_bootstrap.return_value = (
            'Python workspace environment summary:\n'
            '- Workspace root: `python/`\n'
            '- Virtual environment: `python/.venv` (created)\n'
        )
        captured_review_messages: list[str] = []

        async def _review_stream(inputs: Any, *_a: Any, **_kw: Any):
            captured_review_messages.append(inputs['messages'][0].content)
            yield {
                'event': 'on_tool_end',
                'name': 'approve_project_review',
                'data': {'output': 'Project review approved.\n\nSummary:\nWorkspace tests passed.'},
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Workspace tests passed.')},
            }

        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            assert kwargs.get('name') == 'nemo_specialist_project_review'
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        result = await run_final_project_review_stream(
            session, 'sess-1', 'Review the completed workspace.', nested_q, None
        )

        assert result == 'Workspace tests passed.'
        mock_activate_scope.assert_called_once_with('sess-1', scope='workspace')
        assert len(captured_review_messages) == 1
        assert 'Python workspace bootstrap already ran before this final review.' in captured_review_messages[0]
        assert 'Workspace root: `python/`' in captured_review_messages[0]
        assert 'real pytest signal' in captured_review_messages[0]
        assert 'smoke test' in captured_review_messages[0]
        end = None
        while True:
            item = await asyncio.wait_for(nested_q.get(), timeout=1)
            if item is NESTED_WORKER_STREAM_END:
                end = item
                break
        assert end is NESTED_WORKER_STREAM_END

    @patch('nemo_backend.agents.orchestration.nested_pipeline.build_llm')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.create_agent')
    @patch('nemo_backend.agents.orchestration.nested_pipeline.activate_session_lsp_scope')
    @patch(
        'nemo_backend.agents.orchestration.nested_pipeline.maybe_bootstrap_python_workspace_env_for_project_review',
        new_callable=AsyncMock,
    )
    async def test_run_final_project_review_stream_rejection_returns_final_review_error(
        self, mock_bootstrap: AsyncMock, mock_activate_scope: Any, mock_create: Any, mock_build: Any
    ) -> None:
        mock_build.return_value = MagicMock()
        mock_bootstrap.return_value = ''

        async def _review_stream(*_a: Any, **_kw: Any):
            yield {
                'event': 'on_tool_end',
                'name': 'reject_project_review',
                'data': {
                    'output': (
                        'Project review rejected.\n\nReviewer feedback:\n'
                        'Pytest failed in `tests/test_main.py::test_value`; update `main.py` to restore the old contract.'
                    )
                },
            }
            yield {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='Project review failed.')},
            }

        review_graph = MagicMock()
        review_graph.astream_events = _review_stream

        def _capture_create(*args: Any, **kwargs: Any) -> Any:
            assert kwargs.get('name') == 'nemo_specialist_project_review'
            return review_graph

        mock_create.side_effect = _capture_create

        session = SessionState()
        nested_q: asyncio.Queue = asyncio.Queue()
        result = await run_final_project_review_stream(
            session, 'sess-1', 'Review the completed workspace.', nested_q, None
        )

        assert result.startswith('Tool error: final project review failed.')
        assert 'minimum workspace fixes needed' in result
        assert 'tests/test_main.py::test_value' in result
        mock_activate_scope.assert_called_once_with('sess-1', scope='workspace')
        end = None
        while True:
            item = await asyncio.wait_for(nested_q.get(), timeout=1)
            if item is NESTED_WORKER_STREAM_END:
                end = item
                break
        assert end is NESTED_WORKER_STREAM_END
