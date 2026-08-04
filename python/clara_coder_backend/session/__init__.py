"""Session runtime: live store, HTTP schemas, and LangGraph checkpointing.

Shared env constants live in :mod:`clara_coder_backend.config`.
Shared dataclasses live in :mod:`clara_coder_backend.domain`.

Modules
-------
``state`` — in-memory sessions and ``runtime_config``
``schemas`` — Pydantic request bodies
``chat_input`` — session-owned turn normalization for schemas and routes
``checkpointing`` — LangGraph checkpoint helpers
``pause`` — HITL asyncio pause helpers for agent-continue / question answers
``config`` / ``domain`` — compatibility re-exports (prefer the top-level modules)
"""
