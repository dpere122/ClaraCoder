# Renderer

The Clara Coder UI: an Angular 21 app (standalone components, Vitest unit tests) that runs inside the Electron window. It talks to the Electron main process only through the `window.electronAPI` bridge exposed by [`src/preload/preload.ts`](../preload/preload.ts); main in turn talks to the Python sidecar.

There is no separate `node_modules` here. Dependencies live in the repo-root `package.json`, and the root scripts run the Angular CLI with this folder as its working directory (`scripts/run-ng.mjs`). Run everything from the **repository root**.

## Development

```bash
npm run dev
```

This serves the UI at `http://127.0.0.1:4200`, watches the main process, and opens Electron. Use the Electron window: opened in a plain browser tab, the UI has no `electronAPI` and most features do not work.

To drive the full app from a plain browser (for example in automated UI checks), use `npm run dev:bridge`. In that mode `core/dev-bridge/browser-bridge.ts` installs a `window.electronAPI` that forwards calls to the main process over a local, token-protected bridge.

## Tests and build

```bash
npm test                 # renderer unit tests (ng test → Vitest)
npm run build            # main process + production UI build into dist/renderer/
```

Other Angular CLI commands go through the root `ng` script, for example:

```bash
npm run ng -- generate component features/chat/my-widget
```

## Layout

| Path                   | Role |
| ---------------------- | ---- |
| `src/app/core/`        | App-wide services: the Electron bridge (`electron.service.ts`), theme engine (`theme/`), TTS playback, stream batching, dev browser bridge |
| `src/app/features/`    | Feature areas: `chat`, `workspace`, `workspace-terminal`, `shell`, `diff`, `settings`, `dependencies`, `speech`, `health`, `status`, `layout` |
| `src/app/shared/`      | Reusable UI pieces (themed dialogs, pill select) |
| `src/app/utils/`       | Pure helpers |
| `public/`              | Static assets copied into the build |

## Themes

Components that should be themeable carry a `data-theme-group="<category>.<name>"` attribute on their root element. After adding or renaming one, run `npm run gen:theme-registry` (it also runs before `dev`, `build`, and `test`). See [Themes](../../README.md#themes) in the root README for the full workflow.
