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
  /** Stable id from Python discovery (`app-backend`, `.venv`, …); drives Jedi/LSP analysis env. */
  pythonInterpreterId?: string;
}
