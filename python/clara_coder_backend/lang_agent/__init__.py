"""LangChain / LangGraph agent core for the Clara Coder sidecar.

Composer dispatch (agent vs plan mode) lives in :mod:`clara_coder_backend.composer`.

Modules
-------
``graph`` — ``create_agent`` outer graph builder and stream runner
``loop`` — turn outcomes and history-commit policy
``streaming`` — shared SSE JSON helpers (status, chunks, read-tool mirroring)
``pause`` — compatibility re-export of :mod:`clara_coder_backend.session.pause`
``question`` — plan-mode question HITL staging and resolution
``langgraph_sse`` — LangGraph event → SSE line mapping
``context_compression`` — post-turn checkpoint compaction
"""
