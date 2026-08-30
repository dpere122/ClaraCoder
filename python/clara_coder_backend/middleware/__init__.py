"""LangGraph agent middleware for the Clara Coder sidecar.

Modules
-------
``diff_review_middleware`` — pause after diff-emitting tools
``delete_review_middleware`` — pause after delete HITL
``copy_review_middleware`` — pause after copy HITL
``accept_command_review_middleware`` — pause after accept-command HITL
``empty_response_middleware`` — nudge on empty model turns
``flush_untransferred_staging_middleware`` — ``after_agent`` node that returns leftover staged drafts to the model until resolved
``parallel_tool_middleware`` — inject ``parallel_tool_calls`` from runtime
``briefing_disable_thinking_middleware`` — pin thinking off for Clara's first-turn briefing (Gemma and Qwen honor thinking settings on every agent call)
``vision_tool_middleware`` — vision / multimodal tool message shaping
``user_event_injection_middleware`` — inject queued user events into the turn
``gemma_native_tool_middleware`` — promote Gemma ``<|tool_call>`` markup into API tool_calls
``pseudo_tool_xml_middleware`` — recover pseudo tool calls from XML-ish text
``tool_harness_feedback_middleware`` — harness feedback injection
``context_pack_activation_middleware`` — auto-activate deferred context packs on tool use
``mid_turn_compaction_middleware`` — shrink older tool bodies before each model call
"""
