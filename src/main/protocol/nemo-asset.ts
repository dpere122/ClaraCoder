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

/** Match optional namespace prefix + script|foreignObject (e.g. `s:script`, `svg:foreignObject`). */
const DANGEROUS_SVG_TAG = '(?:[\\w-]+:)?(?:script|foreignObject)';

/**
 * Strip active content from SVG bytes before serving over `nemo-asset://`.
 * Removes namespaced/plain `<script>` / `<foreignObject>`, `on*` handlers (any case),
 * entity-encoded `javascript:` / `data:` URIs, and SMIL attrs that can set scripted hrefs.
 */
export function sanitizeSvg(bytes: Buffer): Buffer {
  let svg = bytes.toString('utf8');

  svg = stripDangerousSvgTags(svg);

  // Event-handler attributes: onclick, ONCLICK, OnLoad, onerror, …
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi, '');

  // Decode entities so javascript&#58; / &#106;avascript: are visible to URI scrubbers.
  // Re-strip tags/handlers in case decoding reconstituted markup.
  svg = decodeHtmlEntities(svg);
  svg = stripDangerousSvgTags(svg);
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi, '');

  // javascript: / data: in common URL-bearing attributes (quoted)
  svg = svg.replace(
    /(\s(?:href|xlink:href|src|poster)\s*=\s*)(["'])\s*(?:javascript|data)\s*:[\s\S]*?\2/gi,
    '$1$2$2',
  );
  // Unquoted javascript: / data: attribute values
  svg = svg.replace(
    /(\s(?:href|xlink:href|src|poster)\s*=\s*)(?:javascript|data)\s*:[^\s>]*/gi,
    '$1""',
  );

  // SMIL: attributeName targeting href can animate a scripted URI into place
  svg = svg.replace(/\s+attributeName\s*=\s*(["'])\s*(?:xlink:)?href\s*\1/gi, '');
  svg = svg.replace(/\s+attributeName\s*=\s*(?:xlink:)?href\b/gi, '');
  // Neutralize to/values/from/by carrying javascript: / data:
  svg = svg.replace(
    /(\s(?:to|values|from|by)\s*=\s*)(["'])[\s\S]*?(?:javascript|data)\s*:[\s\S]*?\2/gi,
    '$1$2$2',
  );
  svg = svg.replace(
    /(\s(?:to|values|from|by)\s*=\s*)(?:javascript|data)\s*:[^\s>]*/gi,
    '$1""',
  );

  // CSS url(javascript:…) / url(data:…) — balanced-paren aware
  svg = stripDangerousCssUrls(svg);

  return Buffer.from(svg, 'utf8');
}

/** Self-closing first so open-tag match does not swallow until a later close tag. */
function stripDangerousSvgTags(svg: string): string {
  svg = svg.replace(new RegExp(`<${DANGEROUS_SVG_TAG}\\b[^>]*\\/>`, 'gi'), '');
  svg = svg.replace(
    new RegExp(`<${DANGEROUS_SVG_TAG}\\b[^>]*>[\\s\\S]*?<\\/${DANGEROUS_SVG_TAG}\\s*>`, 'gi'),
    '',
  );
  return svg;
}

/** Decode numeric / common named entities used in URI-scheme bypasses. */
function decodeHtmlEntities(input: string): string {
  let out = input.replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : '';
  });
  out = out.replace(/&#([0-9]+);?/g, (_, dec: string) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : '';
  });
  out = out.replace(/&colon;/gi, ':');
  out = out.replace(/&tab;/gi, '\t');
  out = out.replace(/&newline;/gi, '\n');
  return out;
}

/** Replace `url(javascript:…)` / `url(data:…)` with `none`, including nested `()`. */
function stripDangerousCssUrls(input: string): string {
  const re = /url\s*\(\s*(['"]?)\s*(?:javascript|data)\s*:/gi;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out += input.slice(last, match.index);
    out += 'none';
    const openParen = input.indexOf('(', match.index);
    let depth = 1;
    let i = openParen + 1;
    while (i < input.length && depth > 0) {
      const ch = input[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }
    last = i;
    re.lastIndex = i;
  }
  out += input.slice(last);
  return out;
}

function prepareAssetBytes(data: Buffer, mime: string): Buffer {
  return mime === 'image/svg+xml' ? sanitizeSvg(data) : data;
}

/** Response headers for every nemo-asset payload; SVG gets a tight CSP. */
function assetResponseHeaders(mime: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (mime === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return headers;
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
            headers: assetResponseHeaders('image/png'),
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
            headers: assetResponseHeaders('image/png'),
          });
        }
        // Undecodable as raster (often SVG) — serve sanitized original bytes.
        const fallback = prepareAssetBytes(data, mime);
        return new Response(new Uint8Array(fallback), {
          status: 200,
          headers: assetResponseHeaders(mime),
        });
      }

      const data = prepareAssetBytes(await fs.readFile(abs), mime);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: assetResponseHeaders(mime),
      });
    } catch {
      return notFound();
    }
  });
}
