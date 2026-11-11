import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ appData: '', create: vi.fn(), resize: vi.fn() }));
vi.mock('../paths', () => ({ getAppDataDir: () => mocks.appData }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: mocks.create } }));
import {
  captureAssetId, captureAssetResponse, clearCaptureAssets, configureCaptureRetention,
  getCaptureAssetStatus, getCaptureStorageStats, runCaptureMaintenance, saveCaptureAsset,
} from './screenshot-assets';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWioAAAAASUVORK5CYII=', 'base64');
const DAY = 24 * 60 * 60 * 1000;
let now: number;
const directory = () => join(mocks.appData, 'web-captures');
const file = (url: string) => join(directory(), `${captureAssetId(url)}.png`);
const metadata = async () => JSON.parse(await fs.readFile(join(directory(), 'retention.json'), 'utf8'));
const storedNames = async () => (await fs.readdir(directory())).filter(name => name.endsWith('.png'));

// Synthetic PNG-sized fixtures exercise storage without loading Electron in the Node test runner.
// Native decoding itself is mocked; production uses nativeImage, never a remote decoder.
function fixture(width: number, height: number, length = 1024): Buffer {
  const bytes = Buffer.alloc(length);
  png.copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  png.subarray(-12).copy(bytes, length - 12);
  return bytes;
}

beforeEach(async () => {
  mocks.appData = await fs.mkdtemp(join(tmpdir(), 'clara-capture-'));
  now = Date.UTC(2026, 0, 1);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  configureCaptureRetention(undefined);
  mocks.resize.mockReset().mockImplementation((options, original: Buffer) => fixture(options.width, options.height, Math.max(png.length, Math.floor(original.length / 2))));
  mocks.create.mockReset().mockImplementation((bytes: Buffer) => ({
    isEmpty: () => bytes.length < png.length || !bytes.subarray(-12).equals(png.subarray(-12)),
    getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
    resize: (options: unknown) => ({ toPNG: () => mocks.resize(options, bytes) }),
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(mocks.appData, { recursive: true, force: true });
});

describe('local PNG screenshot assets', () => {
  it('stores opaque PNGs and serves only local image bytes with security headers', async () => {
    const url = await saveCaptureAsset(png);
    expect(captureAssetId(url)).toMatch(/^[a-f0-9]{32}$/);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'available' });
    const response = await captureAssetResponse(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(await getCaptureStorageStats()).toEqual({ bytes: png.length, imageCount: 1, reducedCount: 0, maxBytes: 100 * 1024 * 1024, maxImages: 200 });
  });

  it.each([
    'nemo-asset://capture/../../config.json', 'nemo-asset://capture/%2e%2e/config.json',
    'nemo-asset://capture/' + 'a'.repeat(32) + '.svg',
    'nemo-asset://capture/' + 'a'.repeat(32) + '.png?url=https://example.com',
    'https://example.com/image.png', 'nemo-asset://workspace/?root=C:/&path=secret.png',
    'nemo-asset://capture/' + 'A'.repeat(32) + '.png',
    'nemo-asset://capture/' + 'a'.repeat(32) + '.png\n',
  ])('rejects path, format or remote bypass %s', async (url) => {
    expect(captureAssetId(url)).toBeNull();
    expect((await captureAssetResponse(url)).status).toBe(404);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'missing' });
  });

  it('rejects oversized, signature-only, undecodable and active-content inputs', async () => {
    for (const bytes of [Buffer.from('<svg onload="alert(1)"/>'), png.subarray(0, 33), fixture(1, 1, 12 * 1024 * 1024 + 1)]) {
      await expect(saveCaptureAsset(bytes)).rejects.toThrow('PNG');
    }
    mocks.create.mockReturnValueOnce({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }) });
    await expect(saveCaptureAsset(png)).rejects.toThrow('corrupt');
    expect((await getCaptureStorageStats()).imageCount).toBe(0);
  });

  it('rejects corrupt stored bytes even if their PNG signature is intact', async () => {
    const url = await saveCaptureAsset(png);
    const corrupt = Buffer.from(png);
    corrupt.fill(0, corrupt.length - 12);
    await fs.writeFile(file(url), corrupt);
    expect((await captureAssetResponse(url)).status).toBe(404);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'missing' });
  });

  it('owns queued buffers and recovers after a failed save', async () => {
    const bytes = Buffer.from(png);
    const saved = saveCaptureAsset(bytes);
    bytes.fill(0);
    const url = await saved;
    expect(await fs.readFile(file(url))).toEqual(png);
    await expect(saveCaptureAsset(Buffer.from('bad'))).rejects.toThrow();
    expect((await captureAssetResponse(await saveCaptureAsset(png))).status).toBe(200);
  });

  it('bounds default disk retention and records storage tombstones', async () => {
    const first = await saveCaptureAsset(png);
    // Seed a full legacy store without 200 serial metadata rewrites (slow on Windows).
    await Promise.all(Array.from({ length: 199 }, async (_, i) => {
      const path = join(directory(), `${i.toString(16).padStart(32, '0')}.png`);
      await fs.writeFile(path, png);
      await fs.utimes(path, (now + 1) / 1000, (now + 1) / 1000);
    }));
    now += 2;
    await saveCaptureAsset(png);
    expect((await storedNames()).length).toBe(200);
    expect(await getCaptureAssetStatus(first)).toEqual({ state: 'expired', reason: 'storage' });
    expect((await captureAssetResponse(first)).status).toBe(410);
    expect((await captureAssetResponse('nemo-asset://capture/' + 'f'.repeat(32) + '.png')).status).toBe(404);
  });
});

