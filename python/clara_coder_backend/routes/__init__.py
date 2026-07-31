"""FastAPI routers for the Clara Coder sidecar.

Modules
-------
``runtime`` — health check and runtime config
``session`` — session lifecycle and workspace attachment
``chat`` — chat streaming and agent continuation (HITL)
``audio`` — transcription and TTS
``log`` — log tail, stream, level control, ingest
``lsp`` — LSP diagnostics/status and Monaco editor routes
``checkpoint`` — LangGraph checkpoint history / state / fork
``build_plan`` — build-plan cancel
``conversation_title`` — suggest conversation title
"""
