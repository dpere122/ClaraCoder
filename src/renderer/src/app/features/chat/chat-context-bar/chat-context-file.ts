/** Custom drag mime used by the file tree to mark drags that carry an absolute file path. */
export const WORKSPACE_TREE_DRAG_MIME = 'application/x-nemo-workspace-path';

/** A file the user attached to the next chat turn (from the file tree). */
export interface ChatContextFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Workspace-relative POSIX path (used for the model + image read IPC). */
  relativePath: string;
  /** Basename for display. */
  name: string;
  /** Images are embedded inline for vision; other files are referenced by path. */
  kind: 'image' | 'file';
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

/** True when the path has a vision-supported image extension. */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(lower.slice(dot));
}
