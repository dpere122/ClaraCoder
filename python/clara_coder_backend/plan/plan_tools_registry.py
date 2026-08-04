"""Plan-mode tool bindings (editor surface + build-plan helpers)."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_registry import merge_tools_replace_by_name, worker_tools_and_map


def plan_execute_tools_and_map(
    apply_mode: bool = True,
    *,
    session: SessionState | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    """Plan execution bindings: full editor tools plus build-plan read/mark helpers."""
    del apply_mode  # Plan execution always uses full editor-capable bindings.
    from clara_coder_backend.plan.build_plan_tools import build_plan_tools

    tools, mapping = worker_tools_and_map(True, session=session)
    return merge_tools_replace_by_name(tools, mapping, [('build_plan', build_plan_tools())])


__all__ = ['plan_execute_tools_and_map']
