# Clara Coder Application Analysis

## Executive Summary

Clara Coder is a desktop coding assistant built from three cooperating layers:

- An Electron main process that owns native desktop integration, IPC, configuration, persistence, local model process management, workspace file access, and the Python sidecar lifecycle.
- An Angular renderer that provides the chat UI, workspace explorer, Monaco editor, diff review surfaces, terminal dock, settings, health/status panels, speech controls, and local model controls.
- A Python FastAPI backend that runs the LangChain/LangGraph agent, streams model output, exposes workspace and LSP tools, stages edits, gates destructive actions through human review, and handles speech and logging endpoints.

The application is structured as a local-first agentic coding environment: the UI sends conversation turns through Electron IPC, Electron forwards them to the Python backend, and the backend streams structured agent events back for chat text, tool status, diffs, approval prompts, token usage, planner progress, and nested coding workflows.

## Product Shape

The app presents itself as `Clara Coder` in Electron and renderer packaging metadata. The repository name remains `nemo-wrapper`, and much of the Python backend still uses the `nemo_backend` namespace. Functionally, Clara is a coding workspace wrapper around LLM agents with:

- Conversational coding assistance.
- Workspace read/search/list tools.
- Edit tools with diff preview and optional auto-apply.
- Nested planner/specialist coding workflows.
- Human-in-the-loop gates for edits, deletes, copies, staged transfers, and commands.
- Session-scoped LSP support for Python and TypeScript/JavaScript.
- Monaco-based file editing with LSP-backed editor features.
- Local terminal sessions through `node-pty`.
- Speech-to-text and text-to-speech.
- OpenAI, LM Studio, and managed `llama.cpp` style runtime configuration.
- Conversation persistence and workspace association.
- Health/logging observability for both Electron and Python paths.

## Technology Stack

### Desktop Shell

- Electron 41.
- TypeScript main/preload/shared code.
- Native dependencies: `node-pty` for terminals and `better-sqlite3` for local conversation storage.
- Electron Builder packaging through `electron-builder.yml`.
- Python sidecar launched from the Electron main process.

### Renderer

- Angular 21.
- Monaco Editor.
- Xterm.js.
- Bootstrap, Angular CDK, Lucide icons, Marked, Highlight.js.
- Vitest through Angular CLI for renderer tests.

### Backend

- FastAPI and Uvicorn.
- LangChain and LangGraph.
- OpenAI SDK and OpenAI-compatible local endpoints.
- Jedi Language Server and TypeScript Language Server integration.
- Edge TTS and speech recognition/transcription integrations.
- Diff generation, staging overlays, semantic workspace indexing, and pytest-oriented project review support.

## Runtime Architecture

### Startup Flow

`src/main/index.ts` is the desktop entrypoint. On app readiness, it:

1. Starts the Python backend with `startPythonServer()`.
2. Polls `GET /health` until the backend is ready.
3. Registers the custom TTS protocol.
4. Loads app configuration.
5. Syncs health/log settings and runtime LLM/audio/tool configuration to Python.
6. Refreshes the workspace watcher.
7. Creates the main window.

On quit, Electron stops managed llama servers, kills workspace PTY sessions, clears the workspace watcher, and terminates the Python process.

### Python Sidecar

`python/nemo_backend/main.py` constructs the FastAPI app and mounts routers for:

- Runtime configuration and health.
- Session lifecycle and workspace context.
- Chat streaming and agent continuation.
- Conversation title generation.
- Audio transcription and TTS.
- LSP status/editor routes.
- Logs.
- LangGraph checkpointing.

The backend is expected on `127.0.0.1:5123`. Electron starts it with `python server.py` from the `python/` directory and injects paths for logs, staging, checkpoint DB storage, and semantic indexes.

### Renderer Isolation Boundary

`src/preload/preload.ts` exposes a fixed `window.electronAPI` surface using `contextBridge`. The renderer does not receive raw `ipcRenderer`; it calls a whitelisted set of operations for chat, files, workspaces, settings, terminal sessions, LSP, local model management, speech, health, and conversations.

