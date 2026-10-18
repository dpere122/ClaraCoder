"""App-theme authoring catalog (token names + element-group ids) for ``propose_theme``."""

from __future__ import annotations

from clara_coder_backend.context_packs.registry import ContextPack, register_pack
from clara_coder_backend.theme.propose_theme import PROPOSE_THEME_NAME, theme_registry_summary

register_pack(
    ContextPack(
        id='theme',
        summary='App theme catalog: valid `--t-*` token names and group ids for `propose_theme`',
        body=(
            'Theme authoring catalog (only these are kept by `propose_theme`; give every color token a value for a '
            'complete theme; group css is scoped to the group root, `&` = root):\n' + theme_registry_summary()
        ),
        tool_names=(PROPOSE_THEME_NAME,),
    )
)
