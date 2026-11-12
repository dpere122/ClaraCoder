"""Run the gates on an answer without tool calls as one graph node.

Every middleware with an ``after_model`` hook is its own graph node, and each node is a step against
the turn's step limit on every model call. The gates below only act when the model tries to finish,
so they share one node: the step budget of a turn does not shrink with each gate added.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import ContextT
from langgraph.runtime import Runtime
from typing_extensions import override


class FinishGatesMiddleware(AgentMiddleware):
    """Call each gate's hooks in order; the first gate that sends the turn back to the model wins.

    Listed first among the agent's middleware so its ``after_model`` runs last, after tool-call
    promotion (Gemma / pseudo-XML) has settled whether the answer really has no tool calls.
    """

    def __init__(self, gates: list[AgentMiddleware]) -> None:
        super().__init__()
        self.gates = list(gates)

    @override
    async def abefore_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        update: dict[str, Any] = {}
        for gate in self.gates:
            if type(gate).abefore_model is AgentMiddleware.abefore_model:
                continue
            result = await gate.abefore_model(state, runtime)
            if not result:
                continue
            messages = [*update.get('messages', []), *result.get('messages', [])]
            update.update(result)
            if messages:
                update['messages'] = messages
        return update or None

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        for gate in self.gates:
            result = await gate.aafter_model(state, runtime)
            if result is not None:
                return result
        return None


__all__ = ['FinishGatesMiddleware']
