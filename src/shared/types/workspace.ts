/**
 * Workspace record persisted in app config and used for filesystem roots and theming.
 * Shared between main process, preload bridge typings, and the Angular renderer.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  themeId: string;
  /** Stable id from Python discovery (`app-backend`, `.venv`, …); drives Jedi/LSP analysis env. */
  pythonInterpreterId?: string;
}
