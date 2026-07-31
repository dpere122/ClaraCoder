"""Lightweight structured-LLM verifier for plan-mode step completion."""

from __future__ import annotations

from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from clara_coder_backend.llm.factory import build_llm
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.tools.workspace import truncate_text

VERIFY_PLAN_STEP_LABEL = 'verify_plan_step'

# Executor retries after a verifier rejection (initial attempt + this many retries).
PLAN_STEP_VERIFY_MAX_RETRIES = 2


class StepVerifyResult(BaseModel):
    """Structured verdict after one plan step executor finishes."""

    approved: bool = Field(
        description='True when the step objective was clearly accomplished based on the executor summary.',
    )
    evidence: str = Field(
        default='',
        description='Brief justification: what was done, or what is still missing.',
    )
    feedback: str = Field(
        default='',
        description='When not approved, concrete instructions for the executor to fix on retry.',
    )


def _step_verifier_chain():
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                'You are a plan-step verifier. After the executor agent finishes one plan step, '
                'decide whether that step was actually completed — not merely described or deferred.\n\n'
                'Approve (`approved=true`) only when the executor summary shows concrete work matching '
                'the step text (edits made, files read/written, commands run, etc.).\n\n'
                'Reject (`approved=false`) when:\n'
                '- The executor deferred work to a later step or said work is "queued"/"pending".\n'
                '- The summary is vague with no evidence the step\'s deliverable exists.\n'
                '- The step required a specific outcome that clearly did not happen.\n\n'
                'When rejecting, set `feedback` to short, actionable instructions for a retry. '
                'Set `evidence` to one or two sentences citing the summary.',
            ),
            (
                'human',
                """Overall user objective:
{objective}

Full plan:
{plan}

Step under review (#{step_number}):
{step_text}

Executor summary for this step:
{executor_summary}""",
            ),
        ]
    )
    return prompt | build_llm().with_structured_output(StepVerifyResult)


async def invoke_step_verifier(
    *,
    objective: str,
    plan_steps: list[str],
    step_index: int,
    executor_summary: str,
) -> StepVerifyResult:
    """Return structured approve/reject for one completed executor turn."""

    plan_str = '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(plan_steps)) or '(empty)'
    summary = truncate_text(stringify_content(executor_summary).strip(), 4000) or '(no summary)'
    chain = _step_verifier_chain()
    return await chain.ainvoke(
        {
            'objective': objective,
            'plan': plan_str,
            'step_number': step_index + 1,
            'step_text': plan_steps[step_index],
            'executor_summary': summary,
        }
    )


__all__ = [
    'PLAN_STEP_VERIFY_MAX_RETRIES',
    'StepVerifyResult',
    'VERIFY_PLAN_STEP_LABEL',
    'invoke_step_verifier',
]
