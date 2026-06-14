/**
 * Image extensions the in-app image viewer can render. Broader than the chat
 * vision set (see chat-context-file.ts) because the viewer just displays the
 * file via the `nemo-asset://` protocol, which serves these types directly.
 */
const VIEWABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
]);

/** True when the path has an extension the image viewer can display. */
export function isViewableImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return VIEWABLE_IMAGE_EXTENSIONS.has(lower.slice(dot));
}