Angular wraps that preload API in `src/renderer/src/app/core/electron.service.ts`, keeping most UI code away from raw IPC details.

## Core Data Flow

### Chat Streaming

The chat path is:

1. Angular shell sends a message through `window.electronAPI.sendMessage(...)`.
2. Preload sends the `message` IPC event.
3. `src/main/ipc/handlers/chat.ts` posts to Python `POST /chat/stream`.
4. Python streams Server-Sent Events.
5. Electron parses each `data:` payload using shared stream parsing code.
6. Electron replies to the renderer with typed IPC events such as:
  - `message-chunk`
  - `message-status`
  - `message-diff`
  - `message-planner`
  - `message-accept-command`
  - `message-copy-confirm`
  - `message-delete-confirm`
  - `message-tool-read-chunk`
  - `message-tool-exec-chunk`
  - `message-token-usage`
  - `message-done`

This two-hop design centralizes backend access in Electron main and keeps the renderer sandboxed, but it makes streaming correctness dependent on the IPC/SSE adapter.

### Runtime Configuration

Electron owns persisted UI configuration and posts normalized runtime settings to Python via `POST /runtime-config`. The payload includes:

- Active LLM connection.
- Flattened OpenAI, LM Studio, and llama.cpp connection definitions.
- Reasoning/sampling/model tuning options.
- Audio transcription settings.
- Host OS metadata.
- Workspace tool limits and edit policy settings.
- Embeddings availability for semantic indexing.

This design lets the UI remain the source of truth for user settings while Python remains the execution engine.

### Workspace Context

The renderer/Electron workspace layer sends workspace path, tree context, workspace ID, changed files, and selected Python interpreter to Python through `POST /workspace-context`. Python stores this in `SessionState` and uses it for prompts, semantic index updates, LSP server roots, and tool scoping.

### Edit Review

The Python backend stages edits and emits structured diff payloads. The renderer can display those diffs in chat cards and in the Monaco editor. The user can accept, skip, reject, or request re-review depending on the operation.

The central policy is clear: workspace mutations are not just model text. They are represented as structured pending state, surfaced to the user, and continued through explicit actions.

## Frontend Structure

### Shell

`src/renderer/src/app/features/shell/app.ts` is the main Angular shell. It coordinates:

- Conversations and active conversation state.
- Streaming assistant output.
- Planner progress.
- Diff payloads and review state.
- Workspace selection and file tabs.
- Monaco editor mounting.
- Terminal dock.
- Settings visibility.
- Speech/TTS controls.
- Local model server UI.
- Status bar and health indicators.

This component is large and central. It is the renderer-side orchestration point for most product features.

### Chat

Chat UI components live under `src/renderer/src/app/features/chat`. They handle message display, markdown rendering, composer behavior, auxiliary reasoning/tool streams, delegated shell output, conversation management, and local model tiles.

The shared stream utilities in `src/shared/stream-parts.ts` and `src/shared/stream-payload.ts` are important because both Electron and Angular use the same concepts to classify assistant text, tool trails, nested streams, and planner output.

### Workspace And Monaco

Workspace UI lives under `src/renderer/src/app/features/workspace`. `workspace-monaco.ts` manages Monaco models, dirty file tracking, language inference, diff editor mounting, and LSP registration through `workspace-monaco-lsp.ts`.

Notable behavior:

- File buffers are tracked by normalized workspace-relative paths.
- Dirty buffers can block diff review until the buffer is saved or reverted.
- Pending diffs can be reviewed in the editor as well as in chat.
- LSP features are scoped by file type through shared policy.

### Diff Review

Diff review UI lives under `src/renderer/src/app/features/diff`. `diff-apply.ts` supports hunk-level review, virtualized diff rows, syntax highlighting, stacked/mobile layout, search, expand mode, and staged-transfer review feedback.

This is one of the product's highest-value surfaces because it turns model edits into inspectable, user-controlled changes.

## Backend Structure

### Session State

`python/nemo_backend/domain.py` defines `SessionState`, the central mutable in-memory object per chat session. It tracks:

