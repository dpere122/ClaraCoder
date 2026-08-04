"""Fail-open, structured-output side LLM call that explains and risk-rates a pending `run_command`."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from clara_coder_backend.config import CLARA_COMMAND_RISK_ASSESS_TIMEOUT_SEC
from clara_coder_backend.llm.factory import build_llm

logger = logging.getLogger('clara.command_risk_assess')


class CommandRiskAssessment(BaseModel):
    """Structured verdict describing a pending shell command and its risk level."""

    description: str = Field(
        description='One-sentence plain-English explanation of what the command does.',
    )
    risk: Literal['low', 'medium', 'high'] = Field(
        description='low/medium/high risk of running this command.',
    )


def _risk_assessment_chain():
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                'You explain shell commands to a non-expert user and rate how risky they are to run.\n\n'
                'Write a single, plain-English sentence describing what the command does (`description`). '
                'Then classify its risk (`risk`):\n'
                "- `low`: read-only or clearly safe commands (listing files, printing versions, "
                'running tests, linters, etc.).\n'
                "- `medium`: commands that modify the workspace or install dependencies but are routine "
                '(writing files, installing packages, git commits, running build scripts).\n'
                "- `high`: destructive, irreversible, or wide-blast-radius commands (deleting files/directories, "
                'force-pushing, changing permissions broadly, formatting disks, piping remote scripts into a '
                'shell, modifying system-level state, or anything outside the working directory).\n\n'
                'Be concise and concrete.',
            ),
            (
                'human',
                'Working directory: {cwd}\n\nCommand:\n{command}',
            ),
        ]
    )
    return prompt | build_llm().with_structured_output(CommandRiskAssessment)


async def assess_command_risk(command_text: str, cwd_label: str) -> CommandRiskAssessment | None:
    """Fail-open: returns None on any error or timeout (never blocks the approval card)."""

    try:
        chain = _risk_assessment_chain()
        return await asyncio.wait_for(
            chain.ainvoke({'command': command_text, 'cwd': cwd_label}),
            timeout=CLARA_COMMAND_RISK_ASSESS_TIMEOUT_SEC,
        )
    except Exception:
        logger.warning('command risk assessment failed', exc_info=True)
        return None


async def maybe_enrich_pending_command_risk(pending: dict[str, Any]) -> None:
    """Mutate `pending` in place with risk_level/risk_description/risk_assessment_status.

    Gated on the `command_line_explain_step` runtime setting and only applies to the
    `run_command` deferred-tool HITL card. No-op (and no LLM call) otherwise, and idempotent
    once `risk_assessment_status` has already been set on `pending`.
    """

    from clara_coder_backend.session.state import runtime_config

    if not runtime_config.tools.command_line_explain_step:
        return
    if pending.get('kind') != ACCEPT_COMMAND_KIND_DEFERRED_TOOL:
        return
    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    if action.get('tool_name') != 'run_command':
        return
    if 'risk_assessment_status' in pending:
        return  # already assessed (defensive; avoids double LLM calls)

    tool_input = action.get('tool_input') if isinstance(action.get('tool_input'), dict) else {}
    command_text = str(tool_input.get('command') or '')
    cwd_label = str(tool_input.get('cwd') or '')

    result = await assess_command_risk(command_text, cwd_label)
    if result is None:
        pending['risk_assessment_status'] = 'failed'
    else:
        pending['risk_assessment_status'] = 'ok'
        pending['risk_level'] = result.risk
        pending['risk_description'] = result.description


__all__ = [
    'CommandRiskAssessment',
    'assess_command_risk',
    'maybe_enrich_pending_command_risk',
]
