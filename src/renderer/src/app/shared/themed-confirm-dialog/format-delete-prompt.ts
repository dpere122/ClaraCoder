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

/** Copy for deleting a managed runtime dependency from the Dependencies window. */
export function dependencyDeletePrompt(args: {
  id: string;
  label: string;
  path: string | null;
}): ThemedConfirmOpenOptions {
  const impact: Record<string, string> = {
    'python-runtime':
      "Clara's backend runs from this environment. Chat, tools, and indexing stop working until you reinstall it.",
    'llama-server': 'Managed local models stop working until you download llama-server again.',
    'java-lsp': 'Java diagnostics and navigation stop working until you download it again.',
  };
  const where = args.path ? ` Files under ${args.path} are removed.` : '';
  return {
    title: `Delete ${args.label}?`,
    message: impact[args.id] ?? 'You can download it again later.',
    detail: `This can't be undone.${where}`,
    cancelText: 'Cancel',
    confirmText: 'Delete',
    variant: 'warning',
  };
}
