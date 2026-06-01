"""Structured discovery phase for plan mode (intent → read-only ReAct → re-evaluate)."""

from __future__ import annotations

from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.messages import build_system_prompt, stringify_content
from nemo_backend.tool_registry import format_tools_catalog, planner_discovery_tools_and_map
from nemo_backend.workspace_tools import truncate_text

PLAN_DISCOVERY_MAX_ROUNDS = 3

PLAN_DISCOVERY_INTENT_LABEL = 'plan_discovery_intent'
PLAN_DISCOVERY_EXECUTE_LABEL = 'plan_discovery_execute'
PLAN_DISCOVERY_EVALUATE_LABEL = 'plan_discovery_evaluate'


class DiscoveryIntentModel(BaseModel):
    """Read-only discovery actions to run before drafting a plan."""

    actions: list[str] = Field(
        default_factory=list,
        description='Ordered read-only discovery actions (search, read files, inspect structure).',
    )


class DiscoveryEvaluationModel(BaseModel):
    """Synthesis after one discovery executor round."""

    ready_to_plan: bool = Field(
        description='True when enough workspace context exists to draft an accurate plan.',
    )
    summary: str = Field(
        default='',
        description='Concise synthesis of findings so far (paths, patterns, constraints).',
    )
    additional_actions: list[str] = Field(
        default_factory=list,
        description='When not ready, further read-only discovery still needed.',
    )


def build_discovery_context_block(session: SessionState) -> str:
    """System prompt + read-only tool catalog for discovery intent/evaluation."""
    system_prompt = build_system_prompt(session, apply_mode=False)
    tools, _ = planner_discovery_tools_and_map(session=session)
    catalog = format_tools_catalog(tools)
    return (
        f'{system_prompt}\n\n'
        'Available read-only discovery tools (executor bindings for this phase):\n'
        f'{catalog}'
    )


def build_discovery_task_prompt(actions: list[str], *, objective: str) -> str:
    """Format the ReAct executor user message for one discovery round."""
    action_str = '\n'.join(f'{i + 1}. {a}' for i, a in enumerate(actions))
    return (
        f'User objective (for context):\n{objective}\n\n'
        f'Execute these read-only discovery actions now:\n{action_str}\n\n'
        'Use discovery tools only — do not edit, stage, delete, or run mutating commands. '
        'Gather concrete facts (file paths, symbols, existing patterns) needed to plan the work. '
        'When done, summarize what you found.'
    )


def _discovery_intent_chain(discovery_context: str):
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{discovery_context}\n\n'
                'You are in plan mode (discovery intent). Before any implementation plan is written, '
                'decide what read-only discovery actions are needed to understand the workspace.\n\n'
                'Rules:\n'
                '- Output coarse discovery actions only (search, read, list, semantic lookup).\n'
                '- Do NOT output implementation or edit steps.\n'
                '- Prefer minimal actions that resolve unknowns in the user objective.\n'
                '- If prior discovery summary already covers the objective, return an empty `actions` list.',
            ),
            (
                'human',
                """User objective:
{objective}

Prior discovery summary (from earlier rounds, if any):
{prior_summary}

List the next discovery actions to run, or leave `actions` empty if no further discovery is needed.""",
            ),
        ]
    )
    return prompt | build_llm().with_structured_output(DiscoveryIntentModel)


def _discovery_evaluation_chain(discovery_context: str):
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{discovery_context}\n\n'
                'You are in plan mode (discovery evaluation). After read-only discovery tools ran, '
                'synthesize findings and decide whether enough context exists to draft an accurate plan.\n\n'
                'Rules:\n'
                '- Set `ready_to_plan=true` when the objective can be planned with concrete file/path facts.\n'
                '- Put a concise factual `summary` (paths, modules, patterns) — this feeds the planner.\n'
                '- When not ready, set `ready_to_plan=false` and list `additional_actions` only '
                '(do not repeat actions already attempted).',
            ),
            (
                'human',
                """User objective:
{objective}

Discovery actions requested this round:
{actions}

Executor summary:
{executor_summary}

Prior discovery summary (earlier rounds):
{prior_summary}""",
            ),
        ]
    )
    return prompt | build_llm().with_structured_output(DiscoveryEvaluationModel)


async def invoke_discovery_intent(
    *,
    objective: str,
    session: SessionState,
    prior_summary: str = '',
) -> DiscoveryIntentModel:
    chain = _discovery_intent_chain(build_discovery_context_block(session))
    return await chain.ainvoke(
        {
            'objective': objective,
            'prior_summary': prior_summary.strip() or '(none)',
        }
    )


async def invoke_discovery_evaluation(
    *,
    objective: str,
    actions: list[str],
    executor_summary: str,
    session: SessionState,
    prior_summary: str = '',
) -> DiscoveryEvaluationModel:
    action_str = '\n'.join(f'{i + 1}. {a}' for i, a in enumerate(actions)) or '(none)'
    summary = truncate_text(stringify_content(executor_summary).strip(), 4000) or '(no summary)'
    chain = _discovery_evaluation_chain(build_discovery_context_block(session))
    return await chain.ainvoke(
        {
            'objective': objective,
            'actions': action_str,
            'executor_summary': summary,
            'prior_summary': prior_summary.strip() or '(none)',
        }
    )


__all__ = [
    'DiscoveryEvaluationModel',
    'DiscoveryIntentModel',
    'PLAN_DISCOVERY_EVALUATE_LABEL',
    'PLAN_DISCOVERY_EXECUTE_LABEL',
    'PLAN_DISCOVERY_INTENT_LABEL',
    'PLAN_DISCOVERY_MAX_ROUNDS',
    'build_discovery_context_block',
    'build_discovery_task_prompt',
    'invoke_discovery_evaluation',
    'invoke_discovery_intent',
]
