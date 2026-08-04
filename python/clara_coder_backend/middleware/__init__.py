"""LangGraph agent middleware for the Clara Coder sidecar.

Modules
-------
``diff_review_middleware`` — pause after diff-emitting tools
``delete_review_middleware`` — pause after delete HITL
``copy_review_middleware`` — pause after copy HITL
``accept_command_review_middleware`` — pause after accept-command HITL
``empty_response_middleware`` — nudge on empty model turns
``parallel_tool_middleware`` — inject ``parallel_tool_calls`` from runtime
``vision_tool_middleware`` — vision / multimodal tool message shaping
``user_event_injection_middleware`` — inject queued user events into the turn
``pseudo_tool_xml_middleware`` — recover pseudo tool calls from XML-ish text
``tool_harness_feedback_middleware`` — harness feedback injection
``context_pack_activation_middleware`` — auto-activate deferred context packs on tool use
"""
