"""App-theme authoring catalog (token names + element-group ids) for ``propose_theme``."""

from __future__ import annotations

from clara_coder_backend.context_packs.registry import ContextPack, register_pack
from clara_coder_backend.theme.propose_theme import PROPOSE_THEME_NAME, theme_registry_summary

register_pack(
    ContextPack(
        id='theme',
        summary='App theme catalog: valid `--t-*` token names, group ids and their class names for `propose_theme`',
        body=(
            'Theme authoring catalog (only these are kept by `propose_theme`; give every color token a value for a '
            'complete theme).\n'
            'Group `css` rules: write selectors relative to the group, never `[data-theme-group=…]`, `body` or app '
            'ancestors. `.cls` = element inside the group (use only the classes listed for that group; others match '
            'nothing), `& {…}` = the group root itself, `&.cls` / `&:hover` = root states, nesting and `@media` work. '
            'Siblings/parents of the group cannot be styled. Prefer `var(--t-…)` for colors so light/dark stay in sync. '
            'No `@import`, remote `url()` or CSS escapes (removed); `@keyframes` / `@font-face` are allowed.\n'
            + theme_registry_summary()
        ),
        tool_names=(PROPOSE_THEME_NAME,),
    )
)
