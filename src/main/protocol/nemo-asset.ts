import { protocol } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { assertRegisteredWorkspaceDirectory } from '../utils/assert-registered-workspace-dir';
import { resolveSafeWorkspacePath } from '../utils/workspace-safe-path';

/** Image types servable in the markdown preview; anything else 404s. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Registers `nemo-asset://workspace/?root=<abs>&path=<rel>` to serve image files for the
 * markdown preview. The root must be a registered workspace and the relative path may not
 * escape it (see {@link resolveSafeWorkspacePath}).
 */
export function registerNemoAssetProtocol(): void {
  protocol.handle('nemo-asset', async (request) => {
    let root: string;
    let relPath: string;
    try {
      const url = new URL(request.url);
      root = url.searchParams.get('root') ?? '';
      relPath = url.searchParams.get('path') ?? '';
    } catch {
      return notFound();
    }
    if (!root.trim() || !relPath.trim()) {
      return notFound();
    }

    const ext = path.extname(relPath).replace(/^\./, '').toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) {
      return notFound();
    }

    try {
      const workspaceRoot = await assertRegisteredWorkspaceDirectory(root.trim());
      const abs = resolveSafeWorkspacePath(workspaceRoot, relPath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return notFound();
      }
      const data = await fs.readFile(abs);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return notFound();
    }
  });
}