- Chat history.
- Workspace identity and tree context.
- Python environment/interpreter details.
- Pending diff payloads.
- Staged edit entries.
- Pending copy/delete/command approvals.
- Human-in-the-loop pause events.
- Active LangGraph stream counts.
- Planner/nested graph queues.
- LSP scope, roots, overlays, and diagnostics.
- Project review re-entry data.
- Auto-apply and editor mode flags.

`SessionState` is powerful but dense. It is the coordination hub for agent execution, staging, review, LSP, and UI continuation.

### Agent And Planning

The LangGraph/LangChain stack is centered around:

- `python/nemo_backend/agent.py`
- `python/nemo_backend/agent_langgraph.py`
- `python/nemo_backend/langgraph_sse.py`
- `python/nemo_backend/agents/planning`
- `python/nemo_backend/agents/coding_planner`
- `python/nemo_backend/agents/orchestration`
- `python/nemo_backend/agents/specialists`

The backend supports both normal chat-agent operation and nested coding flows where a planner/router delegates work to specialist agents, stages changes, reviews output, and can re-enter planning when final review finds problems.

### Tools

Tooling is split by concern:

- `workspace_tools.py` for read/list/search.
- `edit_tool.py`, `partial_workspace_edit.py`, `delete_tool.py`, and `copy_tool.py` for workspace mutation operations.
- `edit_staging.py` and `staging_edit_tools.py` for staged changes.
- `lsp/tools.py` and related LSP managers for diagnostics and code intelligence.
- `python_dependency_agent.py`, `node_dependency_agent.py`, and `angular_cli_tool.py` for project-specific execution/dependency workflows.
- `tool_registry.py` for central tool registration and HITL policy.

### LSP

The LSP layer supports Python and TypeScript/JavaScript. Python uses Jedi. TypeScript uses `typescript-language-server` / `tsserver` and includes project-root detection logic. Recent files indicate active work on Monaco editor LSP integration and dashboard/status surfacing.

The LSP system is session-scoped, can operate against the real workspace or a staging overlay, and caches diagnostics by workspace-relative path.

### Semantic Index

The backend includes `workspace_index` modules for walking, fingerprinting, building, reading, and incrementally updating semantic indexes. Runtime config can disable embeddings for managed llama.cpp connections when no embedding endpoint is available.

## Electron Main Responsibilities

Electron main is not just a thin window host. It owns several important local capabilities:

- Python process lifecycle.
- Runtime config synchronization.
- Workspace watcher and context tree generation.
- Conversation persistence through SQLite.
- File read/write/create/delete/rename IPC handlers.
- PTY-backed terminal sessions.
- Local llama server lifecycle and LM Studio integration.
- Health/log windows and metrics.
- TTS protocol registration.
- Window chrome/settings windows.

This is a pragmatic split: native and local OS responsibilities live in Electron, agent intelligence lives in Python, and interaction/UI lives in Angular.

## Shared Contracts

`src/shared/index.ts` exports cross-layer types and utilities. This folder is important because it defines the contracts used by Electron main, preload, and Angular renderer without importing Node or Electron.

Key shared concepts include:

- App configuration and LLM provider models.
- Conversation and stream part shapes.
- Stream payload parsing.
- Diff payloads.
- Planner progress and LLM status.
- Workspace context and file change payloads.
- LSP dashboard types.
- Accept/copy/delete confirmation payloads.
- Health and TTS types.

This shared layer reduces drift between IPC producers and consumers.

## Testing And Quality Signals

The Python backend has a substantial pytest suite under `python/tests`, covering agent streaming, LangGraph behavior, edit tools, diff payloads, staging overlays, LSP tools, workspace indexing, runtime config, dependency agents, project review, planning, middleware, and logging.

The renderer has focused Vitest specs for shell behavior, chat box behavior, markdown normalization, virtual scrolling, context capacity, health log virtualization, local model display, and terminal theme conversion.

Build/test commands visible in the repository:

- Root build: `npm run build`.
- Renderer dev server: `npm start --prefix src/renderer`.
- Electron dev mode: `npm run dev`.
- Python setup: `npm run setup:python`.
- Python tests: `cd python && .\.venv\Scripts\python -m pytest tests -v` on Windows.
- Renderer tests: `npm test --prefix src/renderer`.

