import path = require('path');

/**
 * True for Hugging Face Hub content-addressed blob names (SHA / etag),
 * e.g. ``a1b2…ff`` or ``sha256-a1b2…``. These are the GGUF bytes, not a
 * user-facing model file.
 */
export function isBlobLikeFileName(fileName: string): boolean {
  const base = path.basename(fileName);
  const ext = path.extname(base);
  if (ext) {
    return false;
  }
  return /^[a-f0-9]{32,}$/i.test(base) || /^sha256[-_][a-f0-9]{32,}$/i.test(base);
}

/**
 * Hub cache folder: ``models--org--repo``, or a tree with ``blobs/`` plus
 * ``snapshots/`` and/or ``refs/``.
 *
 * Clara downloads write ``blobs`` + ``snapshots`` and skip ``refs``. Detection
 * must not require ``refs``, or a rename that drops the ``models--`` prefix
 * will leak hash-named blob files into the model list.
 */
export function looksLikeHubRepoLayout(
  folderName: string,
  dirs: { blobs: boolean; refs: boolean; snapshots: boolean },
): boolean {
  if ((folderName || '').toLowerCase().startsWith('models--')) {
    return true;
  }
  return dirs.blobs && (dirs.snapshots || dirs.refs);
}
