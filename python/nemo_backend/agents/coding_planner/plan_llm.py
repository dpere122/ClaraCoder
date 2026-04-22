"""Bounded LLM calls for coding-planner plan text (probe + structured build steps)."""

from __future__ import annotations

import logging
import warnings
from typing import Any, TypeVar

from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field

from nemo_backend.agents.coding_planner.planner_core import TaskComplexityProfile, plan_requirements_text
from nemo_backend.llm import build_llm

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')

_T = TypeVar('_T', bound=BaseModel)


async def _ainvoke_structured_without_serializer_warnings(
    structured: Any, messages: list[Any]
) -> Any:
    """Run structured LLM invoke; suppress Pydantic tracing noise (see note below).

    LangChain + Pydantic v2 can emit ``UserWarning: Pydantic serializer warnings`` when
    callbacks serialize runnable output whose schema overlaps ``parsed``/None unions.
    The returned model is valid; the warning is from internal tracing serialization.
    """
    with warnings.catch_warnings():
        warnings.filterwarnings(
            'ignore',
            message=r'.*Pydantic serializer warnings.*',
            category=UserWarning,
        )
        return await structured.ainvoke(messages)


def _as_model_instance(model_cls: type[_T], out: Any) -> _T | None:
    """Normalize structured output to a fresh model (plain ``dict`` / dump OK for tracing)."""
    if isinstance(out, model_cls):
        return out
    if isinstance(out, dict):
        try:
            return model_cls.model_validate(out)
        except Exception:
            return None
    return None


class PlanProbeSteps(BaseModel):
    """Structured build-only steps from the plan probe LLM (1–6 items)."""

    steps: list[str] = Field(
        min_length=1,
        max_length=6,
        description='Numbered implementation steps only; no read/search/list steps.',
    )


class BuildPlanSteps(BaseModel):
    """Structured checklist for the orchestrator after discovery (bounded step count)."""

    steps: list[str] = Field(
        min_length=1,
        max_length=12,
        description=(
            'Ordered build-only steps: one imperative line each, no discovery/read steps, '
            'no duplicate or tentative alternatives—final checklist only.'
        ),
    )


async def run_plan_probe_llm(task_summary: str) -> list[str] | None:
    """Return 1–6 build step strings, or None if the probe cannot run."""
    cleaned = (task_summary or '').strip() or '(empty task summary)'
    try:
        llm = build_llm()
    except Exception:
        logger.exception('plan probe: failed to build LLM')
        return None
    probe_prompt = (
        'You classify an implementation plan for a software workspace task.\n'
        'Return ONLY concrete build/mutation/verification steps (not read/search/list/inspect steps).\n'
        'Be honest about how many steps are needed: if the task truly needs four or more distinct build steps, '
        'list all of them (up to six). If it needs fewer, list only those.\n'
        'Each step must be a short imperative line (edit file X, add test Y, run Z).\n\n'
        f'Task:\n{cleaned}'
    )
    try:
        structured = llm.with_structured_output(PlanProbeSteps)
        raw = await _ainvoke_structured_without_serializer_warnings(
            structured, [HumanMessage(content=probe_prompt)]
        )
        out = _as_model_instance(PlanProbeSteps, raw)
    except Exception:
        logger.exception('plan probe: structured invoke failed')
        return None
    if out is None:
        return None
    steps = [s.strip() for s in out.steps if isinstance(s, str) and s.strip()]
    return steps or None


async def run_structured_build_plan_llm(
    task_summary: str,
    *,
    profile: TaskComplexityProfile,
    discovery_notes: str,
    validation_feedback: str | None = None,
) -> list[str] | None:
    """Single structured call to produce build steps after discovery (or task-only if notes empty)."""
    cleaned = (task_summary or '').strip() or '(empty task summary)'
    requirements = plan_requirements_text(profile, cleaned)
    notes = (discovery_notes or '').strip() or '(no discovery notes — rely on task text)'
    feedback = (validation_feedback or '').strip()
    feedback_block = f'\n\nYou must fix the following validation issue from the orchestrator:\n{feedback}\n' if feedback else ''
    prompt = (
        'You produce **one** build checklist for a workspace coding task.\n'
        'Return ONLY concrete implementation, build, dependency, test, or verification steps.\n'
        'Do not include read/search/list/inspect/discover steps.\n'
        'Do not include meta-commentary, alternatives, confidence notes, or a second pass—emit the final list once.\n'
        'Each step must be one short imperative line (start with a verb: add, update, remove, implement, wire, verify).\n'
        'Obey the plan sizing requirements exactly.\n'
        f'{feedback_block}\n'
        f'Task:\n{cleaned}\n\n'
        f'Discovery notes (hints):\n{notes}\n\n'
        'Plan sizing requirements:\n'
        f'{requirements}\n'
    )
    try:
        llm = build_llm()
        structured = llm.with_structured_output(BuildPlanSteps)
        raw = await _ainvoke_structured_without_serializer_warnings(
            structured, [HumanMessage(content=prompt)]
        )
        out = _as_model_instance(BuildPlanSteps, raw)
    except Exception:
        logger.exception('structured build plan: invoke failed')
        return None
    if out is None:
        return None
    steps = [s.strip() for s in out.steps if isinstance(s, str) and s.strip()]
    return steps or None