The root `npm test` script is currently a placeholder that exits with an error, so test automation should call the Python and renderer test commands explicitly.

## Strengths

- Clear separation between sandboxed renderer, privileged Electron main, and Python agent backend.
- Preload API is allowlisted rather than exposing raw IPC.
- Shared TypeScript contracts reduce renderer/main/preload schema drift.
- The backend has broad unit coverage around the risky agent, staging, diff, and LSP code.
- Human-in-the-loop review is treated as a first-class workflow, not an afterthought.
- Diff review exists both in chat and Monaco, which keeps code review close to the user's editing context.
- Local model support is designed into configuration rather than bolted onto a single provider path.
- The system has observability surfaces for logs, health, token usage, and tool status.

## Architectural Risks

### Large Coordination Objects

`SessionState` carries many responsibilities: history, workspace metadata, staging, HITL gates, nested graph state, LSP state, diagnostics, interpreter state, and review re-entry. This makes it easy to add features quickly but raises the risk of accidental cross-feature coupling.

Future hardening could split state into smaller per-concern structures while keeping the external session API stable.

### Streaming Adapter Complexity

Chat streaming crosses several boundaries: Python SSE, Electron parsing, IPC fanout, Angular rendering, and conversation persistence. This gives good isolation, but small parsing or event-order mistakes can appear as UI hangs, duplicated chunks, missing done events, or stale pending states.

The shared parser is a good mitigation. Tests around malformed/incomplete SSE payloads and abort/continue ordering are especially valuable.

### Electron Main Surface Area

Electron main owns many privileged operations: filesystem writes, terminal sessions, model process launches, Python process management, settings, and database writes. New handlers need consistent path validation, argument validation, and lifecycle cleanup.

The existing `workspace-safe-path` and allowlisted preload model should remain the pattern for new features.

### Native Dependency Fragility

`node-pty` and `better-sqlite3` require Electron-compatible native builds. The `postinstall` rebuild script helps, but packaging and cross-platform upgrades will remain sensitive areas.

### Python Runtime Discovery

Electron starts `python` on Windows and `python3` elsewhere. That is convenient but can pick the wrong interpreter if the user's environment is not set up as expected. The README already notes pointing Electron at the intended `.venv`; packaging and onboarding should make this path explicit.

### Renderer Shell Size

The Angular shell component is the main feature coordinator and is large. It would be worth watching for increasing coupling among chat streaming, workspace tabs, diff review, terminal state, and settings state.

## Current Working Tree Context

The repository currently contains active uncommitted work across LSP, Monaco integration, diff review, Python interpreter selection, workspace sync, and styling. Several new files appear related to editor LSP status and Monaco LSP support. This suggests the LSP/editor integration is an active development area and should be reviewed carefully before broad refactors.

## Recommended Next Steps

1. Add a top-level test script or documented aggregate command that runs Python tests and renderer tests intentionally, since root `npm test` is currently a placeholder.
2. Keep investing in tests for chat stream parsing, abort handling, HITL continuation, and staged diff transfer because those are the highest-risk user-visible workflows.
3. Gradually decompose `SessionState` into smaller nested dataclasses for workspace, LSP, staging, HITL, and planner state.
4. Keep all new renderer-to-native capabilities behind preload allowlists and shared contract types.
5. Add architecture docs for the event stream payload contract so backend, Electron, and renderer changes stay synchronized.
6. Treat LSP/editor integration as a product subsystem with its own focused tests, especially for dirty-buffer behavior, staged overlays, diagnostics scope, and cross-file navigation.

## Bottom Line

Clara Coder is already more than a chat wrapper. It is a full local coding environment that combines an agent backend, staged code mutation system, workspace-aware editor, terminal, LSP, local model management, and human review UI. The architecture is sensible for this product: Electron handles trusted desktop capabilities, Angular handles interaction, Python handles agent execution, and shared TypeScript contracts keep the UI boundary coherent.

The main engineering challenge is not missing functionality; it is managing coordination complexity as more agent, LSP, editor, and review features converge on the same session and streaming paths.