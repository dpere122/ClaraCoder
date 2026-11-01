import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getAppDataDir } from '../paths';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_STORED_BYTES = 100 * 1024 * 1024;
const MAX_STORED_IMAGES = 200;

export function captureAssetId(raw: string): string | null {
  const match = /^nemo-asset:\/\/capture\/([a-f0-9]{32})\.png$/.exec(raw);
  return match?.[1] ?? null;
}

function assetDirectory(): string {
  return join(getAppDataDir(), 'web-captures');
}

/** Fixed PNG-only app-owned storage, never a model-supplied filesystem path. */
export async function saveCaptureAsset(png: Buffer): Promise<string> {
  if (png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Screenshot did not produce a bounded PNG.');
  }
  const directory = assetDirectory();
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory);
  const files = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{32}\.png$/.test(name)) continue;
    const stat = await fs.lstat(join(directory, name));
    if (stat.isFile()) files.push({ name, size: stat.size, time: stat.mtimeMs });
  }
  files.sort((a, b) => a.time - b.time);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  while (files.length && (files.length >= MAX_STORED_IMAGES || total + png.length > MAX_STORED_BYTES)) {
    const oldest = files.shift()!;
    await fs.unlink(join(directory, oldest.name));
    total -= oldest.size;
  }
  const id = randomBytes(16).toString('hex');
  await fs.writeFile(join(directory, `${id}.png`), png, { flag: 'wx', mode: 0o600 });
  return `nemo-asset://capture/${id}.png`;
}

/** Opaque ids can only read locally generated PNGs; no traversal, query, SVG or remote fetch. */
export async function captureAssetResponse(raw: string): Promise<Response> {
  const id = captureAssetId(raw);
  if (!id) return new Response('Not found', { status: 404 });
  try {
    const file = join(assetDirectory(), `${id}.png`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PNG_BYTES) {
      return new Response('Not found', { status: 404 });
    }
    const png = await fs.readFile(file);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(png), { headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}
