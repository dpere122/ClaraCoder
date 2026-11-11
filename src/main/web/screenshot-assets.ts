import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import {
  normalizeScreenshotRetention,
  type ScreenshotAssetStatus,
  type ScreenshotRetentionSettings,
  type ScreenshotStorageStats,
} from '../../shared/screenshot-retention';
import { getAppDataDir } from '../paths';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const TOMBSTONE_DAYS = 90;
const MAX_TOMBSTONES = 5000;
const ID = /^[a-f0-9]{32}$/;
const PNG_NAME = /^([a-f0-9]{32})\.png$/;
const METADATA_NAME = 'retention.json';

type ImageMetadata = { capturedAt: number; reduced: boolean };
type Tombstone = { expiredAt: number; reason: 'age' | 'storage' | 'cleared'; retentionDays?: number };
type Metadata = { version: 1; images: Record<string, ImageMetadata>; tombstones: Record<string, Tombstone> };
type StoredImage = { id: string; size: number; metadata: ImageMetadata };
type Store = { directory: string; metadata: Metadata; images: StoredImage[]; dirty: boolean; now: number };

let retention = normalizeScreenshotRetention(undefined);
let pending: Promise<unknown> = Promise.resolve();

/** All disk work, including protocol reads, shares this queue. Rejections never poison it. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.catch(() => undefined);
  return result;
}

export function configureCaptureRetention(settings: unknown): void {
  retention = normalizeScreenshotRetention(settings);
}

export function captureAssetId(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^nemo-asset:\/\/capture\/([a-f0-9]{32})\.png$/.exec(raw);
  return match?.[0] === raw ? match[1] : null;
}

function assetDirectory(): string {
  return join(getAppDataDir(), 'web-captures');
}

function imagePath(store: Store, id: string): string {
  return join(store.directory, `${id}.png`);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Never follow even a correctly named symlink, and bound reads before allocating. */
async function readRegular(file: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
    throw new Error('Unsafe capture file.');
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit ||
        opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Capture file changed.');
    // A bounded buffer prevents a concurrently growing file from causing an unlimited read.
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error('Capture file changed.');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

function decodePng(png: Buffer): Electron.NativeImage {
  if (png.length < 33 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Screenshot did not produce a bounded PNG.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width * height > 64 * 1024 * 1024) throw new Error('Screenshot PNG is too large.');
  const image = nativeImage.createFromBuffer(png);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== width || size.height !== height) throw new Error('Screenshot PNG is corrupt.');
  return image;
}

/** Same-directory rename replaces atomically on Windows too; never unlink the destination first. */
async function replaceAtomic(directory: string, destination: string, bytes: Buffer | string): Promise<void> {
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
}

function pruneTombstones(store: Store): void {
  const entries = Object.entries(store.metadata.tombstones)
    .filter(([, entry]) => entry.expiredAt > store.now - TOMBSTONE_DAYS * DAY)
    .sort((a, b) => b[1].expiredAt - a[1].expiredAt);
  if (entries.length > MAX_TOMBSTONES || entries.length !== Object.keys(store.metadata.tombstones).length) {
    store.metadata.tombstones = Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
    store.dirty = true;
  }
}

async function persist(store: Store): Promise<void> {
  if (!store.dirty) return;
  pruneTombstones(store);
  await replaceAtomic(store.directory, join(store.directory, METADATA_NAME), JSON.stringify(store.metadata));
  store.dirty = false;
}

async function readMetadata(directory: string, now: number): Promise<Metadata> {
  const metadata: Metadata = { version: 1, images: {}, tombstones: {} };
  let value: any;
  const file = join(directory, METADATA_NAME);
  try {
    // A metadata symlink is not a legacy store and must not be silently accepted.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe capture metadata.');
    try { value = JSON.parse((await readRegular(file, MAX_METADATA_BYTES)).toString('utf8')); }
    catch { return metadata; }
  } catch (error) {
    if (missing(error)) return metadata;
    throw error;
  }
  if (value?.version !== 1 || !value.images || !value.tombstones) return metadata;
  for (const [id, raw] of Object.entries(value.images)) {
    const entry = raw as Partial<ImageMetadata> | null;
    if (ID.test(id) && entry && typeof entry.capturedAt === 'number' && Number.isFinite(entry.capturedAt) && entry.capturedAt >= 0) {
      metadata.images[id] = { capturedAt: Math.min(entry.capturedAt, now), reduced: entry.reduced === true };
    }
  }
  for (const [id, raw] of Object.entries(value.tombstones)) {
    const entry = raw as Partial<Tombstone> | null;
    if (ID.test(id) && entry && typeof entry.expiredAt === 'number' && Number.isFinite(entry.expiredAt) &&
        entry.expiredAt >= 0 && entry.expiredAt <= now &&
        (entry.reason === 'age' || entry.reason === 'storage' || entry.reason === 'cleared')) {
      metadata.tombstones[id] = {
        expiredAt: entry.expiredAt, reason: entry.reason,
        ...(entry.reason === 'age' && Number.isInteger(entry.retentionDays) && entry.retentionDays! >= 2 && entry.retentionDays! <= 365
          ? { retentionDays: entry.retentionDays } : {}),
      };
    }
  }
  return metadata;
}

