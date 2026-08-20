# Clara Coder Python backend

FastAPI service used by the Clara Coder Electron app. It runs a LangChain agent with read-only workspace tools, streams replies over Server-Sent Events, and handles speech transcription and text-to-speech.

For how this sidecar fits with Electron main (IPC, conversations SQLite, LangGraph, tools, persistence), see [docs/backend-architecture.md](../docs/backend-architecture.md).

## Features

- **Streaming chat (`POST /chat/stream`)** — LangGraph agent with bound tools; responses are SSE (`status`, `chunk`, then `[DONE]`). Supports **OpenAI** and **LM Studio** (OpenAI-compatible base URL).
- **Workspace tools** — Snapshot, list directory, read file (line range), read image (vision models), and regex search under the session's workspace root (path traversal blocked).
- **LSP tools** — Session-scoped language servers: **Python** ([basedpyright](https://docs.basedpyright.com/)), **TypeScript/JavaScript** ([vtsls](https://github.com/yioneko/vtsls) — wraps the VS Code TypeScript language features, bundled with `tsserver`), **GDScript**, and **Java** (Eclipse JDT Language Server) for diagnostics, hover, go-to-definition, references, document symbols, and LSP-aware CRUD mutators on `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.gd`, and `.java`. A single vtsls server serves **both** TypeScript and JavaScript, so find-references / go-to-definition / rename work on `.js` files the same as `.ts`. vtsls bundles its own TypeScript, so plain JS workspaces (empty `package.json`, no `node_modules/typescript`) work without extra setup. **No Node.js install is required:** like VS Code, Clara ships vtsls (`@vtsls/language-server`, which bundles `tsserver`) inside the app and runs it with the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`) using Clara's own bundled Node runtime. `npm run bundle:vtsls` assembles the bundle into `vtsls-bundle/` (gitignored); `npm run pack` / `pack:dir` do this automatically via `electron-builder` `extraResources`. In dev without the bundle, Clara falls back to `npx -y -p @vtsls/language-server -- vtsls --stdio` (which does need system Node). The server **auto-detects** the Node project root (walks up from the file you open, then searches under the workspace for the deepest `package.json` with TypeScript tooling), falling back to the session workspace. Override with `CLARA_TYPESCRIPT_LSP_PROJECT_ROOT` (relative to the session workspace or absolute). **GDScript:** by default Clara spawns a stdio bridge to Godot's TCP LSP (run the Godot editor with the project open; default `127.0.0.1:6005`, see Editor Settings → Network → Language Server). Tune with `CLARA_GODOT_LSP_HOST` / `CLARA_GODOT_LSP_PORT`, or replace the whole command with `CLARA_GDSCRIPT_LSP_COMMAND` (stdio argv). **Java:** requires a host **JDK 21+** (`JAVA_HOME` or `java` on `PATH`). On first use Clara downloads Eclipse JDT LS into `CLARA_JAVA_LSP_CACHE_DIR` (Electron sets this under app data `java-lsp/`). Project root is auto-detected from `pom.xml`, `build.gradle`, `build.gradle.kts`, or `settings.gradle` / `settings.gradle.kts` (walk up from the open file, then deepest match under the workspace). Overrides: `CLARA_JAVA_LSP_COMMAND` (full stdio argv; skips download), `CLARA_JAVA_LSP_PROJECT_ROOT`, `CLARA_JAVA_LSP_VERSION` (pin a milestone such as `1.60.0`), `CLARA_JAVA_LSP_CACHE_DIR`. Other overrides: `CLARA_PYTHON_LSP_COMMAND`, `CLARA_TYPESCRIPT_LSP_COMMAND` (replaces the whole vtsls argv; default resolution is `<workspace>/node_modules/.bin/vtsls --stdio`, then the bundled vtsls run via the Electron binary in Node mode, else `npx -y -p @vtsls/language-server -- vtsls --stdio`), `CLARA_VTSLS_VERSION` (npm version spec used by `npm run bundle:vtsls`, default `0.3.0`; set to `latest` to track upstream).
- **LSP roadmap (optional follow-ups)** — Angular Language Service for `.html` templates, vscode HTML/CSS language servers, and workspace commands such as `ng build` / `tsc --noEmit` (via a PTY or dedicated tool) are the next increment when you need template-aware or build-authoritative diagnostics beyond TS/JS files.
- **Editor mode (staging)** — When Editor is on, Clara uses `stage_*` tools, LSP Python staging mutators, code-review specialist tools, and `run_command` background jobs. Drafts live in a session staging area until `transfer_staged_file_to_workspace` (with diff review unless auto-apply is on).
- **Workspace mirror** — Optional per-session snapshot under `.nemo/staging` (`staging_snapshot_session`) seeds an ignored-aware copy of the workspace for LSP overlays and read/search against staged peers; cleaned up after each outer agent turn.
- **Sessions** — `POST /clear`, `POST /load`, and `POST /workspace-context` sync chat history and workspace metadata from the renderer.
- **Runtime config (`POST /runtime-config`)** — LLM connections, active connection, transcription provider, and optional host OS hints for the system prompt.
- **Transcription (`POST /transcribe`)** — WAV upload; local **faster-whisper**, **OpenAI**-compatible speech API, or **disabled**.
- **TTS (`POST /tts`)** — Streams **WAV** audio from local **[Kokoro-82M](https://pypi.org/project/kokoro/)** (`kokoro` package). Requires PyTorch and related deps from `requirements.txt`. For English OOD fallback, install **espeak-ng** (see Kokoro README; Windows users can use the espeak-ng MSI).
- **Health (`GET /health`)** — Process liveness and current model id.

## Setup

From the **repository root** (not `python/`):

```bash
npm run setup:python          # NVIDIA GPU / CUDA PyTorch
# or: npm run setup:python:cpu
```

That creates the repo-root `.venv/` if missing, then installs PyTorch, `requirements.txt`, and Kokoro (PyPI when possible; GitHub fallback otherwise). Do not use a separate `python/.venv` — the Electron app looks for `<repo>/.venv`.

For backend unit tests / deptry extras:

```bash
../.venv/bin/pip install -r requirements-dev.txt   # from python/
# Windows: ..\.venv\Scripts\pip install -r requirements-dev.txt
```

When the final project reviewer runs Python tests for a workspace, it bootstraps a **workspace-local** `.venv` automatically if needed (installs that workspace’s `requirements.txt` + `requirements-dev.txt` before pytest). That is separate from Clara’s own repo-root `.venv`.

## Run

From the `python/` directory (so `clara_coder_backend` is importable), using the repo-root venv:

```bash
../.venv/bin/python server.py
# or: ../.venv/bin/uvicorn clara_coder_backend.main:app --host 127.0.0.1 --port 5123
```

Windows PowerShell:

```powershell
..\.venv\Scripts\python server.py
```

The desktop app expects **127.0.0.1:5123** by default and prefers `<repo>/.venv` in development.

## Tests

```bash
cd python
../.venv/bin/python -m pytest tests -v
```

On Windows PowerShell:

```powershell
cd python
..\.venv\Scripts\python -m pytest tests -v
```

Staged code review does not run pytest; use `run_command` on the outer agent when you need verification. Background command output can stream into the chat SSE timeline.

## Layout


| Path                                              | Role                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `../.venv/` (repo root)                           | Project virtual environment (created by `npm run setup:python`; gitignored). |
| `server.py`                                       | Thin entrypoint for Electron (`python server.py`).                          |
| `clara_coder_backend/main.py`                     | FastAPI `app` and router mounting.                                          |
| **Routes**                                        |                                                                             |
| `clara_coder_backend/routes/`                     | FastAPI routers (package).                                                  |
| **Lang agent**                                    |                                                                             |
| `clara_coder_backend/lang_agent/`                 | LangChain / LangGraph agent core (package).                                 |
| **Session**                                       |                                                                             |
| `clara_coder_backend/session/`                    | Config, domain types, Pydantic schemas, in-memory state, checkpointing.     |
| **LLM**                                           |                                                                             |
| `clara_coder_backend/llm/`                        | `build_llm` factory, messages, model tuning, compression, prompt blocks.    |
| `clara_coder_backend/llm/factory.py`              | `ChatOpenAI` / connection factory.                                          |
| **HITL**                                          |                                                                             |
| `clara_coder_backend/hitl/`                       | Tool registry, deferred HITL, accept-command, risk assess, tool budget.     |
| **Chat**                                          |                                                                             |
| `clara_coder_backend/chat/`                       | Chat input, vision attachments, stream tags, user events, title cadence.    |
| **Middleware**                                    |                                                                             |
| `clara_coder_backend/middleware/`                 | Diff/delete/copy/accept review, empty-response, parallel tools, vision, …   |
| **Plan**                                          |                                                                             |
| `clara_coder_backend/plan/`                       | Build-plan discovery, confirm, execute, verify, store.                      |
| **Staging**                                       |                                                                             |
| `clara_coder_backend/staging/`                    | Editor staging, workspace mirror, partial edits, diff payloads.             |
| **Workspace**                                     |                                                                             |
| `clara_coder_backend/workspace/`                  | Text I/O, ignore rules, search backend.                                     |
| `clara_coder_backend/workspace_index/`            | Embedding index build/read/incremental.                                     |
| **Agent tools**                                   |                                                                             |
| `clara_coder_backend/tools/`                      | All LangChain `@tool` implementations (see package docstring).              |
| `clara_coder_backend/lsp/`                        | LSP client, manager, diagnostics (tools in `tools/lsp_tools.py`).           |
| **Logging**                                       |                                                                             |
| `clara_coder_backend/logging/`                    | App log, LLM interaction log, tool-call log (package, not stdlib).          |
| **Audio / TTS**                                   |                                                                             |
| `clara_coder_backend/audio/`                      | Speech transcription (`transcribe.py`).                                     |
| `clara_coder_backend/tts/`                        | Text-to-speech providers (Kokoro + OpenAI-compatible).                      |
| **Runtime**                                       |                                                                             |
| `clara_coder_backend/runtime/`                    | Python env/interpreter select, subprocess smoke, URL normalize.             |
| **Format helpers**                                |                                                                             |
| `clara_coder_backend/xml/`, `json/`, `wsdl/`      | Parse/format helpers used by tools.                                         |


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


## Dependencies

See `requirements.txt` (runtime) and `requirements-dev.txt` (development/testing): FastAPI, uvicorn, OpenAI SDK, LangChain, LangGraph, langchain-openai, kokoro (+ torch), soundfile, faster-whisper (optional, File → Dependencies), diff-match-patch, pypdf, pillow, Black, basedpyright.