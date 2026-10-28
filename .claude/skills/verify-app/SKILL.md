---
name: verify-app
description: Verify a ClaraCoder change fast — type-check and targeted tests first, then drive the running dev app (main, Settings, Dependencies, Health windows) from the built-in browser through the dev browser bridge. Use when asked to verify, check, test or see a change working in the app, or before reporting a UI/IPC change as done.
---

# Verify ClaraCoder changes

Cheapest check first; stop as soon as the change is proven. Never use computer use for this: the
user is often away and can't approve it. Everything below goes through the bridge.

## 1. Static checks (seconds)

Run only what the change touches:

```bash
npx tsc -p ./ --noEmit                              # main, preload, shared
npx tsc -p src/renderer/tsconfig.app.json --noEmit  # renderer
npx vitest run --config vitest.node.config.mjs <path-or-dir>     # node specs (whole suite ~4 s)
npm run test:renderer -- --watch=false --include "src/app/<path>.spec.ts"   # one renderer spec (~20 s)
```

Known baseline node failures on this machine (not regressions): `llama-server-manager-allowlist`
symlink test (EPERM) and `runtime/user-path` PATH test. Python backend: see the
`python-backend-tests` memory.

## 2. Make sure the app is up

```bash
node .claude/skills/verify-app/bridge-status.mjs
```

Prints `{ up, pid, windows: { main, settings, dependencies, health } }`. If `up` is false, call
`preview_start` with name `clara-dev-bridge` (`.claude/launch.json`, runs `npm run dev:bridge`), then
`bridge-status.mjs --wait 120`. Don't start a second copy if it's up.

The token is stable across restarts (`%APPDATA%\clara-coder-dev\browser-bridge-token`), so open
tabs survive electronmon restarts: after a main-process edit they reconnect and reload themselves
within ~5 s. No need to re-read the URLs unless a tab shows the red "token changed" banner.

## 3. Drive the window you changed

One tab per window; reuse tabs across checks.

- Main: `navigate` the existing tab to `windows.main`.
- Settings / Dependencies / Health: `tabs_create`, then `navigate` it to `windows.<name>`. Settings
  opens on a category with `#/settings?tab=<id>` (ids in `src/shared/settings-tabs.ts`, e.g.
  `models`, `modelManager`, `themes`). Loading the tab opens the real Electron window, and the tab acts
  as it: own sender, own pushes, and Close / minimize hit only that window.
- Clicking Settings / Dependencies / Health inside the main tab opens the desktop window and logs
  `[BrowserBridge] Opening the <name> window; drive it from a new tab: <url>`. Read it with
  `read_console_messages` (pattern `Opening the`). Don't rely on `window.open`: the built-in pane
  loads popups in the current tab.

## 4. Check with text, not pixels

Prefer, in order:
1. `javascript_tool` assertions: DOM queries, `window.electronAPI.<method>()` results.
2. `get_page_text` / `find` / `read_page`.
3. `read_console_messages` with `onlyErrors: true`. The pane keeps console history across
   navigations, so check `performance.timeOrigin` or re-test live state before blaming an old error.
4. Screenshots at `scale: 0.5`, only for layout, theme or icon changes.

Backend / model / tool behaviour: read `%APPDATA%\clara-coder-dev\logs\clara-app.log` (`clara.llm`
shows each AIMessage's tool calls; `clara.tools.invoke` / `clara.tools.edit` show execution) rather
than watching the chat UI.

## Gotchas

- The folder picker is native. Register a throwaway workspace with
  `await window.electronAPI.addWorkspace(name, absPath)`, reload, then pick it under Recent.
- The Electron window and its bridge tab both run a renderer, so pushes reach both (double saves or
  auto-turns are a test artefact). Per-conversation events must use `event.reply` or
  `conversationRenderer(id)`.
- Renderer edits reload every tab back to its start route; re-open the workspace after them.
- Live-updating docks reflow between screenshot and click: click by `ref` from `find`, or by JS.
- The page CSP blocks inline handlers (`onclick="…"`); attach probes with `addEventListener`.
- Don't read the sidecar token from process memory or probe other local model ports; the auto-mode
  classifier blocks it, and the bridge makes it unnecessary.
