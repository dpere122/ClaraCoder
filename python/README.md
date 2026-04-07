# Nemo Python backend

FastAPI service used by the Nemo / Clara Electron app. It runs a LangChain agent with read-only workspace tools, streams replies over Server-Sent Events, and handles speech transcription and text-to-speech.

## Features

- **Streaming chat (`POST /chat/stream`)** — LangGraph agent with bound tools; responses are SSE (`status`, `chunk`, then `[DONE]`). Supports **OpenAI** and **LM Studio** (OpenAI-compatible base URL).
- **Workspace tools** — Snapshot, list directory, read file (line range), and regex search under the session's workspace root (path traversal blocked).
- **Edit tools** — Full-file, line-range, and snippet-based workspace edits with diff preview and auto-apply mode.
- **Nested mutations** — `modify_workspace` delegates to a router + specialist subgraph pipeline for multi-step workspace mutations (create/update/delete).
- **Sessions** — `POST /clear`, `POST /load`, and `POST /workspace-context` sync chat history and workspace metadata from the renderer.
- **Runtime config (`POST /runtime-config`)** — LLM connections, active connection, transcription provider, and optional host OS hints for the system prompt.
- **Transcription (`POST /transcribe`)** — WAV upload; **OpenAI** speech API, **Google Web Speech** (no key, network required), or **disabled**.
- **TTS (`POST /tts`)** — Streams MPEG audio via **edge-tts**.
- **Health (`GET /health`)** — Process liveness and current model id.

## Setup

Create a dedicated virtual environment under `python/.venv` (ignored by git), then install dependencies:

**Windows (PowerShell), from the `python/` directory:**

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

**macOS / Linux, from the `python/` directory:**

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

For development (adds pytest, httpx, pytest-cov):

```bash
pip install -r requirements-dev.txt
```

To use the venv's interpreter explicitly, run `.\.venv\Scripts\python` (Windows) or `./.venv/bin/python` (Unix) instead of `python`.

From the repository root you can still install into the active environment with `python -m pip install -r python/requirements.txt` (see root `package.json` `setup:python`). The Electron app spawns the system `python` by default; point it at `.venv\Scripts\python` if you want the packaged backend to use this environment.

## Run

From the `python/` directory (so `nemo_backend` is importable), with the venv activated or using the venv's `python` directly:

```bash
python server.py
```

Or with uvicorn directly:

```bash
uvicorn nemo_backend.main:app --host 127.0.0.1 --port 5123
```

With the venv active, `python` and `uvicorn` refer to the tools inside `.venv`.

The desktop app expects **127.0.0.1:5123** by default.

## Tests

```bash
cd python
python -m pytest tests -v
```

## Layout

