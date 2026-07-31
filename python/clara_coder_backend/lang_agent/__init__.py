"""LangChain / LangGraph agent core for the Clara Coder sidecar.

Modules
-------
``agent`` — SSE streaming entry and composer-mode dispatch
``graph`` — ``create_agent`` outer graph builder and stream runner
``loop`` — turn outcomes and history-commit policy
``streaming`` — shared SSE JSON helpers (status, chunks, read-tool mirroring)
``pause`` — ``asyncio.Event`` wait for ``POST /chat/agent-continue``
``question`` — plan-mode question HITL staging and resolution
``langgraph_sse`` — LangGraph event → SSE line mapping
"""
