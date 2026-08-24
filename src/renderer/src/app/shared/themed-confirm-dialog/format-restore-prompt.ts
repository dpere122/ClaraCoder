import type { ThemedConfirmOpenOptions } from './themed-confirm-dialog.service';

/** Copy for restoring a conversation to a prior user message. */
export function conversationRestorePrompt(args: {
  fileCount: number;
  samplePaths: readonly string[];
}): ThemedConfirmOpenOptions {
  const files =
    args.fileCount === 0
      ? 'No Clara file changes are recorded after this point.'
      : args.fileCount === 1
        ? `1 file will revert: ${args.samplePaths[0] ?? 'unknown'}.`
        : `${args.fileCount} files will revert, including ${args.samplePaths.slice(0, 3).join(', ')}.`;
  return {
    title: 'Restore this message?',
    message: `This prompt returns to the chat input. Later chat and Clara’s file changes after this point will be removed. ${files} This cannot be undone.`,
    cancelText: 'Cancel',
    confirmText: 'Restore',
    variant: 'warning',
  };
}
