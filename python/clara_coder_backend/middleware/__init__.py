"""LangGraph agent middleware for the Clara Coder sidecar.

Modules
-------
``delete_review_middleware`` — pause when a directory delete is too large to journal
``accept_command_review_middleware`` — pause after accept-command HITL
``agent_nudge_event`` — the stream event a finish gate sends when it hands an answer back
``context_compaction_middleware`` — keep model calls inside the context window; budget tool results
``parallel_tool_middleware`` — inject ``parallel_tool_calls`` from runtime
``tool_batch_middleware`` — tag each tool call with the model message (batch) that issued it
``vision_tool_middleware`` — vision / multimodal tool message shaping
``user_event_injection_middleware`` — inject queued user events into the turn (and keep them in the thread)
``append_only_context_middleware`` — a Claude thread keeps its first system prompt and tools; changes are appended
``gemma_native_tool_middleware`` — promote Gemma ``<|tool_call>`` markup into API tool_calls
``pseudo_tool_xml_middleware`` — recover pseudo tool calls from XML-ish text
``tool_harness_feedback_middleware`` — harness feedback injection
``context_pack_activation_middleware`` — auto-activate deferred context packs on tool use
``finish_gates_middleware`` — one graph node for the gates on an answer without tool calls
``turn_verification_middleware`` — check an editing turn (LSP errors, check commands) before it ends
``plan_pending_steps_middleware`` — plan execution: hand unchecked steps back to the executor once
"""