async function openStore(): Promise<Store> {
  const directory = assetDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Unsafe capture directory.');
  const now = Date.now();
  const metadata = await readMetadata(directory, now);
  const store: Store = { directory, metadata, images: [], dirty: false, now };
  const found = new Set<string>();
  for (const name of await fs.readdir(directory)) {
    const path = join(directory, name);
    if (/^\.[a-f0-9]{32}\.tmp$/.test(name)) {
      await fs.unlink(path); // Only our bounded atomic-write scratch files; unlink never follows links.
      continue;
    }
    const match = PNG_NAME.exec(name);
    if (!match) continue;
    const id = match[1];
    // A crash after persisting a deletion must not resurrect its still-present PNG.
    if (metadata.tombstones[id]) { await fs.unlink(path); continue; }
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 33 || stat.size > MAX_PNG_BYTES) {
      if (!stat.isDirectory()) await fs.unlink(path);
      continue;
    }
    let entry = metadata.images[id];
    if (!entry) {
      try { decodePng(await readRegular(path, MAX_PNG_BYTES)); }
      catch { await fs.unlink(path); continue; }
      entry = { capturedAt: Math.min(stat.mtimeMs, now), reduced: false };
      metadata.images[id] = entry;
      store.dirty = true;
    }
    found.add(id);
    store.images.push({ id, size: stat.size, metadata: entry });
  }
  for (const id of Object.keys(metadata.images)) {
    if (!found.has(id)) { delete metadata.images[id]; store.dirty = true; }
  }
  store.images.sort((a, b) => a.metadata.capturedAt - b.metadata.capturedAt || a.id.localeCompare(b.id));
  pruneTombstones(store);
  // Capture legacy mtimes durably BEFORE replacing PNGs (which changes mtime).
  await persist(store);
  return store;
}

