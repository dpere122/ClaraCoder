import type { FileEntry } from '@shared/index';
import {
  normalizePathSlashes,
  workspaceRelativePathIfUnderRoot,
} from '../../../utils/workspace-relative-path';
import { isViewableImagePath } from './image-viewer-formats';

/** Workspace-relative parent folder of an image path (`photos/a.png` → `photos`, root image → ``). */
export function parentFolderRelativePath(imageRelativePath: string): string {
  const norm = normalizePathSlashes(imageRelativePath).replace(/^\/+/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}

/** Absolute path of the parent folder for `read-directory` IPC. */
export function parentFolderAbsolutePath(workspaceRoot: string, imageRelativePath: string): string {
  const root = normalizePathSlashes(workspaceRoot).replace(/\/+$/, '');
  const parentRel = parentFolderRelativePath(imageRelativePath);
  if (!parentRel) {
    return root;
  }
  return `${root}/${parentRel}`;
}

/** Viewable image paths in a directory listing, sorted by filename. */
export function viewableImagesInDirectory(
  entries: readonly FileEntry[],
  workspaceRoot: string,
): string[] {
  const root = workspaceRoot.trim();
  if (!root) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !isViewableImagePath(entry.name)) {
      continue;
    }
    const rel = workspaceRelativePathIfUnderRoot(root, entry.path);
    if (rel !== null) {
      paths.push(normalizePathSlashes(rel));
    }
  }
  paths.sort((a, b) => {
    const nameA = a.slice(a.lastIndexOf('/') + 1);
    const nameB = b.slice(b.lastIndexOf('/') + 1);
    return nameA.localeCompare(nameB);
  });
  return paths;
}

/** Index of `relativePath` in a sorted gallery list, or -1 when missing. */
export function galleryIndexForPath(paths: readonly string[], relativePath: string): number {
  const norm = normalizePathSlashes(relativePath);
  return paths.findIndex((p) => normalizePathSlashes(p) === norm);
}

/** Wrap-aware previous index in a gallery list. */
export function galleryPreviousIndex(currentIndex: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  return currentIndex <= 0 ? length - 1 : currentIndex - 1;
}

/** Wrap-aware next index in a gallery list. */
export function galleryNextIndex(currentIndex: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  return currentIndex >= length - 1 ? 0 : currentIndex + 1;
}

/**
 * Whether a workspace-files-changed payload may alter the flat gallery listing for
 * `galleryFolderRel` (`''` = workspace root). Nested paths under other folders are ignored.
 */
export function workspaceChangeAffectsGalleryFolder(
  galleryFolderRel: string,
  paths: readonly string[],
  previousPaths?: readonly string[],
): boolean {
  const folder = normalizePathSlashes(galleryFolderRel).replace(/^\/+/, '');
  const candidates = previousPaths?.length ? [...paths, ...previousPaths] : paths;
  for (const raw of candidates) {
    const p = normalizePathSlashes(raw).replace(/^\/+/, '');
    if (!p || p === '.') {
      return true;
    }
    if (p === folder || parentFolderRelativePath(p) === folder) {
      return true;
    }
  }
  return false;
}

/**
 * After a gallery refresh, keep the current image when still present; otherwise pick a
 * nearby sibling using the pre-refresh index (clamped). Returns null when the gallery is empty.
 */
export function pickGalleryPathAfterRefresh(
  paths: readonly string[],
  currentRelativePath: string,
  previousIndex: number,
): string | null {
  if (paths.length === 0) {
    return null;
  }
  const currentIndex = galleryIndexForPath(paths, currentRelativePath);
  if (currentIndex >= 0) {
    return paths[currentIndex] ?? null;
  }
  const idx = Math.min(Math.max(previousIndex, 0), paths.length - 1);
  return paths[idx] ?? null;
}

export const AUTO_PLAY_INTERVAL_OPTIONS_MS: readonly number[] = [2000, 3000, 5000, 10000] as const;
