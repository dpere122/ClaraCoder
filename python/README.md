# Nemo Python backend

FastAPI service used by the Nemo / Clara Electron app. It runs a LangChain agent with read-only workspace tools, streams replies over Server-Sent Events, and handles speech transcription and text-to-speech.

## Features

- **Streaming chat (`POST /chat/stream`)** — LangChain `ChatOpenAI` with bound tools; responses are SSE (`status`, `chunk`, then `[DONE]`). Supports **OpenAI** and **LM Studio** (OpenAI-compatible base URL).
- **Workspace tools** — Snapshot, list directory, read file (line range), and regex search under the session’s workspace root (path traversal blocked).
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

To use the venv’s interpreter explicitly, run `.\.venv\Scripts\python` (Windows) or `./.venv/bin/python` (Unix) instead of `python`.

From the repository root you can still install into the active environment with `python -m pip install -r python/requirements.txt` (see root `package.json` `setup:python`). The Electron app spawns the system `python` by default; point it at `.venv\Scripts\python` if you want the packaged backend to use this environment.

## Run

From the `python/` directory (so `nemo_backend` is importable), with the venv activated or using the venv’s `python` directly:

```bash
python server.py
```

Or with uvicorn directly:

```bash
uvicorn nemo_backend.main:app --host 127.0.0.1 --port 5123
```

With the venv active, `python` and `uvicorn` refer to the tools inside `.venv`.

The desktop app expects **127.0.0.1:5123** by default.

## Layout

| Path | Role |
|------|------|
| `.venv/` | Local virtual environment (create with `python -m venv .venv`; gitignored). |
| `server.py` | Thin entrypoint for Electron (`python server.py`). |
| `nemo_backend/main.py` | FastAPI `app` and router include. |
| `nemo_backend/routes.py` | HTTP handlers. |
| `nemo_backend/config.py` | Env-backed constants and limits. |
| `nemo_backend/domain.py` | Session/runtime dataclasses. |
| `nemo_backend/schemas.py` | Pydantic request bodies. |
| `nemo_backend/state.py` | In-memory sessions and `runtime_config`. |
| `nemo_backend/messages.py` | History → LangChain messages, system prompt, text helpers. |
| `nemo_backend/workspace_tools.py` | LangChain `@tool` implementations. |
| `nemo_backend/llm.py` | `ChatOpenAI` factory. |
| `nemo_backend/agent.py` | Tool loop and SSE streaming. |
| `nemo_backend/audio.py` | Transcription helpers. |
| `nemo_backend/langchain_compat.py` | Patches for `reasoning_content` on some gateways. |

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

See `requirements.txt`: FastAPI, uvicorn, OpenAI SDK, LangChain, langchain-openai, edge-tts, SpeechRecognition.
