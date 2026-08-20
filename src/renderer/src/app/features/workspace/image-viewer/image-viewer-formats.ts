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

/** File extension including the leading dot, or empty when the path has none. */
export function viewableImageExtension(path: string): string {
  const lower = path.toLowerCase().replace(/\\/g, '/');
  const slash = lower.lastIndexOf('/');
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const dot = base.lastIndexOf('.');
  // `dot <= 0` covers no-extension names and Unix hidden files like `.project`.
  if (dot <= 0) {
    return '';
  }
  return base.slice(dot);
}

/** True when the path has an extension the image viewer can display. */
export function isViewableImagePath(path: string): boolean {
  const ext = viewableImageExtension(path);
  return ext !== '' && VIEWABLE_IMAGE_EXTENSIONS.has(ext);
}
