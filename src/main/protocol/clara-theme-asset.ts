import { protocol } from 'electron';
import { promises as fs } from 'fs';
import { THEME_ASSET_MIME_BY_EXT, resolveThemeAssetPath, themeAssetExtension } from '../theme/theme-store';
import { sanitizeSvg } from './nemo-asset';

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Registers `clara-theme://asset/<themeId>/<fileName>` to serve background images stored in a
 * user theme's `assets/` folder. Both path segments are validated and the resolved file must
 * stay inside that folder; SVG is sanitized like `nemo-asset://`.
 */
export function registerClaraThemeAssetProtocol(): void {
  protocol.handle('clara-theme', async (request) => {
    let themeId: string;
    let fileName: string;
    try {
      const url = new URL(request.url);
      if (url.host !== 'asset') {
        return notFound();
      }
      const segments = url.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length !== 2) {
        return notFound();
      }
      themeId = decodeURIComponent(segments[0]!);
      fileName = decodeURIComponent(segments[1]!);
    } catch {
      return notFound();
    }
    const abs = resolveThemeAssetPath(themeId, fileName);
    if (!abs) {
      return notFound();
    }
    const mime = THEME_ASSET_MIME_BY_EXT[themeAssetExtension(fileName)];
    if (!mime) {
      return notFound();
    }
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return notFound();
      }
      const raw = await fs.readFile(abs);
      const data = mime === 'image/svg+xml' ? sanitizeSvg(raw) : raw;
      const headers: Record<string, string> = {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (mime === 'image/svg+xml') {
        headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
      }
      return new Response(new Uint8Array(data), { status: 200, headers });
    } catch {
      return notFound();
    }
  });
}
