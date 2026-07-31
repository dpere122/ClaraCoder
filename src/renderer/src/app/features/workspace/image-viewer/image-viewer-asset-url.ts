import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

export type WorkspaceImageAssetUrlOptions = {
  /** Request a downscaled static PNG from the main-process protocol handler. */
  thumb?: boolean;
  /** Optional max edge in CSS pixels (protocol clamps). Ignored unless `thumb` is true. */
  maxEdge?: number;
};

/**
 * Build a `nemo-asset://` URL for a workspace-relative image path.
 * Pass `{ thumb: true }` for gallery strip thumbnails (resized / non-animated).
 */
export function buildWorkspaceImageAssetUrl(
  workspaceRoot: string,
  relativePath: string | null | undefined,
  options?: WorkspaceImageAssetUrlOptions,
): string {
  const root = workspaceRoot.trim();
  const rel = relativePath?.trim();
  if (!root || !rel) {
    return '';
  }
  const norm = normalizePathSlashes(rel).replace(/^\/+/, '');
  if (!norm) {
    return '';
  }
  let url =
    `nemo-asset://workspace/?root=${encodeURIComponent(root)}` +
    `&path=${encodeURIComponent(norm)}`;
  if (options?.thumb) {
    url += '&thumb=1';
    const edge = options.maxEdge;
    if (typeof edge === 'number' && Number.isFinite(edge) && edge > 0) {
      url += `&w=${Math.round(edge)}`;
    }
  }
  return url;
}
