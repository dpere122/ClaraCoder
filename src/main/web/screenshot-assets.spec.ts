import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ appData: '' }));
vi.mock('../paths', () => ({ getAppDataDir: () => mocks.appData }));
import { captureAssetId, captureAssetResponse, saveCaptureAsset } from './screenshot-assets';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWioAAAAASUVORK5CYII=', 'base64');
beforeEach(async () => { mocks.appData = await mkdtemp(join(tmpdir(), 'clara-capture-')); });
afterEach(async () => { await rm(mocks.appData, { recursive: true, force: true }); });

describe('local PNG screenshot assets', () => {
  it('stores an opaque PNG asset and serves only local image bytes', async () => {
    const url = await saveCaptureAsset(png);
    expect(captureAssetId(url)).toMatch(/^[a-f0-9]{32}$/);
    const response = await captureAssetResponse(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it.each([
    'nemo-asset://capture/../../config.json', 'nemo-asset://capture/%2e%2e/config.json',
    'nemo-asset://capture/' + 'a'.repeat(32) + '.svg',
    'nemo-asset://capture/' + 'a'.repeat(32) + '.png?url=https://example.com',
    'https://example.com/image.png', 'nemo-asset://workspace/?root=C:/&path=secret.png',
  ])('rejects path, format or remote bypass %s', async (url) => {
    expect(captureAssetId(url)).toBeNull();
    expect((await captureAssetResponse(url)).status).toBe(404);
  });

  it('rejects active content and corrupt stored bytes', async () => {
    await expect(saveCaptureAsset(Buffer.from('<svg onload="alert(1)"/>'))).rejects.toThrow('PNG');
    const url = await saveCaptureAsset(png);
    await writeFile(join(mocks.appData, 'web-captures', `${captureAssetId(url)}.png`), '<html>active</html>');
    expect((await captureAssetResponse(url)).status).toBe(404);
  });

  it('bounds disk retention instead of accumulating screenshots indefinitely', async () => {
    for (let i = 0; i < 202; i++) await saveCaptureAsset(png);
    expect((await readdir(join(mocks.appData, 'web-captures'))).length).toBe(200);
  });
});
