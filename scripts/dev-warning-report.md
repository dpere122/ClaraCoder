# Dev warning report (`npm run dev`)

After the cleanup below, a fresh `npm run dev` no longer prints Electron `console-message` deprecation, CSP `frame-ancestors` meta noise, Angular NG8107/NG8102, or Monaco Vite dynamic-import warnings.

## Fixed

| Warning | Cause | Fix |
| --- | --- | --- |
| Electron `'console-message' arguments are deprecated` | Listener used positional `(event, level, message, line, sourceId)` | Use Event params only (`event.level`, `event.message`, …) in `src/main/windows/main-window.ts` |
| CSP `frame-ancestors` ignored via `<meta>` | Browsers ignore `frame-ancestors` in meta CSP | Removed from `src/renderer/src/index.html` (not meaningful for meta delivery) |
| NG8107 / NG8102 in staged batch review | Unnecessary `?.` / `??` in template | Use `currentFile().relativePath` + `isFileResolved()` helper |
| Vite “dynamic import cannot be analyzed” (Monaco) | Monaco `import(\`${url}\`)` in workers/chunks | Patch `@vite-ignore` via `scripts/patch-monaco-vite-ignore.mjs` (postinstall + before serve); `run-ng.mjs` also filters any leftover Vite import-analysis blocks |

## Suppressed / left (harmless)

| Warning | Cause | Why left |
| --- | --- | --- |
| `ScriptProcessorNode is deprecated` | Talk-mode mic capture still uses `AudioContext.createScriptProcessor` | Harmless today; migrating to `AudioWorklet` is a real feature change. Suppressed only in the main-process renderer console relay so `npm run dev` stays readable. Still may appear in DevTools until AudioWorklet migration. |
| `Frame latency is negative` | Chromium viz timing quirk | Harmless compositor noise; filtered from the renderer console relay. |
| Monaco Vite dynamic-import (if any slip past the patch) | Third-party Monaco AMD/ESM loader uses runtime URLs | Not our code; intentional dynamic load. Suppressed via patch + `run-ng.mjs` filter rather than forking Monaco. |

## Not Electron/Vite (left alone this pass)

| Noise | Cause | Why left |
| --- | --- | --- |
| `ECONNREFUSED 127.0.0.1:5123` at startup | Electron UI syncs before Python/Uvicorn finishes booting | Race, not a Vite/Electron warning. Clears once the sidecar is up. Separate follow-up if we want queued sync. |
| `llama_index` embedding `APIConnectionError` retries | Embeddings provider unreachable / misconfigured | Runtime config/network; unrelated to Electron/Vite tooling warnings. |