describe('capture lifecycle and persistent metadata', () => {
  it('only reduces after seven days, preserves aspect ratio, capturedAt and the stable URL', async () => {
    const capturedAt = now;
    const url = await saveCaptureAsset(fixture(1920, 1080));
    now += 7 * DAY - 1;
    await runCaptureMaintenance();
    expect(mocks.resize).not.toHaveBeenCalled();
    now++;
    await runCaptureMaintenance();
    expect(mocks.resize).toHaveBeenCalledWith({ width: 1280, height: 720, quality: 'best' }, expect.any(Buffer));
    expect((await fs.readFile(file(url))).length).toBe(512);
    expect((await metadata()).images[captureAssetId(url)!]).toEqual({ capturedAt, reduced: true });
    expect((await getCaptureStorageStats()).reducedCount).toBe(1);
    expect((await captureAssetResponse(url)).status).toBe(200);
    now = capturedAt + 30 * DAY;
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'expired', reason: 'age', retentionDays: 30 });
    expect((await captureAssetResponse(url)).status).toBe(410);
    expect(await storedNames()).toEqual([]);
  });

  it('does not run bulk compression or quota eviction when reading an image or refreshing usage', async () => {
    const url = await saveCaptureAsset(fixture(1920, 1080));
    await saveCaptureAsset(fixture(1920, 1080));
    now += 8 * DAY;
    configureCaptureRetention({ maxStorageMiB: 10 });
    expect((await captureAssetResponse(url)).status).toBe(200);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'available' });
    expect(await getCaptureStorageStats()).toMatchObject({ imageCount: 2, reducedCount: 0 });
    expect(mocks.resize).not.toHaveBeenCalled();
    await runCaptureMaintenance();
    expect(mocks.resize).toHaveBeenCalledTimes(2);
  });

  it('migrates legacy PNG mtime before resizing and survives a module restart', async () => {
    const id = 'a'.repeat(32);
    const path = join(directory(), `${id}.png`);
    const capturedAt = now - 9 * DAY;
    await fs.mkdir(directory());
    await fs.writeFile(path, fixture(1920, 1080));
    await fs.utimes(path, capturedAt / 1000, capturedAt / 1000);
    await runCaptureMaintenance();
    expect((await metadata()).images[id]).toEqual({ capturedAt, reduced: true });
    expect((await fs.readFile(path)).length).toBe(512);
    vi.resetModules();
    const restarted = await import('./screenshot-assets');
    now = capturedAt + 30 * DAY;
    await restarted.runCaptureMaintenance();
    expect(await restarted.getCaptureAssetStatus(`nemo-asset://capture/${id}.png`)).toEqual({ state: 'expired', reason: 'age', retentionDays: 30 });
  });

  it('never enlarges narrow images and keeps a smaller original if resize PNG is bigger', async () => {
    const narrow = await saveCaptureAsset(fixture(800, 1600));
    const wide = await saveCaptureAsset(fixture(1920, 1080));
    mocks.resize.mockImplementation(options => fixture(options.width, options.height, 2048));
    now += 8 * DAY;
    await runCaptureMaintenance();
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    expect((await fs.readFile(file(narrow))).length).toBe(1024);
    expect((await fs.readFile(file(wide))).length).toBe(1024);
    expect((await getCaptureStorageStats()).reducedCount).toBe(0);
    expect(Object.values((await metadata()).images).every((entry: any) => !entry.reduced)).toBe(true);
  });

  it('supports policy reloads, including reducing an already-reduced image further', async () => {
    const url = await saveCaptureAsset(fixture(1920, 1080));
    now += 8 * DAY;
    await runCaptureMaintenance();
    configureCaptureRetention({ maxWidth: 640, retentionDays: 10, maxImages: 10, maxStorageMiB: 10 });
    await runCaptureMaintenance();
    const bytes = await fs.readFile(file(url));
    expect(bytes.readUInt32BE(16)).toBe(640);
    expect(bytes.readUInt32BE(20)).toBe(360);
    expect(await getCaptureStorageStats()).toMatchObject({ maxBytes: 10 * 1024 * 1024, maxImages: 10 });
    now += 2 * DAY;
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'expired', reason: 'age', retentionDays: 10 });
  });

  it('retains originals and timestamps when native resizing fails', async () => {
    const capturedAt = now;
    const bytes = fixture(1920, 1080);
    const url = await saveCaptureAsset(bytes);
    now += 8 * DAY;
    mocks.resize.mockImplementation(() => { throw new Error('native resize failed'); });
    await runCaptureMaintenance();
    expect(await fs.readFile(file(url))).toEqual(bytes);
    expect((await metadata()).images[captureAssetId(url)!]).toEqual({ capturedAt, reduced: false });
  });

  it('retains the old PNG on Windows-style replace failure and cleans scratch files', async () => {
    const bytes = fixture(1920, 1080);
    const url = await saveCaptureAsset(bytes);
    now += 8 * DAY;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('.png')) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      return rename(source, destination);
    });
    await runCaptureMaintenance();
    expect(await fs.readFile(file(url))).toEqual(bytes);
    expect((await metadata()).images[captureAssetId(url)!].reduced).toBe(false);
    expect((await fs.readdir(directory())).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('does not resize legacy captures until their original timestamp is persisted', async () => {
    const id = 'b'.repeat(32);
    await fs.mkdir(directory());
    const path = join(directory(), `${id}.png`);
    const bytes = fixture(1920, 1080);
    await fs.writeFile(path, bytes);
    await fs.utimes(path, (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('metadata write failed'));
    await expect(runCaptureMaintenance()).rejects.toThrow('metadata write failed');
    expect(mocks.resize).not.toHaveBeenCalled();
    expect(await fs.readFile(path)).toEqual(bytes);
    expect((await fs.readdir(directory())).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('rolls back a new PNG when metadata persistence fails and remains usable', async () => {
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('retention.json')) throw new Error('metadata failed');
      return rename(source, destination);
    });
    await expect(saveCaptureAsset(png)).rejects.toThrow('metadata failed');
    expect(await storedNames()).toEqual([]);
    expect(await fs.readdir(directory())).toEqual([]);
    spy.mockRestore();
    await expect(saveCaptureAsset(png)).resolves.toMatch(/^nemo-asset:/);
  });
});

