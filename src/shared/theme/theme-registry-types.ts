/**
 * Shape of one themeable element group. Entries are produced by
 * `scripts/gen-theme-registry.mjs` from `data-theme-group="…"` attributes in renderer
 * templates (see `theme-registry.generated.ts`); this file only holds the types and the
 * id grammar so hand-written code and the generator agree.
 */

export interface ThemeGroupDef {
  /** Dotted id: `<category>.<name>`, e.g. `chat.transcript`. */
  id: string;
  /** Human label (from manifest, else inferred from the id's last segment). */
  label: string;
  /** Category id (first id segment), used to group panels in Settings. */
  category: string;
  /** Human label for the category. */
  categoryLabel: string;
  /** Optional one-line description from the manifest. */
  description?: string;
  /** CSS selector that scopes this group's overrides. */
  selector: string;
  /** Renderer-relative component folder that owns the attribute. */
  component: string;
  /** `--t-*` tokens the component's stylesheet consumes (scan result + manifest extras). */
  tokens: string[];
  /** When true, the group can carry a background image overlay. */
  supportsBackground: boolean;
  /**
   * Selectors (relative to the group root) whose own backgrounds are made transparent while
   * an overlay is active, so the image is not hidden behind an opaque inner surface.
   */
  backgroundClear?: string[];
}

export interface ThemeGroupCategoryDef {
  id: string;
  label: string;
}

/** `<category>.<name>` — lowercase words separated by single hyphens, one dot. */
export const THEME_GROUP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidThemeGroupId(id: unknown): id is string {
  return typeof id === 'string' && THEME_GROUP_ID_PATTERN.test(id);
}

export function themeGroupSelector(id: string): string {
  return `[data-theme-group="${id}"]`;
}

/** `chat-transcript` → `Chat transcript`; used when no manifest label exists. */
export function humanizeThemeSegment(segment: string): string {
  const words = segment.split('-').filter((w) => w.length > 0);
  if (words.length === 0) {
    return segment;
  }
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
