import type { ThemedConfirmOpenOptions } from './themed-confirm-dialog.service';

/** Copy for deleting a workspace tree file or folder. */
export function workspaceEntryDeletePrompt(args: {
  name: string;
  isDirectory: boolean;
}): ThemedConfirmOpenOptions {
  const kind = args.isDirectory ? 'folder' : 'file';
  const extra = args.isDirectory ? ' and everything inside it' : '';
  return {
    title: `Delete ${kind}?`,
    message: `Delete ${kind} "${args.name}"${extra}? This cannot be undone.`,
    cancelText: 'Cancel',
    confirmText: 'Delete',
    variant: 'warning',
  };
}

/** Copy for deleting a custom model file or Hugging Face hub folder from settings. */
export function customModelDeletePrompt(args: {
  fileName: string;
  isHubRepo: boolean;
}): ThemedConfirmOpenOptions {
  return args.isHubRepo
    ? {
        title: 'Delete hub folder?',
        message: `Delete hub folder "${args.fileName}" and everything inside it?`,
        cancelText: 'Cancel',
        confirmText: 'Delete',
        variant: 'warning',
      }
    : {
        title: 'Delete model file?',
        message: `Delete model file ${args.fileName}?`,
        cancelText: 'Cancel',
        confirmText: 'Delete',
        variant: 'warning',
      };
}

/** Copy for removing a workspace in settings (drops its chats and app data, not the folder). */
export function workspaceRemovePrompt(name: string): ThemedConfirmOpenOptions {
  return {
    title: 'Remove workspace?',
    message: `Remove "${name}" from Clara?`,
    detail: 'Its chats and Clara app data will be deleted. The folder and its files on disk are not touched.',
    cancelText: 'Cancel',
    confirmText: 'Remove',
    variant: 'warning',
  };
}
