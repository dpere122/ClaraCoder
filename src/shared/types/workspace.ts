/**
 * Reserved app-data id for the no-workspace (general) system prompt.
 * Not a real workspace — storage lives under `workspaces/{id}/system-prompt.md`.
 */
export const NO_WORKSPACE_SYSTEM_PROMPT_ID = '__no_workspace__';

export function isNoWorkspaceSystemPromptId(workspaceId: string | null | undefined): boolean {
  const wid = (workspaceId ?? '').trim();
  return !wid || wid === NO_WORKSPACE_SYSTEM_PROMPT_ID;
}

/** Map a real workspace id, or empty/null (no workspace), to the managed prompt storage id. */
export function resolveSystemPromptStorageId(workspaceId: string | null | undefined): string {
  const wid = (workspaceId ?? '').trim();
  return wid || NO_WORKSPACE_SYSTEM_PROMPT_ID;
}

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
   * drives Python LSP analysis env. Empty/unset → app default (`runtime-venv` when installed).
   */
  pythonInterpreterId?: string;
  /**
   * Basename of the file last copied into the managed app-data system prompt
   * (`workspaces/{id}/system-prompt.md`). Display only; content lives in app data.
   */
  systemPromptSourceName?: string;
}
