import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const { downloadFile, pathsInfo } = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  pathsInfo: vi.fn(),
}));

vi.mock('@huggingface/hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@huggingface/hub')>();
  return {
    ...actual,
    downloadFile,
    pathsInfo,
  };
});

import { downloadHfGgufToHubCache, hubCacheLayout } from './hf-hub-download';

const REPO_ID = 'org/model';
const FILE_NAME = 'model-Q4_K_M.gguf';
const ETAG = 'abc123etag';
const SNAPSHOT = '0123456789abcdef0123456789abcdef01234567';
const PAYLOAD = Buffer.from('gguf-payload-bytes');

function mockPathInfo(): void {
  pathsInfo.mockResolvedValue([
    {
      path: FILE_NAME,
      type: 'file',
      size: PAYLOAD.length,
      lfs: { oid: ETAG, size: PAYLOAD.length, pointerSize: 128 },
      lastCommit: { id: SNAPSHOT, title: 'c', date: new Date() },
    },
  ]);
}

function blobFromBuffer(buf: Buffer, hang?: { abort: AbortController }): Blob {
  if (!hang) {
    return new Blob([buf]);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      hang.abort.signal.addEventListener('abort', () => {
        controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    },
  });
  return {
    size: buf.length * 8,
    stream: () => stream,
  } as Blob;
}

describe('downloadHfGgufToHubCache', () => {
  let customDir = '';

  beforeEach(() => {
    customDir = mkdtempSync(path.join(os.tmpdir(), 'clara-hf-hub-'));
    downloadFile.mockReset();
    pathsInfo.mockReset();
    mockPathInfo();
  });

  afterEach(() => {
    rmSync(customDir, { recursive: true, force: true });
  });

  it('writes Hub cache blobs and snapshot pointer', async () => {
    downloadFile.mockResolvedValue(blobFromBuffer(PAYLOAD));
    const abort = new AbortController();
    const result = await downloadHfGgufToHubCache({
      repoId: REPO_ID,
      fileName: FILE_NAME,
      customDir,
      abort,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.cacheHit).toBe(false);
    const layout = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME);
    expect(result.absolutePath).toBe(layout.pointerPath);
    expect(existsSync(layout.blobPath)).toBe(true);
    expect(existsSync(layout.pointerPath)).toBe(true);
    expect(existsSync(layout.incompletePath)).toBe(false);
    expect(readFileSync(layout.blobPath)).toEqual(PAYLOAD);
    expect(readFileSync(layout.pointerPath)).toEqual(PAYLOAD);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('skips downloadFile on snapshot cache hit', async () => {
    const layout = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME);
    mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
    writeFileSync(layout.pointerPath, PAYLOAD);
    const abort = new AbortController();
    const result = await downloadHfGgufToHubCache({
      repoId: REPO_ID,
      fileName: FILE_NAME,
      customDir,
      abort,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.cacheHit).toBe(true);
    expect(result.absolutePath).toBe(layout.pointerPath);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('deletes .incomplete on abort and does not leave a blob', async () => {
    const hangAbort = new AbortController();
    downloadFile.mockImplementation(async () => blobFromBuffer(PAYLOAD, { abort: hangAbort }));
    const abort = new AbortController();
    const pending = downloadHfGgufToHubCache({
      repoId: REPO_ID,
      fileName: FILE_NAME,
      customDir,
      abort,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    abort.abort();
    hangAbort.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.aborted).toBe(true);
    const layout = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME);
    expect(existsSync(layout.incompletePath)).toBe(false);
    expect(existsSync(layout.blobPath)).toBe(false);
    await expect(fs.stat(layout.pointerPath)).rejects.toThrow();
  });
});
