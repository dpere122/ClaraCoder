import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HfDownloadProgressEvent } from '../shared';

const { downloadFile, pathsInfo, sent, dirs } = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  pathsInfo: vi.fn(),
  sent: [] as unknown[],
  dirs: { appData: '' },
}));

vi.mock('@huggingface/hub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@huggingface/hub')>()),
  downloadFile,
  pathsInfo,
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (_channel: string, payload: unknown) => sent.push(payload) } },
    ],
  },
}));
vi.mock('./paths', () => ({ getAppDataDir: () => dirs.appData }));

import {
  cancelHfDownload,
  cancelHfDownloadsUnder,
  hfDownloadId,
  listHfDownloads,
  pauseHfDownload,
  resetHfDownloadTrackerForTests,
  startHfDownload,
} from './hf-download-tracker';
import { hubCacheLayout } from './ipc/handlers/hf-hub-download';

const REPO_ID = 'org/model';
const FILE_NAME = 'model-Q4_K_M.gguf';
const ETAG = 'abc123etag';
const SNAPSHOT = '0123456789abcdef0123456789abcdef01234567';
const PAYLOAD = Buffer.from('gguf-payload-bytes');
const FIRST = 7;
const ID = hfDownloadId(REPO_ID, FILE_NAME);

/** The whole file is promised, but the stream stalls after ``FIRST`` bytes: a download cut off mid-way. */
function stallingBlob(): Blob {
  return {
    size: PAYLOAD.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(PAYLOAD.subarray(0, FIRST)));
        },
      }),
  } as Blob;
}

/** The connection drops once the first ``FIRST`` bytes are on disk, as it would well into a real download. */
function breakingBlob(written: () => boolean): Blob {
  return {
    size: PAYLOAD.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(PAYLOAD.subarray(0, FIRST)));
        },
        async pull(controller) {
          await until(written);
          controller.error(new Error('socket hang up'));
        },
      }),
  } as Blob;
}

