"""Parent LangGraph for phased outer Clara: Learn → Write → Verify (optional verify→learn retry).

Each phase is a ``create_agent`` subgraph with a filtered tool list from :mod:`nemo_backend.tool_registry`.
Nested ``plan_and_modify`` / ``execute_workspace_mutation`` run only on the **write** subgraph (with
:class:`~nemo_backend.agents.planning.nested_middleware.PlanningNestedWorkerMiddleware`).
**Verify** may finish staged→workspace transfers, then run pytest, smoke test, and LSP reads.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from langchain.agents import create_agent
from langchain_core.messages import AnyMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field
from typing_extensions import Annotated, NotRequired, TypedDict

from nemo_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from nemo_backend.checkpointing import get_graph_checkpointer
from nemo_backend.copy_review_middleware import CopyReviewAfterToolMiddleware
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.messages import build_system_prompt, stringify_content
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.state import runtime_config
from nemo_backend.tool_harness_feedback_middleware import _pytest_body_suggests_failure, prepend_harness_feedback_middleware
from nemo_backend.tool_registry import (
    OUTER_VERIFY_ONLY_TOOL_NAMES,
    outer_phased_learn_tools_and_map,
    outer_phased_verify_tools_and_map,
    outer_phased_write_tools_and_map,
)

logger = logging.getLogger('nemo.agent.langgraph.outer_cycle')

MAX_VERIFY_LEARN_RETRIES = 2
_ROUTER_TRANSCRIPT_CHARS = 8000


class LearnPhaseRouterDecision(BaseModel):
    needs_implementation: bool = Field(
        description='True when the user still needs workspace edits, installs, or nested plan/mutate work this turn.'
    )


class OuterPhasedCodingGraphState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    outer_coding_retry_count: NotRequired[int]


def _tail_transcript(msgs: list[AnyMessage], *, max_chars: int) -> str:
    parts: list[str] = []
    total = 0
    for m in reversed(msgs):
        role = getattr(m, 'type', None) or m.__class__.__name__
        body = stringify_content(getattr(m, 'content', ''))
        chunk = f'[{role}]\n{body}\n'
        if total + len(chunk) > max_chars:
            break
        parts.append(chunk)
        total += len(chunk)
    return '\n'.join(reversed(parts))


def _route_after_learn(state: OuterPhasedCodingGraphState) -> Literal['write', 'end']:
    msgs = state.get('messages') or []
    tail = _tail_transcript(msgs, max_chars=_ROUTER_TRANSCRIPT_CHARS)
    try:
        from nemo_backend.llm import build_llm

        llm = build_llm()
        structured = llm.with_structured_output(LearnPhaseRouterDecision)
        out = structured.invoke(
            [
                SystemMessage(
                    content=(
                        'You route a coding-assistant turn after a **read-only learn** phase. '
                        'Given the user request and the assistant reply, return needs_implementation=true when the '
                        'user still needs filesystem edits, dependency installs, staging, or nested plan/mutate tools '
                        'this turn. Return false for pure explanation, navigation, or read-only Q&A.'
                    )
                ),
                HumanMessage(content=f'Conversation tail:\n{tail}'),
            ],
        )
        if isinstance(out, LearnPhaseRouterDecision) and out.needs_implementation:
            return 'write'
        if isinstance(out, dict) and out.get('needs_implementation'):
            return 'write'
    except Exception:
        logger.exception('outer phased: learn router failed; defaulting to write')
        return 'write'
    return 'end'


def _route_after_verify(state: OuterPhasedCodingGraphState) -> Literal['prepare_retry', 'end']:
    msgs = state.get('messages') or []
    failed = False
    from langchain_core.messages import ToolMessage

    for m in reversed(msgs[-60:]):
        if isinstance(m, ToolMessage) and m.name in OUTER_VERIFY_ONLY_TOOL_NAMES:
            if _pytest_body_suggests_failure(stringify_content(m.content)):
                failed = True
                break
    n = int(state.get('outer_coding_retry_count') or 0)
    if failed and n < MAX_VERIFY_LEARN_RETRIES:
        return 'prepare_retry'
    return 'end'


def _prepare_verify_retry(state: OuterPhasedCodingGraphState) -> dict[str, Any]:
    n = int(state.get('outer_coding_retry_count') or 0) + 1
    return {
        'outer_coding_retry_count': n,
        'messages': [
            HumanMessage(
                content=(
                    '[Outer coding cycle — verify→learn]\n'
                    'Workspace tests or diagnostics reported problems (or ambiguous output). '
                    'Re-inspect with read/search and LSP reads; a write phase will follow again in this turn.'
                ),
            ),
        ],
    }


def _core_middleware(extra: list[Any] | None) -> list[Any]:
    core: list[Any] = [ConnectionParallelToolCallsMiddleware(), EmptyResponseNudgeMiddleware()]
    if extra:
        core.extend(extra)
    core.extend(
        [
            AcceptCommandReviewAfterToolMiddleware(),
            CopyReviewAfterToolMiddleware(),
            DeleteReviewAfterToolMiddleware(),
            DiffReviewAfterToolMiddleware(),
        ],
    )
    return prepend_harness_feedback_middleware(core)


def build_outer_phased_coding_cycle_graph(
    llm: Any,
    session: SessionState,
    apply_mode: bool,
    *,
    extra_middleware: list[Any] | None = None,
) -> Any:
    """Compile parent graph: learn → (write → verify)* with bounded verify→learn retries."""
    if not apply_mode:
        raise ValueError('outer phased coding graph requires apply_mode=True')

    learn_tools, _ = outer_phased_learn_tools_and_map()
    write_tools, _ = outer_phased_write_tools_and_map()
    verify_tools, _ = outer_phased_verify_tools_and_map()

    learn_mw = _core_middleware(None)
    write_mw = _core_middleware(extra_middleware)
    verify_mw = _core_middleware(None)

    learn_graph = create_agent(
        llm,
        learn_tools,
        system_prompt=build_system_prompt(session, apply_mode, outer_cycle_phase='learn'),
        name='nemo_outer_phased_learn',
        middleware=learn_mw,
        checkpointer=None,
    )
    write_graph = create_agent(
        llm,
        write_tools,
        system_prompt=build_system_prompt(session, apply_mode, outer_cycle_phase='write'),
        name='nemo_outer_phased_write',
        middleware=write_mw,
        checkpointer=None,
    )
    verify_graph = create_agent(
        llm,
        verify_tools,
        system_prompt=build_system_prompt(session, apply_mode, outer_cycle_phase='verify'),
        name='nemo_outer_phased_verify',
        middleware=verify_mw,
        checkpointer=None,
    )

    graph = StateGraph(OuterPhasedCodingGraphState)
    graph.add_node('learn', learn_graph)
    graph.add_node('write', write_graph)
    graph.add_node('verify', verify_graph)
    graph.add_node('prepare_retry', _prepare_verify_retry)
    graph.add_edge(START, 'learn')
    graph.add_conditional_edges('learn', _route_after_learn, {'write': 'write', 'end': END})
    graph.add_edge('write', 'verify')
    graph.add_conditional_edges('verify', _route_after_verify, {'prepare_retry': 'prepare_retry', 'end': END})
    graph.add_edge('prepare_retry', 'learn')
    return graph.compile(checkpointer=get_graph_checkpointer())