| Path | Role |
|------|------|
| `.venv/` | Local virtual environment (create with `python -m venv .venv`; gitignored). |
| `server.py` | Thin entrypoint for Electron (`python server.py`). |
| `nemo_backend/main.py` | FastAPI `app` and router mounting. |
| **Routes** | |
| `nemo_backend/routes.py` | Health check and runtime config. |
| `nemo_backend/routes_session.py` | Session lifecycle and workspace attachment. |
| `nemo_backend/routes_chat.py` | Chat streaming and agent continuation (HITL). |
| `nemo_backend/routes_audio.py` | Transcription and TTS. |
| `nemo_backend/log_routes.py` | Log tail, stream, level control, ingest. |
| **Agent** | |
| `nemo_backend/agent.py` | SSE streaming agent entry point. |
| `nemo_backend/agent_langgraph.py` | LangGraph `create_agent` graph runner. |
| `nemo_backend/langgraph_sse.py` | LangGraph event → SSE line mapping and queue racing. |
| `nemo_backend/agent_streaming.py` | Shared SSE JSON helpers (status, chunks, read-tool mirroring). |
| `nemo_backend/agent_pause.py` | `asyncio.Event` wait for `POST /chat/agent-continue`. |
| **Configuration & State** | |
| `nemo_backend/config.py` | Env-backed constants and limits. |
| `nemo_backend/domain.py` | Session/runtime dataclasses. |
| `nemo_backend/schemas.py` | Pydantic request bodies. |
| `nemo_backend/state.py` | In-memory sessions and `runtime_config`. |
| **LLM** | |
| `nemo_backend/llm.py` | `ChatOpenAI` factory. |
| `nemo_backend/model_tuning.py` | Qwen-style presets, max tokens, parallel tool heuristics. |
| `nemo_backend/messages.py` | History → LangChain messages, system prompt, text helpers. |
| `nemo_backend/langchain_compat.py` | Patches for `reasoning_content` on some gateways. |
| **Workspace Tools** | |
| `nemo_backend/workspace_tools.py` | LangChain `@tool` read/search/list implementations. |
| `nemo_backend/edit_tool.py` | Full-file, line-range, snippet edit tools with diff payloads. |
| `nemo_backend/delete_tool.py` | `delete_workspace_entry` + pending delete / confirm flow. |
| `nemo_backend/partial_workspace_edit.py` | Merge strategies (line range, snippet, fuzzy match). |
| `nemo_backend/diff_payload.py` | Side-by-side diff rows via diff-match-patch. |
| `nemo_backend/edit_staging.py` | Temp staging dir, code-review extensions, staging lifecycle. |
| `nemo_backend/workspace_text_io.py` | Encoding/newline normalization and disk I/O for tools. |
| `nemo_backend/workspace_ignore.py` | `.gitignore` + built-in ignores for search/list. |
| `nemo_backend/tool_registry.py` | Central tool registry and HITL policy. |
| **Nested Mutations** | |
| `nemo_backend/agents/planning/tool.py` | `modify_workspace` stub tool. |
| `nemo_backend/agents/planning/nested_middleware.py` | LangGraph middleware: intercept mutation tool, run nested stream. |
| `nemo_backend/agents/orchestration/nested_pipeline.py` | Nested router graph + specialist subgraphs. |
| `nemo_backend/agents/specialists/tools.py` | Per-specialist tool lists. |
| `nemo_backend/agents/specialists/prompts.py` | Router + specialist system prompts. |
| `nemo_backend/agents/specialists/review_tools.py` | Staging read/approve/reject/format-with-Black tools. |
| **Middleware** | |
| `nemo_backend/diff_review_middleware.py` | Pause after diff-emitting tools until user continues. |
| `nemo_backend/delete_review_middleware.py` | Pause after delete HITL. |
| `nemo_backend/empty_response_middleware.py` | Nudge on empty model turns. |
| `nemo_backend/parallel_tool_middleware.py` | Inject `parallel_tool_calls` from runtime connection. |
| **Logging** | |
| `nemo_backend/app_logging.py` | Rotating file log, in-memory ring buffer, level control. |
| `nemo_backend/llm_interaction_logging.py` | Chat turn / connection logging (no secrets). |
| `nemo_backend/tool_call_logging.py` | Structured logs for tool inputs/outputs. |
| **Audio** | |
| `nemo_backend/audio.py` | Google Web + OpenAI STT helpers; OpenAI client for transcription. |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `NEMO_MAX_AGENT_STEPS` | Max LLM turns per chat request (default `400`, capped at `5000`). |
| `NEMO_REASONING_EFFORT` | Fallback for OpenAI-style reasoning effort: `minimal`, `low`, `medium`, `high` (if not set per connection). |
| `OPENAI_API_KEY` | Default API key for OpenAI chat and OpenAI transcription when the UI leaves key empty. |
| `OPENAI_BASE_URL` | Optional alternate OpenAI-compatible URL for the default OpenAI connection. |
| `OPENAI_MODEL` | Default chat model name (default `gpt-4o-mini`). |
| `LM_STUDIO_BASE_URL` | LM Studio OpenAI base URL (default `http://127.0.0.1:1234/v1`). |
| `LM_STUDIO_MODEL` | Default LM Studio model id (default `local-model`). |
| `LM_STUDIO_API_KEY` | Optional key for local server (default placeholder `lm-studio` if unset). |
| `NEMO_TRANSCRIBE_MODEL` | OpenAI transcription model (default `gpt-4o-mini-transcribe`). |

## Dependencies

See `requirements.txt` (runtime) and `requirements-dev.txt` (development/testing): FastAPI, uvicorn, OpenAI SDK, LangChain, LangGraph, langchain-openai, edge-tts, SpeechRecognition, diff-match-patch, pypdf, Black.