describe('capture quotas, clearing and concurrency', () => {
  it('reduces eligible images before evicting for the byte quota', async () => {
    const a = await saveCaptureAsset(fixture(1920, 1080, 6 * 1024 * 1024));
    const b = await saveCaptureAsset(fixture(1920, 1080, 6 * 1024 * 1024));
    configureCaptureRetention({ maxStorageMiB: 10 });
    now += 8 * DAY;
    await runCaptureMaintenance();
    expect(await getCaptureStorageStats()).toMatchObject({ imageCount: 2, bytes: 6 * 1024 * 1024, reducedCount: 2 });
    expect(await getCaptureAssetStatus(a)).toEqual({ state: 'available' });
    expect(await getCaptureAssetStatus(b)).toEqual({ state: 'available' });
  });

  it('never reduces recent captures just to meet quota and evicts by capturedAt, not mtime', async () => {
    const a = await saveCaptureAsset(fixture(1920, 1080, 6 * 1024 * 1024));
    now += DAY;
    const b = await saveCaptureAsset(fixture(1920, 1080, 6 * 1024 * 1024));
    await fs.utimes(file(a), (now + DAY) / 1000, (now + DAY) / 1000);
    configureCaptureRetention({ maxStorageMiB: 10 });
    await runCaptureMaintenance();
    expect(mocks.resize).not.toHaveBeenCalled();
    expect(await getCaptureAssetStatus(a)).toEqual({ state: 'expired', reason: 'storage' });
    expect(await getCaptureAssetStatus(b)).toEqual({ state: 'available' });
  });

  it('rejects a capture larger than the live byte cap without evicting existing captures', async () => {
    const url = await saveCaptureAsset(png);
    configureCaptureRetention({ maxStorageMiB: 10 });
    await expect(saveCaptureAsset(fixture(1920, 1080, 11 * 1024 * 1024))).rejects.toThrow('storage limit');
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'available' });
  });

  it('serializes concurrent saves so neither quota nor metadata updates are lost', async () => {
    configureCaptureRetention({ maxImages: 10 });
    const urls = await Promise.all(Array.from({ length: 25 }, () => saveCaptureAsset(png)));
    expect(new Set(urls).size).toBe(25);
    expect((await getCaptureStorageStats()).imageCount).toBe(10);
    const states = await Promise.all(urls.map(getCaptureAssetStatus));
    expect(states.filter(status => status.state === 'available')).toHaveLength(10);
    expect(states.filter(status => status.reason === 'storage')).toHaveLength(15);
    expect(Object.keys((await metadata()).images)).toHaveLength(10);
  });

  it('serializes saves, maintenance, clear and reads, then continues saving normally', async () => {
    const first = saveCaptureAsset(png);
    const maintenance = runCaptureMaintenance();
    const clear = clearCaptureAssets();
    const second = saveCaptureAsset(png);
    const [a, , , b] = await Promise.all([first, maintenance, clear, second]);
    expect(await getCaptureAssetStatus(a)).toEqual({ state: 'expired', reason: 'cleared' });
    expect((await captureAssetResponse(a)).status).toBe(410);
    expect(await getCaptureAssetStatus(b)).toEqual({ state: 'available' });
    const clearing = clearCaptureAssets();
    const response = captureAssetResponse(b);
    await clearing;
    expect((await response).status).toBe(410);
    expect(await getCaptureStorageStats()).toMatchObject({ bytes: 0, imageCount: 0, reducedCount: 0 });
    await clearCaptureAssets();
    expect((await fs.readdir(directory())).filter(name => name !== 'retention.json')).toEqual([]);
  });

  it('expires tombstones after ninety days and caps metadata at five thousand records', async () => {
    const url = await saveCaptureAsset(png);
    await clearCaptureAssets();
    const clearedAt = now;
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 5001; i++) {
      entries[i.toString(16).padStart(32, '0')] = { expiredAt: now - i, reason: 'storage' };
    }
    entries[captureAssetId(url)!] = { expiredAt: now - 91 * DAY, reason: 'cleared' };
    await fs.writeFile(join(directory(), 'retention.json'), JSON.stringify({ version: 1, images: {}, tombstones: entries }));
    await runCaptureMaintenance();
    expect(Object.keys((await metadata()).tombstones)).toHaveLength(5000);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'missing' });
    const recent = `nemo-asset://capture/${'0'.repeat(32)}.png`;
    expect((await captureAssetResponse(recent)).status).toBe(410);
    now = clearedAt + 90 * DAY;
    expect((await captureAssetResponse(recent)).status).toBe(404);
    expect(Object.keys((await metadata()).tombstones)).toHaveLength(0);
  });

  it('does not resurrect a PNG left behind after an interrupted deletion', async () => {
    const url = await saveCaptureAsset(png);
    await clearCaptureAssets();
    await fs.writeFile(file(url), png);
    await runCaptureMaintenance();
    expect(await storedNames()).toEqual([]);
    expect(await getCaptureAssetStatus(url)).toEqual({ state: 'expired', reason: 'cleared' });
  });
});

