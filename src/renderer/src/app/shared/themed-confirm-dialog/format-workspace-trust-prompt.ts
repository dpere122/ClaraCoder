import type { ThemedConfirmDialogService, ThemedConfirmOpenOptions } from './themed-confirm-dialog.service';

/** Copy for the question asked when a folder is added as a workspace. */
export function workspaceTrustPrompt(name: string, folder: string): ThemedConfirmOpenOptions {
  return {
    title: 'Trust this folder?',
    message:
      'Language servers can run code from a trusted workspace: Rust build scripts and macros through cargo, ' +
      `and Godot to read native add-on classes. Without trust, "${name}" still opens and those stay off.`,
    detail: `${folder}\n\nYou can change this later under Settings → Workspaces.`,
    confirmText: 'Trust',
    cancelText: "Don't trust",
  };
}

/** Ask whether a folder being added is trusted. Closing the dialog any other way means no. */
export async function askWorkspaceTrust(
  themedConfirm: Pick<ThemedConfirmDialogService, 'open'>,
  name: string,
  folder: string,
): Promise<boolean> {
  return (await themedConfirm.open(workspaceTrustPrompt(name, folder))) === 'confirm';
}
