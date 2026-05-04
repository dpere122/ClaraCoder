import type { ThemedConfirmOpenOptions } from './themed-confirm-dialog.service';

/** Human-readable list of unsaved workspace-relative paths for confirm dialogs. */
export function formatUnsavedWorkspaceDetail(paths: readonly string[]): string {
  if (paths.length === 0) {
    return '';
  }
  if (paths.length === 1) {
    return `Unsaved file:\n${paths[0]}`;
  }
  const head = paths.slice(0, 8);
  const tail = paths.length > 8 ? '\n…' : '';
  return `${paths.length} unsaved files, including:\n${head.join('\n')}${tail}`;
}

/** Copy for the “unsaved workspace files” confirmation (used in shell + settings). */
export function unsavedWorkspaceSwitchPrompt(paths: readonly string[]): ThemedConfirmOpenOptions {
  return {
    title: 'Unsaved changes',
    message: 'You have unsaved files in the workspace editor. Switch workspace anyway?',
    detail: formatUnsavedWorkspaceDetail(paths),
    cancelText: 'Stay',
    confirmText: 'Switch workspace',
    variant: 'warning',
  };
}

/** Copy for closing a single workspace file tab that still has editor buffer changes. */
export function unsavedCloseFileTabPrompt(relativePath: string): ThemedConfirmOpenOptions {
  return {
    title: 'Unsaved changes',
    message: 'This file has unsaved changes. Close the tab and discard them?',
    detail: `File:\n${relativePath}`,
    cancelText: 'Keep editing',
    confirmText: 'Close tab',
    variant: 'warning',
  };
}
