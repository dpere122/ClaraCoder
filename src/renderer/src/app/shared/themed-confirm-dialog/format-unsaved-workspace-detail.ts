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

/** Copy for leaving a workspace while an agent response is still streaming. */
export function activeStreamWorkspaceSwitchPrompt(count: number): ThemedConfirmOpenOptions {
  const detail =
    count === 1
      ? '1 in-progress stream will be cancelled.'
      : `${count} in-progress streams will be cancelled.`;
  return {
    title: 'Agent still running',
    message: 'An agent response is still in progress. Switch workspace anyway?',
    detail,
    cancelText: 'Stay',
    confirmText: 'Switch workspace',
    variant: 'warning',
  };
}

export function detachedFileClosePrompt(relativePath: string): ThemedConfirmOpenOptions {
  return {
    title: 'File removed from workspace',
    message: 'This file was deleted or moved on disk. Save it elsewhere, discard your edits, or keep editing.',
    detail: `File:\n${relativePath}`,
    cancelText: 'Keep editing',
    middleText: 'Save As…',
    confirmText: 'Discard',
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

/** Copy when closing an active build-plan preview tab (cancels agent + deletes plan file). */
export function activeBuildPlanClosePrompt(relativePath: string): ThemedConfirmOpenOptions {
  return {
    title: 'Cancel build plan?',
    message: 'Closing this plan will cancel the agent and delete the build plan file.',
    detail: `Plan:\n${relativePath}`,
    cancelText: 'Keep open',
    confirmText: 'Close and cancel',
    variant: 'warning',
  };
}

/** Copy when context usage is at or above the near-limit threshold before sending a message. */
export function contextCapacityNearLimitPrompt(args: {
  usedTokens: number;
  maxTokens: number;
  usedPercentage: number;
  measuredFromApi: boolean;
}): ThemedConfirmOpenOptions {
  const source = args.measuredFromApi ? 'measured prompt usage' : 'estimated context usage';
  return {
    title: 'Context nearly full',
    message: 'This conversation is at or above 95% of the model context window. Send anyway?',
    detail: `${args.usedPercentage}% used (${args.usedTokens.toLocaleString()} / ${args.maxTokens.toLocaleString()} tokens, ${source}). The model may truncate, fail, or compress older tool output.`,
    cancelText: 'Cancel',
    confirmText: 'Send anyway',
    variant: 'warning',
  };
}