async function expire(store: Store, images: StoredImage[], reason: Tombstone['reason'], policy: ScreenshotRetentionSettings): Promise<void> {
  if (!images.length) return;
  for (const image of images) {
    store.metadata.tombstones[image.id] = {
      expiredAt: store.now, reason, ...(reason === 'age' ? { retentionDays: policy.retentionDays } : {}),
    };
    delete store.metadata.images[image.id];
  }
  store.dirty = true;
  await persist(store); // Tombstones precede unlink, so interrupted cleanup still produces 410.
  const removed = new Set(images.map(image => image.id));
  for (const image of images) {
    await fs.unlink(imagePath(store, image.id)).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
  store.images = store.images.filter(image => !removed.has(image.id));
}

async function maintain(store: Store, policy: ScreenshotRetentionSettings, reserveBytes = 0, reserveImages = 0): Promise<void> {
  await expire(store, store.images.filter(image => store.now - image.metadata.capturedAt >= policy.retentionDays * DAY), 'age', policy);
  // Aged images get their chance to shrink BEFORE either byte or image-count eviction.
  for (const image of store.images) {
    if (store.now - image.metadata.capturedAt < policy.downscaleAfterDays * DAY) continue;
    try {
      const original = await readRegular(imagePath(store, image.id), MAX_PNG_BYTES);
      const decoded = decodePng(original);
      const { width, height } = decoded.getSize();
      if (width <= policy.maxWidth) continue;
      const targetHeight = Math.max(1, Math.round(height * policy.maxWidth / width));
      const reduced = decoded.resize({ width: policy.maxWidth, height: targetHeight, quality: 'best' }).toPNG();
      if (reduced.length >= original.length) continue;
      const actual = decodePng(reduced).getSize();
      if (actual.width !== policy.maxWidth || actual.height !== targetHeight) continue;
      await replaceAtomic(store.directory, imagePath(store, image.id), reduced);
      image.size = reduced.length;
      image.metadata.reduced = true;
      store.dirty = true;
    } catch {
      // A failed native resize or atomic replace leaves the original intact. Quotas still apply.
    }
  }
  await persist(store);
  let bytes = store.images.reduce((sum, image) => sum + image.size, 0) + reserveBytes;
  let count = store.images.length + reserveImages;
  const remove: StoredImage[] = [];
  for (const image of store.images) {
    if (bytes <= policy.maxStorageMiB * 1024 * 1024 && count <= policy.maxImages) break;
    remove.push(image);
    bytes -= image.size;
    count--;
  }
  await expire(store, remove, 'storage', policy);
}

export function runCaptureMaintenance(): Promise<void> {
  return serialized(async () => { const policy = retention; await maintain(await openStore(), policy); });
}

export function getCaptureStorageStats(): Promise<ScreenshotStorageStats> {
  return serialized(async () => {
    const policy = retention;
    // Usage refresh is observational: only the scheduler, saves and explicit
    // cleanup perform bulk image compression and quota eviction.
    const store = await openStore();
    return {
      bytes: store.images.reduce((sum, image) => sum + image.size, 0),
      imageCount: store.images.length,
      reducedCount: store.images.filter(image => image.metadata.reduced).length,
      maxBytes: policy.maxStorageMiB * 1024 * 1024,
      maxImages: policy.maxImages,
    };
  });
}

export function clearCaptureAssets(): Promise<void> {
  return serialized(async () => {
    const policy = retention;
    const store = await openStore();
    await expire(store, [...store.images], 'cleared', policy);
  });
}

/** Fixed PNG-only app-owned storage, never a model-supplied filesystem path. */
export function saveCaptureAsset(png: Buffer): Promise<string> {
  if (!Buffer.isBuffer(png) || png.length < 33 || png.length > MAX_PNG_BYTES) {
    return Promise.reject(new Error('Screenshot did not produce a bounded PNG.'));
  }
  // Own the buffer before entering the asynchronous queue; caller mutation cannot change validation.
  const owned = Buffer.from(png);
  return serialized(async () => {
    decodePng(owned);
    const policy = retention;
    if (owned.length > policy.maxStorageMiB * 1024 * 1024) throw new Error('Screenshot PNG exceeds the storage limit.');
    const store = await openStore();
    await maintain(store, policy, owned.length, 1);
    const id = randomBytes(16).toString('hex');
    await replaceAtomic(store.directory, imagePath(store, id), owned);
    store.metadata.images[id] = { capturedAt: store.now, reduced: false };
    store.dirty = true;
    try { await persist(store); }
    catch (error) { await fs.unlink(imagePath(store, id)); throw error; }
    return `nemo-asset://capture/${id}.png`;
  });
}

async function resolveAsset(raw: string): Promise<{ status: ScreenshotAssetStatus; png?: Buffer }> {
  const id = captureAssetId(raw);
  if (!id) return { status: { state: 'missing' } };
  const policy = retention;
  const store = await openStore();
  // Protocol/status reads enforce this capture's expiry, but never resize every
  // other image in the store while the user is loading a conversation.
  const image = store.images.find(entry => entry.id === id);
  if (image && store.now - image.metadata.capturedAt >= policy.retentionDays * DAY) {
    await expire(store, [image], 'age', policy);
  }
  const tombstone = store.metadata.tombstones[id];
  if (tombstone) return { status: {
    state: 'expired', reason: tombstone.reason,
    ...(tombstone.retentionDays === undefined ? {} : { retentionDays: tombstone.retentionDays }),
  } };
  if (!store.metadata.images[id]) return { status: { state: 'missing' } };
  try {
    const png = await readRegular(imagePath(store, id), MAX_PNG_BYTES);
    decodePng(png);
    return { status: { state: 'available' }, png };
  } catch { return { status: { state: 'missing' } }; }
}

export function getCaptureAssetStatus(raw: string): Promise<ScreenshotAssetStatus> {
  return serialized(async () => {
    try { return (await resolveAsset(raw)).status; }
    catch { return { state: 'missing' }; }
  });
}

/** Opaque ids can only read local PNGs; no traversal, query, SVG or remote fetch. */
export function captureAssetResponse(raw: string): Promise<Response> {
  return serialized(async () => {
    try {
      const asset = await resolveAsset(raw);
      if (!asset.png) return new Response(asset.status.state === 'expired' ? 'Screenshot expired' : 'Not found', {
        status: asset.status.state === 'expired' ? 410 : 404,
        headers: { 'Cache-Control': 'no-store' },
      });
      return new Response(new Uint8Array(asset.png), { headers: {
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'no-store',
      } });
    } catch { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
  });
}
