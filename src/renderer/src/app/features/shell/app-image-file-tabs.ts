import { normalizePathSlashes } from '../../utils/workspace-relative-path';
import { isViewableImagePath } from '../workspace/image-viewer/image-viewer-formats';
import { parentFolderRelativePath } from '../workspace/image-viewer/image-viewer-gallery';
import { chatFileTabId, type ChatFileTab } from './app-chat-file-tabs';

export type OpenWorkspaceImageTabPlan =
  | { action: 'focus'; tabId: string }
  | { action: 'retarget'; oldRelativePath: string; newRelativePath: string }
  | { action: 'open'; relativePath: string };

/**
 * Decide how to open a workspace image in the main tab strip.
 * Same-folder images reuse one gallery tab (retarget) instead of stacking tabs.
 */
export function planOpenWorkspaceImageTab(
  tabs: readonly ChatFileTab[],
  relativePath: string,
  preferActiveTabId?: string | null,
): OpenWorkspaceImageTabPlan | null {
  const norm = normalizePathSlashes(relativePath).replace(/^\/+/, '');
  if (!norm || !isViewableImagePath(norm)) {
    return null;
  }

  const exact = tabs.find(
    (t) =>
      !t.outsideWorkspace &&
      !!t.relativePath?.trim() &&
      normalizePathSlashes(t.relativePath) === norm,
  );
  if (exact) {
    return { action: 'focus', tabId: chatFileTabId(exact) };
  }

  const folder = parentFolderRelativePath(norm);
  const sameFolder = tabs.filter(
    (t) =>
      !t.outsideWorkspace &&
      !!t.relativePath?.trim() &&
      isViewableImagePath(t.relativePath) &&
      parentFolderRelativePath(t.relativePath) === folder,
  );
  if (sameFolder.length === 0) {
    return { action: 'open', relativePath: norm };
  }

  const preferred =
    (preferActiveTabId
      ? sameFolder.find((t) => chatFileTabId(t) === preferActiveTabId)
      : undefined) ?? sameFolder[0]!;
  const oldPath = normalizePathSlashes(preferred.relativePath!);
  return {
    action: 'retarget',
    oldRelativePath: oldPath,
    newRelativePath: norm,
  };
}