function phases(): string[] {
  return (sent as HfDownloadProgressEvent[]).map((e) => e.phase);
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe('Hugging Face downloads tracked in main', () => {
  let customDir = '';
  let incompletePath = '';

  beforeEach(() => {
    dirs.appData = mkdtempSync(path.join(os.tmpdir(), 'clara-hf-tracker-data-'));
    customDir = mkdtempSync(path.join(os.tmpdir(), 'clara-hf-tracker-models-'));
    incompletePath = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME).incompletePath;
    sent.length = 0;
    downloadFile.mockReset();
    pathsInfo.mockReset();
    pathsInfo.mockResolvedValue([
      {
        path: FILE_NAME,
        type: 'file',
        size: PAYLOAD.length,
        lfs: { oid: ETAG, size: PAYLOAD.length, pointerSize: 128 },
        lastCommit: { id: SNAPSHOT, title: 'c', date: new Date() },
      },
    ]);
    resetHfDownloadTrackerForTests();
  });

  afterEach(() => {
    rmSync(customDir, { recursive: true, force: true });
    rmSync(dirs.appData, { recursive: true, force: true });
  });

  const start = () => startHfDownload({ repoId: REPO_ID, fileName: FILE_NAME, customDir });
  const bytesOnDisk = () => (existsSync(incompletePath) ? statSync(incompletePath).size : 0);

  /** Start a download that stalls after ``FIRST`` bytes, then pause it. */
  async function pauseMidway(): Promise<void> {
    downloadFile.mockResolvedValue(stallingBlob());
    const running = start();
    await until(() => bytesOnDisk() === FIRST);
    expect(await listHfDownloads()).toMatchObject([{ downloadId: ID, status: 'downloading', totalBytes: PAYLOAD.length }]);
    expect(pauseHfDownload(ID)).toEqual({ ok: true });
    expect(await running).toEqual({ ok: false, error: 'Download paused.' });
  }

  it('lists a paused download, still after a restart, and resumes it from its partial file', async () => {
    await pauseMidway();
    expect(phases().at(-1)).toBe('paused');
    const paused = {
      downloadId: ID,
      repoId: REPO_ID,
      fileName: FILE_NAME,
      status: 'paused',
      receivedBytes: FIRST,
      totalBytes: PAYLOAD.length,
    };
    expect(await listHfDownloads()).toEqual([paused]);

    resetHfDownloadTrackerForTests();
    expect(await listHfDownloads()).toEqual([paused]);

    sent.length = 0;
    const whole = new Blob([new Uint8Array(PAYLOAD)]);
    const slice = vi.spyOn(whole, 'slice');
    downloadFile.mockResolvedValue(whole);
    const result = await start();
    expect(result.ok).toBe(true);
    expect(slice).toHaveBeenCalledWith(FIRST);
    expect(sent[0]).toMatchObject({ phase: 'queued', receivedBytes: FIRST, totalBytes: PAYLOAD.length });
    expect(phases().at(-1)).toBe('done');
    expect(readFileSync(hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME).blobPath)).toEqual(PAYLOAD);
    expect(await listHfDownloads()).toEqual([]);
  });

  it('refuses a second start of a download that is running', async () => {
    downloadFile.mockResolvedValue(stallingBlob());
    const running = start();
    await until(() => bytesOnDisk() === FIRST);
    expect(await start()).toEqual({ ok: false, error: 'This quant is already downloading.' });
    pauseHfDownload(ID);
    await running;
  });

  it('cancelling a paused download deletes its partial file and the folder it made', async () => {
    await pauseMidway();
    expect(await cancelHfDownload(ID)).toEqual({ ok: true });
    expect(phases().at(-1)).toBe('cancelled');
    expect(existsSync(path.join(customDir, 'models--org--model'))).toBe(false);
    expect(await listHfDownloads()).toEqual([]);
    resetHfDownloadTrackerForTests();
    expect(await listHfDownloads()).toEqual([]);
  });

  it('cancelling a running download deletes its partial file', async () => {
    downloadFile.mockResolvedValue(stallingBlob());
    const running = start();
    await until(() => bytesOnDisk() === FIRST);
    expect(await cancelHfDownload(ID)).toEqual({ ok: true });
    expect(await running).toEqual({ ok: false, error: 'Download cancelled.' });
    expect(phases().at(-1)).toBe('cancelled');
    expect(existsSync(incompletePath)).toBe(false);
    expect(await listHfDownloads()).toEqual([]);
  });

  it('keeps a download that failed part-way, as resumable', async () => {
    downloadFile.mockResolvedValue(breakingBlob(() => bytesOnDisk() === FIRST));
    expect(await start()).toEqual({ ok: false, error: 'socket hang up' });
    expect(sent.at(-1)).toMatchObject({ phase: 'error', resumable: true, receivedBytes: FIRST, error: 'socket hang up' });
    expect(await listHfDownloads()).toMatchObject([{ status: 'error', error: 'socket hang up', receivedBytes: FIRST }]);
  });

  it('does not keep a download that failed before its first byte', async () => {
    downloadFile.mockResolvedValue(null);
    const result = await start();
    expect(result.ok).toBe(false);
    expect(sent.at(-1)).toMatchObject({ phase: 'error' });
    expect((sent.at(-1) as HfDownloadProgressEvent).resumable).toBeUndefined();
    expect(await listHfDownloads()).toEqual([]);
  });

  it('forgets a paused download whose partial file was deleted outside the app', async () => {
    await pauseMidway();
    rmSync(incompletePath);
    expect(await listHfDownloads()).toEqual([]);
  });

  it('cancels what is under a folder about to be deleted, and waits for the file to be let go', async () => {
    downloadFile.mockResolvedValue(stallingBlob());
    const running = start();
    await until(() => bytesOnDisk() === FIRST);
    const repoFolder = path.join(customDir, 'models--org--model');
    await cancelHfDownloadsUnder(repoFolder);
    expect(existsSync(incompletePath)).toBe(false);
    expect(await running).toEqual({ ok: false, error: 'Download cancelled.' });
    await cancelHfDownloadsUnder(path.join(customDir, 'elsewhere'));
  });

  it('does not continue a partial file after the models folder changed', async () => {
    await pauseMidway();
    const movedDir = mkdtempSync(path.join(os.tmpdir(), 'clara-hf-tracker-moved-'));
    try {
      const whole = new Blob([new Uint8Array(PAYLOAD)]);
      const slice = vi.spyOn(whole, 'slice');
      downloadFile.mockResolvedValue(whole);
      const result = await startHfDownload({ repoId: REPO_ID, fileName: FILE_NAME, customDir: movedDir });
      expect(result.ok).toBe(true);
      expect(slice).not.toHaveBeenCalled();
      expect(existsSync(incompletePath)).toBe(false);
      expect(readFileSync(hubCacheLayout(movedDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME).blobPath)).toEqual(PAYLOAD);
    } finally {
      rmSync(movedDir, { recursive: true, force: true });
    }
  });
});
