# Clara Coder Python backend

FastAPI service used by the Clara Coder Electron app. It runs a LangChain agent with read-only workspace tools, streams replies over Server-Sent Events, and handles speech transcription and text-to-speech.

For how this sidecar fits with Electron main (IPC, conversations SQLite, LangGraph, tools, persistence), see [docs/backend-architecture.md](../docs/backend-architecture.md).

## Features

- **Streaming chat (`POST /chat/stream`)** — LangGraph agent with bound tools; responses are SSE (`status`, `chunk`, then `[DONE]`). Supports **OpenAI** and **LM Studio** (OpenAI-compatible base URL).
- **Workspace tools** — Snapshot, list directory, read file (line range), read image (vision models), and regex search under the session's workspace root (path traversal blocked).
- **LSP tools** — Session-scoped language servers: **Python** (Jedi), **TypeScript/JavaScript** (`typescript-language-server` / `tsserver`), **GDScript**, and **Java** (Eclipse JDT Language Server) for diagnostics, hover, go-to-definition, references, document symbols, and LSP-aware CRUD mutators on `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.gd`, and `.java`. The TS server **auto-detects** the Node project root (walks up from the file you open, then searches under the workspace for the deepest `package.json` with TypeScript tooling). Override with `CLARA_TYPESCRIPT_LSP_PROJECT_ROOT` (relative to the session workspace or absolute). **GDScript:** by default Clara spawns a stdio bridge to Godot's TCP LSP (run the Godot editor with the project open; default `127.0.0.1:6005`, see Editor Settings → Network → Language Server). Tune with `CLARA_GODOT_LSP_HOST` / `CLARA_GODOT_LSP_PORT`, or replace the whole command with `CLARA_GDSCRIPT_LSP_COMMAND` (stdio argv). **Java:** requires a host **JDK 21+** (`JAVA_HOME` or `java` on `PATH`). On first use Clara downloads Eclipse JDT LS into `CLARA_JAVA_LSP_CACHE_DIR` (Electron sets this under app data `java-lsp/`). Project root is auto-detected from `pom.xml`, `build.gradle`, `build.gradle.kts`, or `settings.gradle` / `settings.gradle.kts` (walk up from the open file, then deepest match under the workspace). Overrides: `CLARA_JAVA_LSP_COMMAND` (full stdio argv; skips download), `CLARA_JAVA_LSP_PROJECT_ROOT`, `CLARA_JAVA_LSP_VERSION` (pin a milestone such as `1.60.0`), `CLARA_JAVA_LSP_CACHE_DIR`. Other overrides: `CLARA_PYTHON_LSP_COMMAND`, `CLARA_TYPESCRIPT_LSP_COMMAND`.
- **LSP roadmap (optional follow-ups)** — Angular Language Service for `.html` templates, vscode HTML/CSS language servers, and workspace commands such as `ng build` / `tsc --noEmit` (via a PTY or dedicated tool) are the next increment when you need template-aware or build-authoritative diagnostics beyond TS/JS files.
- **Editor mode (staging)** — When Editor is on, Clara uses `stage_*` tools, LSP Python staging mutators, code-review specialist tools, dependency installs, workspace pytest, and `run_command` background jobs. Drafts live in a session staging area until `transfer_staged_file_to_workspace` (with diff review unless auto-apply is on).
- **Workspace mirror** — Optional per-session snapshot under `.nemo/staging` (`staging_snapshot_session`) seeds an ignored-aware copy of the workspace for LSP overlays and read/search against staged peers; cleaned up after each outer agent turn.
- **Sessions** — `POST /clear`, `POST /load`, and `POST /workspace-context` sync chat history and workspace metadata from the renderer.
- **Runtime config (`POST /runtime-config`)** — LLM connections, active connection, transcription provider, and optional host OS hints for the system prompt.
- **Transcription (`POST /transcribe`)** — WAV upload; **OpenAI** speech API, **Google Web Speech** (no key, network required), or **disabled**.
- **TTS (`POST /tts`)** — Streams **WAV** audio from local **[Kokoro-82M](https://pypi.org/project/kokoro/)** (`kokoro` package). Requires PyTorch and related deps from `requirements.txt`. For English OOD fallback, install **espeak-ng** (see Kokoro README; Windows users can use the espeak-ng MSI).
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

From the repository root, run `npm run setup:python` (see root `package.json`). That installs `python/requirements.txt` plus Kokoro TTS: from PyPI on Python 3.10–3.12, or from GitHub on 3.13 until upstream publishes 3.13 wheels. The Electron app spawns the system `python` by default; point it at `.venv\Scripts\python` if you want the packaged backend to use this environment.

When the final project reviewer runs Python tests for a workspace, it now bootstraps a workspace-local `.venv` automatically if one does not exist yet. That bootstrap installs both `requirements.txt` and `requirements-dev.txt` before running pytest.

## Run

From the `python/` directory (so `clara_coder_backend` is importable), with the venv activated or using the venv's `python` directly:

```bash
python server.py
```

Or with uvicorn directly:

```bash
uvicorn clara_coder_backend.main:app --host 127.0.0.1 --port 5123
```

With the venv active, `python` and `uvicorn` refer to the tools inside `.venv`.

The desktop app expects **127.0.0.1:5123** by default.

## Tests

```bash
cd python
./.venv/bin/python -m pytest tests -v
```

On Windows PowerShell, use:

```powershell
cd python
.\.venv\Scripts\python -m pytest tests -v
```

Staged code review does not run pytest; use `run_workspace_pytest_tests` or `run_command` on the outer agent when you need verification. Those tools can stream subprocess output into the chat SSE timeline.

## Layout


| Path                                                   | Role                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `.venv/`                                               | Local virtual environment (create with `python -m venv .venv`; gitignored). |
| `server.py`                                            | Thin entrypoint for Electron (`python server.py`).                          |
| `clara_coder_backend/main.py`                                 | FastAPI `app` and router mounting.                                          |
| **Routes**                                             |                                                                             |
| `clara_coder_backend/routes/`                                  | FastAPI routers (package).                                                  |
| `clara_coder_backend/routes/runtime.py`                        | Health check and runtime config.                                            |
| `clara_coder_backend/routes/session.py`                        | Session lifecycle and workspace attachment.                                 |
| `clara_coder_backend/routes/chat.py`                           | Chat streaming and agent continuation (HITL).                               |
| `clara_coder_backend/routes/audio.py`                          | Transcription and TTS.                                                      |
| `clara_coder_backend/routes/log.py`                            | Log tail, stream, level control, ingest.                                    |
| `clara_coder_backend/routes/lsp.py`                            | LSP diagnostics/status and Monaco editor routes.                            |
| `clara_coder_backend/routes/checkpoint.py`                     | LangGraph checkpoint history / state / fork.                                |
| `clara_coder_backend/routes/build_plan.py`                     | Build-plan cancel.                                                          |
| `clara_coder_backend/routes/conversation_title.py`             | Suggest conversation title.                                                 |
| **Lang agent**                                         |                                                                             |
| `clara_coder_backend/lang_agent/`                      | LangChain / LangGraph agent core (package).                                 |
| `clara_coder_backend/lang_agent/agent.py`              | SSE streaming agent entry point.                                            |
| `clara_coder_backend/lang_agent/graph.py`              | LangGraph `create_agent` graph runner.                                      |
| `clara_coder_backend/lang_agent/langgraph_sse.py`      | LangGraph event → SSE line mapping and queue racing.                        |
| `clara_coder_backend/lang_agent/streaming.py`          | Shared SSE JSON helpers (status, chunks, read-tool mirroring).              |
| `clara_coder_backend/lang_agent/loop.py`               | Turn outcomes and history-commit policy.                                    |
| `clara_coder_backend/lang_agent/pause.py`              | `asyncio.Event` wait for `POST /chat/agent-continue`.                       |
| `clara_coder_backend/lang_agent/question.py`           | Plan-mode question HITL staging and resolution.                             |
| **Configuration & State**                              |                                                                             |
| `clara_coder_backend/config.py`                               | Env-backed constants and limits.                                            |
| `clara_coder_backend/domain.py`                               | Session/runtime dataclasses.                                                |
| `clara_coder_backend/schemas.py`                              | Pydantic request bodies.                                                    |
| `clara_coder_backend/state.py`                                | In-memory sessions and `runtime_config`.                                    |
| **LLM**                                                |                                                                             |
| `clara_coder_backend/llm.py`                                  | `ChatOpenAI` factory.                                                       |
| `clara_coder_backend/model_tuning.py`                         | Qwen-style presets, max tokens, parallel tool heuristics.                   |
| `clara_coder_backend/messages.py`                             | History → LangChain messages, system prompt, text helpers.                  |
| `clara_coder_backend/langchain_compat.py`                     | Patches for `reasoning_content` on some gateways.                           |
| **Agent tools**                                        |                                                                             |
| `clara_coder_backend/tool_registry.py`                        | Central tool registry and HITL policy.                                      |
| `clara_coder_backend/tools/`                                  | All LangChain `@tool` implementations (see package docstring).              |
| `clara_coder_backend/tools/workspace.py`                      | Read/search/list workspace files; assembles `TOOLS` / `TOOL_MAP`.           |
| `clara_coder_backend/tools/edit.py`                           | Full-file, line-range, snippet edit tools with diff payloads.               |
| `clara_coder_backend/tools/staging_edit.py`                   | Staged create/update tools for Editor mode.                                 |
| `clara_coder_backend/tools/delete.py`                         | `delete_workspace_entry` + pending delete / confirm flow.                   |
| `clara_coder_backend/tools/copy.py`                           | `copy_workspace_files` with HITL when auto-apply is off.                    |
| `clara_coder_backend/tools/lsp_tools.py`                      | LSP reads, diagnostics, and language-specific CRUD tools.                   |
| `clara_coder_backend/tools/review_tools.py`                   | Staging read/format/transfer/reject/overlay tools.                           |
| `clara_coder_backend/tools/project_review_tools.py`           | Workspace pytest verification tools.                                        |
| `clara_coder_backend/tools/python_deps.py`                    | Python pip/requirements install tools.                                      |
| `clara_coder_backend/tools/node_deps.py`                      | npm/pnpm/Yarn install and script tools.                                     |
| `clara_coder_backend/partial_workspace_edit.py`               | Merge strategies (line range, snippet, fuzzy match).                        |
| `clara_coder_backend/diff_payload.py`                         | Side-by-side diff rows via diff-match-patch.                                |
| `clara_coder_backend/edit_staging.py`                         | Temp staging dir, workspace mirror, code-review extensions.                 |
| `clara_coder_backend/staging_snapshot_session.py`             | Seed/cleanup workspace mirror + staging namespace per session.              |
| `clara_coder_backend/lsp/`                                    | LSP client, manager, diagnostics (runtime; tools in `tools/lsp_tools.py`).  |
| `clara_coder_backend/workspace_text_io.py`                    | Encoding/newline normalization and disk I/O for tools.                      |
| `clara_coder_backend/workspace_ignore.py`                     | `.gitignore` + built-in ignores for search/list.                            |
| **Middleware**                                         |                                                                             |
| `clara_coder_backend/diff_review_middleware.py`               | Pause after diff-emitting tools until user continues.                       |
| `clara_coder_backend/delete_review_middleware.py`             | Pause after delete HITL.                                                    |
| `clara_coder_backend/empty_response_middleware.py`            | Nudge on empty model turns.                                                 |
| `clara_coder_backend/parallel_tool_middleware.py`             | Inject `parallel_tool_calls` from runtime connection.                       |
| **Logging**                                            |                                                                             |
| `clara_coder_backend/app_logging.py`                          | Rotating file log, in-memory ring buffer, level control.                    |
| `clara_coder_backend/llm_interaction_logging.py`              | Chat turn / connection logging (no secrets).                                |
| `clara_coder_backend/tool_call_logging.py`                    | Structured logs for tool inputs/outputs.                                    |
| **Audio / TTS**                                        |                                                                             |
| `clara_coder_backend/audio.py`                         | Google Web + OpenAI STT helpers; OpenAI client for transcription.           |
| `clara_coder_backend/tts/`                             | Text-to-speech providers (package).                                        |
| `clara_coder_backend/tts/kokoro/`                      | Local Kokoro-82M synthesis (``POST /tts``).                                 |
| `clara_coder_backend/tts/openai_compatible/`           | OpenAI-compatible ``/v1/audio/speech`` client helpers.                      |


## Environment variables


| Variable                    | Purpose                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLARA_MAX_AGENT_STEPS`      | Max LLM turns per chat request (default `400`, capped at `5000`).                                                                                    |
| `CLARA_REASONING_EFFORT`     | Fallback for reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or UI aliases `on`/`off` (mapped to `medium`/`none` on the API). |
| `OPENAI_API_KEY`            | Default API key for OpenAI chat and OpenAI transcription when the UI leaves key empty.                                                               |
| `OPENAI_BASE_URL`           | Optional alternate OpenAI-compatible URL for the default OpenAI connection.                                                                          |
| `OPENAI_MODEL`              | Default chat model name (default `gpt-4o-mini`).                                                                                                     |
| `LM_STUDIO_BASE_URL`        | LM Studio OpenAI base URL (default `http://127.0.0.1:1234/v1`).                                                                                      |
| `LM_STUDIO_MODEL`           | Default LM Studio model id (default `local-model`).                                                                                                  |
| `LM_STUDIO_API_KEY`         | Optional key for local server (default placeholder `lm-studio` if unset).                                                                            |
| `CLARA_TRANSCRIBE_MODEL`     | OpenAI transcription model (default `gpt-4o-mini-transcribe`).                                                                                       |
| `PLAN_RETRY_ATTEMPTS_COUNT` | Reserved default for project-review retry budgeting (default `2`; outer agent uses review tools directly).                                      |


## Dependencies

See `requirements.txt` (runtime) and `requirements-dev.txt` (development/testing): FastAPI, uvicorn, OpenAI SDK, LangChain, LangGraph, langchain-openai, kokoro (+ torch), soundfile, SpeechRecognition, diff-match-patch, pypdf, pillow, Black, Jedi Language Server.