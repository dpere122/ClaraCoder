# Refactor backlog (post stability slice)

This file tracks the next structural refactors after the PTY cwd validation, unified Python HTTP client for chat, Qwen template constant, and root `npm test` wiring.

## High-impact splits (Phase 3)

| Area | File | Notes |
|------|------|--------|
| Renderer shell | `src/renderer/src/app/features/shell/app.ts` | Extract stream reducer / tab state into injectables; keep IPC surface stable. |
| Renderer bridge | `src/renderer/src/app/core/electron.service.ts` | Split by domain (PTY, LSP, chat, model manager) behind the same public API first. |
| Workspace terminal | `src/renderer/src/app/features/workspace-terminal/workspace-terminal-dock.ts` | Split PTY tabs vs llama log tabs vs xterm lifecycle; add characterization tests before moving code. |
| Main chat IPC | `src/main/ipc/handlers/chat.ts` | Move SSE line parsing + `sendParsedPayload` to a sibling module; keep `registerChatIpc` thin. |
| Model manager | `src/main/ipc/handlers/model-manager.ts` | Extract HF client, FS scan, and copy/migrate progress reporters. |
| Config | `src/main/config/load-save.ts` | Version `migrateConfig` steps with fixture JSON tests (large effort). |

## Broader Python HTTP (optional)

Other handlers still use global `fetch` (`workspace-sync`, `lsp-status`, `conversations`, etc.). Consider routing them through `src/main/python/http-client.ts` (`pythonControlFetch`) for one timeout/agent policy.

## Hygiene / policy

- Root `.gitignore` ignores `package-lock.json`; decide whether to commit lockfiles for reproducible CI.
- Main-process Vitest (or similar) for `src/main/utils/*.ts` without pulling Node types into the Angular spec build.

## Manual smoke (workspace terminal)

1. Open workspace, expand terminal dock, new shell tab.
2. Resize dock / panel height; switch tabs.
3. Change workspace root; confirm old PTYs are killed and new shell uses validated cwd.
4. Packaged app: confirm `LLM_Templates` extra resource and Qwen template path (see `electron-builder.yml` comment + `QWEN_INFERENCE_CHAT_TEMPLATE_FILENAME` in `src/shared/qwen-template.ts`).
