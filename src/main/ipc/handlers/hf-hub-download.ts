/**
 * Hugging Face GGUF download into Hub cache layout under a custom models dir.
 * Uses @huggingface/hub `downloadFile` (Xet) instead of a single resolve-URL fetch.
 * Does not use `downloadFileToCacheDir` so abort and byte progress stay first-class.
 */
import { downloadFile, getRepoFolderName, pathsInfo } from '@huggingface/hub';
import { createWriteStream, type WriteStream } from 'fs';
import { promises as fs } from 'fs';
import path = require('path');
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';

/** Minimum interval between progress callbacks (matches Model Manager IPC throttle). */
export const HF_HUB_DOWNLOAD_PROGRESS_MIN_INTERVAL_MS = 200;

const COMMIT_HASH_RE = /^[0-9a-f]{40}$/i;

export type HfHubDownloadParams = {
  repoId: string;
  fileName: string;
  customDir: string;
  token?: string;
  abort: AbortController;
  onWriteStream?: (stream: WriteStream | null) => void;
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  progressMinIntervalMs?: number;
};

export type HfHubDownloadResult =
  | {
      ok: true;
      absolutePath: string;
      receivedBytes: number;
      totalBytes: number | null;
      cacheHit: boolean;
    }
  | {
      ok: false;
      error: string;
      aborted: boolean;
      receivedBytes: number;
    };

export type HubCacheLayout = {
  repoFolder: string;
  blobPath: string;
  pointerPath: string;
  incompletePath: string;
};

/** Hub cache paths for a model repo file (blobs + snapshots), matching huggingface.js. */
export function hubCacheLayout(
  customDir: string,
  repoId: string,
  etag: string,
  snapshotId: string,
  fileName: string,
): HubCacheLayout {
  const repoFolder = path.join(path.resolve(customDir), getRepoFolderName({ name: repoId, type: 'model' }));
  const blobPath = path.join(repoFolder, 'blobs', etag);
  const pointerPath = path.join(repoFolder, 'snapshots', snapshotId, fileName);
  return { repoFolder, blobPath, pointerPath, incompletePath: `${blobPath}.incomplete` };
}

function isWithinRoot(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function pathExists(target: string, followSymlinks: boolean): Promise<boolean> {
  try {
    if (followSymlinks) {
      await fs.stat(target);
    } else {
      await fs.lstat(target);
    }
    return true;
  } catch {
    return false;
  }
}

/** Snapshot pointer → blob. Copy on Windows when symlink creation is denied. */
async function createSnapshotPointer(blobPath: string, pointerPath: string): Promise<void> {
  try {
    await fs.rm(pointerPath, { force: true });
  } catch {
    /* ignore */
  }
  try {
    await fs.symlink(path.relative(path.dirname(pointerPath), blobPath), pointerPath);
  } catch {
    await fs.copyFile(blobPath, pointerPath);
  }
}

function etagFromPathInfo(info: { lfs?: { oid: string }; xetHash?: string; oid?: string }): string {
  if (info.lfs?.oid) {
    return info.lfs.oid;
  }
  if (info.xetHash) {
    return info.xetHash;
  }
  if (info.oid) {
    return info.oid;
  }
  throw new Error('cannot determine etag for Hugging Face file');
}

/**
 * Download a GGUF into `{customDir}/models--org--repo/{blobs,snapshots}/…`.
 * Cache hit when the snapshot pointer already exists (or the blob exists and can be linked).
 */
export async function downloadHfGgufToHubCache(params: HfHubDownloadParams): Promise<HfHubDownloadResult> {
  const customDir = path.resolve(params.customDir);
  const repo = { type: 'model' as const, name: params.repoId };
  const accessToken = (params.token || '').trim() || undefined;
  const fetchWithAbort: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: params.abort.signal });

  let receivedBytes = 0;
  let incompletePath = '';

  try {
    const infos = await pathsInfo({
      repo,
      paths: [params.fileName],
      expand: true,
      revision: 'main',
      accessToken,
      fetch: fetchWithAbort,
    });
    if (!infos || infos.length !== 1) {
      return {
        ok: false,
        error: `cannot get path info for ${params.fileName}`,
        aborted: false,
        receivedBytes: 0,
      };
    }
    const info = infos[0];
    const etag = etagFromPathInfo(info);
    const snapshotId =
      info.lastCommit?.id && COMMIT_HASH_RE.test(info.lastCommit.id) ? info.lastCommit.id : etag;
    const layout = hubCacheLayout(customDir, params.repoId, etag, snapshotId, params.fileName);
    if (!isWithinRoot(customDir, layout.blobPath) || !isWithinRoot(customDir, layout.pointerPath)) {
      return {
        ok: false,
        error: 'Download path escaped the custom models directory.',
        aborted: false,
        receivedBytes: 0,
      };
    }
    incompletePath = layout.incompletePath;

    if (await pathExists(layout.pointerPath, true)) {
      const st = await fs.stat(layout.pointerPath);
      return {
        ok: true,
        absolutePath: layout.pointerPath,
        receivedBytes: st.size,
        totalBytes: st.size,
        cacheHit: true,
      };
    }

    await fs.mkdir(path.dirname(layout.blobPath), { recursive: true });
    await fs.mkdir(path.dirname(layout.pointerPath), { recursive: true });

    if (await pathExists(layout.blobPath, false)) {
      await createSnapshotPointer(layout.blobPath, layout.pointerPath);
      const st = await fs.stat(layout.pointerPath);
      return {
        ok: true,
        absolutePath: layout.pointerPath,
        receivedBytes: st.size,
        totalBytes: st.size,
        cacheHit: true,
      };
    }

    const blob = await downloadFile({
      repo,
      path: params.fileName,
      revision: snapshotId,
      accessToken,
      xet: true,
      fetch: fetchWithAbort,
    });
    if (!blob) {
      return {
        ok: false,
        error: `Hugging Face file not found: ${params.fileName}`,
        aborted: false,
        receivedBytes: 0,
      };
    }

    const totalBytes =
      typeof blob.size === 'number' && Number.isFinite(blob.size) && blob.size > 0 ? blob.size : null;
    const interval = params.progressMinIntervalMs ?? HF_HUB_DOWNLOAD_PROGRESS_MIN_INTERVAL_MS;
    let lastProgressMs = 0;

    const writeStream = createWriteStream(layout.incompletePath);
    params.onWriteStream?.(writeStream);

    const webStream = blob.stream() as NodeWebReadableStream<Uint8Array>;
    const nodeReadable = Readable.fromWeb(webStream);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        receivedBytes += chunk.byteLength;
        const now = Date.now();
        if (now - lastProgressMs >= interval) {
          lastProgressMs = now;
          params.onProgress?.(receivedBytes, totalBytes);
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(nodeReadable, counter, writeStream);
    } finally {
      params.onWriteStream?.(null);
    }

    await fs.rename(layout.incompletePath, layout.blobPath);
    await createSnapshotPointer(layout.blobPath, layout.pointerPath);

    return {
      ok: true,
      absolutePath: layout.pointerPath,
      receivedBytes,
      totalBytes: totalBytes ?? receivedBytes,
      cacheHit: false,
    };
  } catch (e) {
    const aborted = params.abort.signal.aborted;
    try {
      params.onWriteStream?.(null);
    } catch {
      /* ignore */
    }
    if (incompletePath) {
      try {
        await fs.unlink(incompletePath);
      } catch {
        /* ignore */
      }
    }
    if (aborted) {
      return { ok: false, error: 'Download cancelled.', aborted: true, receivedBytes };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      aborted: false,
      receivedBytes,
    };
  }
}
