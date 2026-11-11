# Themes

The UI is painted by a theme engine (`src/renderer/src/app/core/theme`, shared schema in `src/shared/theme`).
A theme is a JSON document — global design tokens (`--t-*`), per-element-group overrides, optional
background images, and an optional Monaco palette. Read-only built-ins ship (`clara-dark` — Clara Dark Royal Ocean, the default, `clara-dark-cadmium-lantern` — Clara Dark Cadmium Lantern, `clara-dark-cadmium-orange` — Clara Dark Cadmium Orange, `clara-light` — Clara Light Mint, `clara-light-iris` — Clara Light Iris, `clara-light-ochre` — Clara Light Ochre);
user themes live under `{userData}/themes/<id>/theme.json` with images in `assets/`.

### Using themes

- **Settings → Themes → Theme library**: pick the active theme, create one from the selection, duplicate,
  import / export a `.clara-theme.json` bundle (images are embedded), or delete. Every change previews live in
  all windows and is written on **Apply / OK**; closing without saving reverts the preview.
- **Global colors** edits the tokens every element inherits; the per-category panes (Chat, Editor, Shell, …)
  edit one registered element group at a time: scoped token overrides, an **Advanced CSS** block, and — for
  groups that opt in (chat transcript, code editor) — a **background image** with an enable toggle, opacity
  slider, and fit.
- **Editor palette** derives Monaco colors from the tokens; **Customize** snapshots them so individual colors
  and syntax rules can be tuned. Settings → Editor → Color theme → *Follow app theme* (the default) uses it.
- In chat, ask Clara for a theme ("make me a cyberpunk theme"); the `propose_theme` tool posts a card with
  **Preview**, **Save & apply**, **Save only**, and **Dismiss**.

<details>
<summary><b>Theme document format</b></summary>

```jsonc
{
  "version": 1,
  "id": "neon-nights",            // lowercase letters, digits, hyphens
  "name": "Neon Nights",
  "mode": "dark",                 // dark | light — picks the built-in used for unset tokens
  "tokens": { "--t-bg": "#101014", "--t-primary": "#ff4fd8" },
  "groups": {
    "chat.transcript": {
      "tokens": { "--t-chat-bg": "#0c0c10" },
      "css": ".msg-bubble { border-radius: 0; } & { box-shadow: none; }",
      "background": { "enabled": true, "asset": "wall", "opacity": 0.35, "fit": "cover" }
    }
  },
  "monaco": { "base": "vs-dark", "colors": { "editor.background": "#101014" }, "rules": [] },
  "assets": { "wall": "wall.png" } // file name on disk, or data:image/… in an exported bundle
}
```

Token names come from `src/shared/theme/theme-tokens.ts`; group ids from the generated registry. Unknown
tokens / groups are dropped with a warning. Group CSS is sanitized (`@import`, remote `url()` / `src()` /
`image-set()`, `expression()`, and CSS escapes outside strings are removed) and contained to the group's root:
every style rule is emitted inside a native `@scope (<root>) { … }` block, so no selector — including
`:not(&)`, `:has(&)`, or sibling combinators — can style elements outside the group. Plain selectors match
descendants, a leading `&` (or `:host`, `:root`) targets the root itself; `@keyframes` / `@font-face` are kept
global. Embedded images must be strict `data:image/…;base64,` URLs.

</details>

<details>
<summary><b>Registering a new element group (for contributors)</b></summary>

1. Put `data-theme-group="<category>.<name>"` on the root element of the component template (or in the
   component's `host` metadata). Ids are lowercase with hyphens, one dot.
2. Run `npm run gen:theme-registry`. The script infers the label, category, scope selector, and the `--t-*`
   tokens the component's stylesheet uses, and rewrites `src/shared/theme/theme-registry.generated.ts` and
   `python/clara_coder_backend/theme/registry.json`. The new group appears in Settings → Themes under its
   category and becomes valid for agent proposals automatically.
3. Optional `*.theme.json` manifest next to the template to set `label`, `description`, `categories` labels,
   extra `tokens`, `styleSources` (other folders whose CSS the group covers), `supportsBackground: true`
   (root must be `position: relative`), and `backgroundClear` (inner selectors made transparent while an
   overlay is active).

</details>