describe('capture filesystem safety', () => {
  it('rejects a symlinked capture directory without modifying its external target', async () => {
    const outside = join(mocks.appData, 'outside');
    await fs.mkdir(outside);
    const target = join(outside, 'a'.repeat(32) + '.png');
    await fs.writeFile(target, png);
    await fs.symlink(outside, directory(), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(saveCaptureAsset(png)).rejects.toThrow('Unsafe capture directory');
    await expect(clearCaptureAssets()).rejects.toThrow('Unsafe capture directory');
    expect((await captureAssetResponse('nemo-asset://capture/' + 'a'.repeat(32) + '.png')).status).toBe(404);
    expect(await fs.readFile(target)).toEqual(png);
  });

  it('never follows a file symlink even when its name is a valid opaque PNG id', async (context) => {
    const outside = join(mocks.appData, 'outside.png');
    await fs.writeFile(outside, png);
    await fs.mkdir(directory());
    const url = 'nemo-asset://capture/' + 'a'.repeat(32) + '.png';
    try { await fs.symlink(outside, file(url), 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
      throw error;
    }
    expect((await captureAssetResponse(url)).status).toBe(404);
    await clearCaptureAssets();
    expect(await fs.readFile(outside)).toEqual(png);
  });

  it('rejects linked metadata without following or replacing its external target', async (context) => {
    const outside = join(mocks.appData, 'outside.json');
    await fs.writeFile(outside, '{"secret":true}');
    await fs.mkdir(directory());
    try { await fs.symlink(outside, join(directory(), 'retention.json'), 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
      throw error;
    }
    await expect(saveCaptureAsset(png)).rejects.toThrow('Unsafe capture metadata');
    expect(await fs.readFile(outside, 'utf8')).toBe('{"secret":true}');
  });
});
