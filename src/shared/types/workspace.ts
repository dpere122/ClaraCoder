/**
 * Workspace record persisted in app config and used for filesystem roots.
 * Shared between main process, preload bridge typings, and the Angular renderer.
 *
 * Theming is app-wide (`AppConfig.themeId`), not per-workspace.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /**
   * Stable id from Python discovery (`runtime-venv`, `app-backend`, `dot-venv`, …);
   * drives Jedi/LSP analysis env. Empty/unset → app default (`runtime-venv` when installed).
   */
  pythonInterpreterId?: string;
  /**
   * Basename of the file last copied into the managed app-data system prompt
   * (`workspaces/{id}/system-prompt.md`). Display only; content lives in app data.
   */
  systemPromptSourceName?: string;
}
