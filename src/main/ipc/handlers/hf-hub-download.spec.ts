import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
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

function mockPathInfo(etag = ETAG): void {
  pathsInfo.mockResolvedValue([
    {
      path: FILE_NAME,
      type: 'file',
      size: PAYLOAD.length,
      lfs: { oid: etag, size: PAYLOAD.length, pointerSize: 128 },
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

  it('keeps .incomplete on abort, to resume from, and does not leave a blob', async () => {
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
    expect(readFileSync(layout.incompletePath)).toEqual(PAYLOAD);
    expect(existsSync(layout.blobPath)).toBe(false);
    await expect(fs.stat(layout.pointerPath)).rejects.toThrow();
  });

  describe('with a partial file from an earlier attempt', () => {
    const KEPT = 7;

    /** A blob that records the offset it was sliced from, as the Hub's range-request blobs are. */
    function sliceRecordingBlob(buf: Buffer, slicedFrom: number[]): Blob {
      const blob = new Blob([new Uint8Array(buf)]);
      const slice = blob.slice.bind(blob);
      blob.slice = (start?: number, end?: number) => {
        slicedFrom.push(start ?? 0);
        return slice(start, end);
      };
      return blob;
    }

    function writePartial(etag: string, bytes: Buffer): string {
      const layout = hubCacheLayout(customDir, REPO_ID, etag, SNAPSHOT, FILE_NAME);
      mkdirSync(path.dirname(layout.incompletePath), { recursive: true });
      writeFileSync(layout.incompletePath, bytes);
      return layout.incompletePath;
    }

    it('fetches only the rest and reports progress from where it stopped', async () => {
      const incompletePath = writePartial(ETAG, PAYLOAD.subarray(0, KEPT));
      const slicedFrom: number[] = [];
      downloadFile.mockResolvedValue(sliceRecordingBlob(PAYLOAD, slicedFrom));
      const progress: number[] = [];
      const partialFiles: string[] = [];
      const result = await downloadHfGgufToHubCache({
        repoId: REPO_ID,
        fileName: FILE_NAME,
        customDir,
        abort: new AbortController(),
        progressMinIntervalMs: 0,
        onPartialFile: (file) => partialFiles.push(file),
        onProgress: (received) => progress.push(received),
      });
      expect(result).toMatchObject({ ok: true, receivedBytes: PAYLOAD.length, cacheHit: false });
      expect(slicedFrom).toEqual([KEPT]);
      expect(progress[0]).toBe(KEPT);
      expect(progress.at(-1)).toBe(PAYLOAD.length);
      expect(partialFiles).toEqual([incompletePath]);
      const layout = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME);
      expect(readFileSync(layout.blobPath)).toEqual(PAYLOAD);
      expect(existsSync(incompletePath)).toBe(false);
    });

    it('finishes without fetching when every byte is already there', async () => {
      writePartial(ETAG, PAYLOAD);
      const slicedFrom: number[] = [];
      downloadFile.mockResolvedValue(sliceRecordingBlob(PAYLOAD, slicedFrom));
      const result = await downloadHfGgufToHubCache({
        repoId: REPO_ID,
        fileName: FILE_NAME,
        customDir,
        abort: new AbortController(),
      });
      expect(result).toMatchObject({ ok: true, receivedBytes: PAYLOAD.length });
      expect(slicedFrom).toEqual([]);
    });

    it('starts over when the partial file is longer than the file', async () => {
      writePartial(ETAG, Buffer.concat([PAYLOAD, PAYLOAD]));
      const slicedFrom: number[] = [];
      downloadFile.mockResolvedValue(sliceRecordingBlob(PAYLOAD, slicedFrom));
      const result = await downloadHfGgufToHubCache({
        repoId: REPO_ID,
        fileName: FILE_NAME,
        customDir,
        abort: new AbortController(),
      });
      expect(result.ok).toBe(true);
      expect(slicedFrom).toEqual([]);
      const layout = hubCacheLayout(customDir, REPO_ID, ETAG, SNAPSHOT, FILE_NAME);
      expect(readFileSync(layout.blobPath)).toEqual(PAYLOAD);
    });

    it('rejects a resumed file whose kept bytes were damaged, and drops them', async () => {
      const sha = createHash('sha256').update(PAYLOAD).digest('hex');
      mockPathInfo(sha);
      const incompletePath = writePartial(sha, Buffer.alloc(KEPT, 0x58));
      downloadFile.mockResolvedValue(new Blob([new Uint8Array(PAYLOAD)]));
      const result = await downloadHfGgufToHubCache({
        repoId: REPO_ID,
        fileName: FILE_NAME,
        customDir,
        abort: new AbortController(),
      });
      expect(result).toMatchObject({ ok: false, aborted: false, error: expect.stringContaining('SHA-256') });
      expect(existsSync(incompletePath)).toBe(false);
      expect(existsSync(hubCacheLayout(customDir, REPO_ID, sha, SNAPSHOT, FILE_NAME).blobPath)).toBe(false);
    });
  });
});
