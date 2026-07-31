import { nativeImage, protocol } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { computeThumbDimensions, parseThumbMaxEdge } from '../../shared/nemo-asset-thumb';
import { assertRegisteredWorkspaceDirectory } from '../utils/assert-registered-workspace-dir';
import { resolveSafeWorkspacePath } from '../utils/workspace-safe-path';

/** Image types servable in the markdown preview / image viewer; anything else 404s. */
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

const THUMB_CACHE_MAX = 80;

type ThumbCacheEntry = {
  mtimeMs: number;
  size: number;
  maxEdge: number;
  bytes: Buffer;
};

/** In-memory LRU of resized gallery thumbs (path → entry). */
const thumbCache = new Map<string, ThumbCacheEntry>();

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function rememberThumb(cacheKey: string, entry: ThumbCacheEntry): void {
  if (thumbCache.has(cacheKey)) {
    thumbCache.delete(cacheKey);
  }
  thumbCache.set(cacheKey, entry);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    thumbCache.delete(oldest);
  }
}

/**
 * Downscale / freeze (GIF→PNG) for gallery thumbs. Returns null when nativeImage
 * cannot decode the buffer (e.g. SVG) so the caller can fall back to the original.
 */
export function encodeWorkspaceImageThumb(
  data: Buffer,
  maxEdge: number,
): Buffer | null {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) {
    return null;
  }
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) {
    return null;
  }
  const target = computeThumbDimensions(width, height, maxEdge);
  const resized =
    target.width === width && target.height === height
      ? image
      : image.resize({
          width: target.width,
          height: target.height,
          quality: 'better',
        });
  const png = resized.toPNG();
  return Buffer.isBuffer(png) ? png : Buffer.from(png);
}

/**
 * Registers `nemo-asset://workspace/?root=<abs>&path=<rel>[&thumb=1|&w=128]` to serve
 * workspace image files. Thumbnail params return a small static PNG when decodable.
 * The root must be a registered workspace and the relative path may not escape it.
 */
export function registerNemoAssetProtocol(): void {
  protocol.handle('nemo-asset', async (request) => {
    let root: string;
    let relPath: string;
    let maxEdge: number | null;
    try {
      const url = new URL(request.url);
      root = url.searchParams.get('root') ?? '';
      relPath = url.searchParams.get('path') ?? '';
      maxEdge = parseThumbMaxEdge(url.searchParams.get('thumb'), url.searchParams.get('w'));
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

      if (maxEdge != null) {
        const cacheKey = `${abs}|${maxEdge}`;
        const cached = thumbCache.get(cacheKey);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size &&
          cached.maxEdge === maxEdge
        ) {
          thumbCache.delete(cacheKey);
          thumbCache.set(cacheKey, cached);
          return new Response(new Uint8Array(cached.bytes), {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-cache',
            },
          });
        }

        const data = await fs.readFile(abs);
        const thumb = encodeWorkspaceImageThumb(data, maxEdge);
        if (thumb) {
          rememberThumb(cacheKey, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            maxEdge,
            bytes: thumb,
          });
          return new Response(new Uint8Array(thumb), {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-cache',
            },
          });
        }
        // Undecodable as raster (often SVG) — serve original bytes.
        return new Response(new Uint8Array(data), {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Cache-Control': 'no-cache',
          },
        });
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
