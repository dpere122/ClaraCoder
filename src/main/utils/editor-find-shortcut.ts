import type { Input } from 'electron';

/**
 * True for the primary in-editor Find shortcut (Ctrl+F / Cmd+F).
 * Excludes Alt/Shift chords (e.g. Ctrl+Shift+F "find in files") and mixed modifiers.
 */
export function isPrimaryEditorFindShortcut(input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt' | 'shift'>): boolean {
  if (input.type !== 'keyDown') {
    return false;
  }
  if (input.key.toLowerCase() !== 'f') {
    return false;
  }
  if (input.alt || input.shift) {
    return false;
  }
  if (process.platform === 'darwin') {
    return Boolean(input.meta) && !input.control;
  }
  return Boolean(input.control) && !input.meta;
}
