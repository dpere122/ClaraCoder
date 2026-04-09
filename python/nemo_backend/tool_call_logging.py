"""Structured logging of LLM tool invocations (inputs/outputs) for Health / diagnostics.

Logs under ``nemo.tools.invoke``. At INFO, payloads are truncated; at DEBUG, much larger
payloads are logged. Aligns with health logging plan (centralized ``nemo.*`` loggers).
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger('nemo.tools.invoke')

_TRUNC_INFO = 12_000
_TRUNC_DEBUG = 400_000


def _agent_tool_lead(tool_name: str, agent_role: str | None) -> str:
    tool = (tool_name or '').strip() or 'tool'
    role = (agent_role or '').strip()
    if role:
        return f'{role} · {tool}'
    return tool


def _preview(obj: Any, max_len: int) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str, indent=None)
    except Exception:
        s = repr(obj)
    if len(s) <= max_len:
        return s
    return s[: max(0, max_len - 24)] + '\n… [truncated for log]\n'


def _limit() -> int:
    return _TRUNC_DEBUG if logger.isEnabledFor(logging.DEBUG) else _TRUNC_INFO


def log_llm_tool_input(
    tool_name: str,
    args: dict[str, Any],
    *,
    run_id: str | None = None,
    agent_role: str | None = None,
) -> None:
    if not logger.isEnabledFor(logging.INFO):
        return
    lead = _agent_tool_lead(tool_name, agent_role)
    bits: list[str] = []
    if run_id:
        bits.append(f'run_id={run_id}')
    suffix = (' ' + ' '.join(bits)) if bits else ''
    logger.info('%s — LLM tool in%s args=%s', lead, suffix, _preview(args, _limit()))


def log_llm_tool_output(
    tool_name: str,
    result_text: str,
    *,
    ok: bool,
    run_id: str | None = None,
    agent_role: str | None = None,
    error_detail: str = '',
) -> None:
    if not logger.isEnabledFor(logging.INFO):
        return
    lead = _agent_tool_lead(tool_name, agent_role)
    bits: list[str] = []
    if run_id:
        bits.append(f'run_id={run_id}')
    suffix = (' ' + ' '.join(bits)) if bits else ''
    err = f' error={_preview(error_detail, min(_limit(), 4000))}' if error_detail else ''
    logger.info(
        '%s — LLM tool out%s ok=%s%s result=%s',
        lead,
        suffix,
        ok,
        err,
        _preview(result_text, _limit()),
    )
