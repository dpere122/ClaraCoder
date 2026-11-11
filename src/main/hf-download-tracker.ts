/**
 * Hugging Face GGUF downloads, tracked in main so they outlive the window that started them.
 *
 * A download keeps running when Settings closes, and a window that opens later asks
 * {@link listHfDownloads} for what is running or stopped. A stopped download (paused, failed, or cut
 * off by the app quitting) keeps its partial file, and the list of those is saved to disk so they
 * can be resumed after a restart.
 */
import { BrowserWindow } from 'electron';
import { getRepoFolderName } from '@huggingface/hub';
import { promises as fs, readFileSync, writeFileSync, type WriteStream } from 'fs';
import path = require('path');
import type {
  HfDownloadId,
  HfDownloadProgressEvent,
  HfDownloadSnapshot,
  ModelManagerDownloadHfResult,
} from '../shared';
import { downloadHfGgufToHubCache } from './ipc/handlers/hf-hub-download';
import { getAppDataDir } from './paths';

const PARTIAL_SUFFIX = '.incomplete';

/** A running download. */
interface DownloadRun {
  abort: AbortController;
  writeStream: WriteStream | null;
  /** Set by whoever stops the run: ``pause`` keeps the partial file, ``cancel`` deletes it. */
  stop: 'pause' | 'cancel' | null;
  settled: Promise<void>;
}

interface TrackedDownload {
  downloadId: HfDownloadId;
  repoId: string;
  fileName: string;
  customDir: string;
  /** ``models--org--repo`` under {@link customDir}. */
  repoFolder: string;
  /** Empty until the Hub has said which blob the file is. */
  incompletePath: string;
  totalBytes: number | null;
  error?: string;
  receivedBytes: number;
  run: DownloadRun | null;
}

/** What is saved: enough to list a stopped download and find its partial file again. */
type StoredDownload = Pick<
  TrackedDownload,
  'downloadId' | 'repoId' | 'fileName' | 'customDir' | 'repoFolder' | 'incompletePath' | 'totalBytes' | 'error'
>;

let downloads: Map<HfDownloadId, TrackedDownload> | null = null;

export function hfDownloadId(repoId: string, fileName: string): HfDownloadId {
  return `${repoId}/${fileName}`;
}

function storePath(): string {
  return path.join(getAppDataDir(), 'hf-downloads.json');
}

function isStoredDownload(v: unknown): v is StoredDownload {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    ['downloadId', 'repoId', 'fileName', 'customDir', 'repoFolder', 'incompletePath'].every(
      (key) => typeof o[key] === 'string',
    ) &&
    (o['totalBytes'] === null || typeof o['totalBytes'] === 'number')
  );
}

function tracked(): Map<HfDownloadId, TrackedDownload> {
  if (downloads) {
    return downloads;
  }
  downloads = new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'));
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (isStoredDownload(item)) {
        downloads.set(item.downloadId, {
          downloadId: item.downloadId,
          repoId: item.repoId,
          fileName: item.fileName,
          customDir: item.customDir,
          repoFolder: item.repoFolder,
          incompletePath: item.incompletePath,
          totalBytes: item.totalBytes,
          ...(typeof item.error === 'string' ? { error: item.error } : {}),
          receivedBytes: 0,
          run: null,
        });
      }
    }
  } catch {
    /* no saved downloads */
  }
  return downloads;
}

function save(): void {
  const stored: StoredDownload[] = [...tracked().values()].map((d) => ({
    downloadId: d.downloadId,
    repoId: d.repoId,
    fileName: d.fileName,
    customDir: d.customDir,
    repoFolder: d.repoFolder,
    incompletePath: d.incompletePath,
    totalBytes: d.totalBytes,
    ...(d.error ? { error: d.error } : {}),
  }));
  try {
    writeFileSync(storePath(), JSON.stringify(stored), 'utf8');
  } catch {
    /* best-effort: an unsaved download is still resumable until the app quits */
  }
}

/** Every live window gets the event: the one that started the download may be gone. */
function broadcast(d: TrackedDownload, event: Omit<HfDownloadProgressEvent, 'downloadId' | 'repoId' | 'fileName'>): void {
  const payload: HfDownloadProgressEvent = {
    downloadId: d.downloadId,
    repoId: d.repoId,
    fileName: d.fileName,
    ...event,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('model-manager:hf-download-progress', payload);
    } catch {
      /* window gone */
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function fileSize(target: string): Promise<number> {
  if (!target) {
    return 0;
  }
  try {
    return (await fs.stat(target)).size;
  } catch {
    return 0;
  }
}

/** Deletes a partial file. The path comes from a saved file, so it must still look like one of ours. */
async function removePartial(d: Pick<TrackedDownload, 'incompletePath' | 'repoFolder'>): Promise<void> {
  if (!d.incompletePath.endsWith(PARTIAL_SUFFIX) || !isWithin(d.repoFolder, d.incompletePath)) {
    return;
  }
  // The write stream can still be closing on Windows, where an open file can't be deleted.
  await fs.rm(d.incompletePath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

/** Removes the directories a download created, as far as they are empty. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const child = path.join(dir, name);
    const st = await fs.lstat(child).catch(() => null);
    if (st?.isDirectory()) {
      await pruneEmptyDirs(child);
    }
  }
  // Fails on a directory that still holds something, which is the point.
  await fs.rmdir(dir).catch(() => {});
}

/** Deletes a cancelled download's partial file, and its repo folder when nothing else is in it. */
async function discard(d: Pick<TrackedDownload, 'incompletePath' | 'repoFolder'>): Promise<void> {
  await removePartial(d);
  await pruneEmptyDirs(d.repoFolder);
}

function stopRun(d: TrackedDownload, stop: 'pause' | 'cancel'): void {
  const run = d.run;
  if (!run) {
    return;
  }
  run.stop = stop;
  try {
    run.abort.abort();
  } catch {
    /* ignore */
  }
  try {
    run.writeStream?.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * Start a download, or continue the partial file of an earlier one. Resolves when the download ends,
 * however it ends; progress goes out as ``model-manager:hf-download-progress`` events.
 */
export async function startHfDownload(params: {
  repoId: string;
  fileName: string;
  customDir: string;
  token?: string;
}): Promise<ModelManagerDownloadHfResult> {
  const all = tracked();
  const downloadId = hfDownloadId(params.repoId, params.fileName);
  const customDir = path.resolve(params.customDir);
  const previous = all.get(downloadId);
  if (previous?.run) {
    return { ok: false, error: 'This quant is already downloading.' };
  }

  let release: () => void = () => {};
  const run: DownloadRun = {
    abort: new AbortController(),
    writeStream: null,
    stop: null,
    settled: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  // A partial file in another folder is not continued: the download follows the "Save to" folder.
  const moved = !!previous && previous.customDir !== customDir;
  const d: TrackedDownload = {
    downloadId,
    repoId: params.repoId,
    fileName: params.fileName,
    customDir,
    repoFolder: path.join(customDir, getRepoFolderName({ name: params.repoId, type: 'model' })),
    incompletePath: previous && !moved ? previous.incompletePath : '',
    totalBytes: previous && !moved ? previous.totalBytes : null,
    receivedBytes: 0,
    run,
  };
  all.set(downloadId, d);
  save();

  try {
    if (previous && moved) {
      await removePartial(previous);
    }
    d.receivedBytes = await fileSize(d.incompletePath);
    broadcast(d, { phase: 'queued', receivedBytes: d.receivedBytes, totalBytes: d.totalBytes });

    const result = await downloadHfGgufToHubCache({
      repoId: params.repoId,
      fileName: params.fileName,
      customDir,
      token: params.token,
      abort: run.abort,
      onWriteStream: (stream) => {
        run.writeStream = stream;
      },
      onPartialFile: (incompletePath) => {
        if (d.incompletePath === incompletePath) {
          return;
        }
        // The file changed on the Hub since the earlier attempt, so its bytes are no use now.
        void removePartial(d);
        d.incompletePath = incompletePath;
        save();
      },
      onProgress: (receivedBytes, totalBytes) => {
        d.receivedBytes = receivedBytes;
        if (d.totalBytes !== totalBytes) {
          d.totalBytes = totalBytes;
          save();
        }
        broadcast(d, { phase: 'progress', receivedBytes, totalBytes });
      },
    });

    if (result.ok) {
      all.delete(downloadId);
      save();
      broadcast(d, {
        phase: 'done',
        receivedBytes: result.receivedBytes,
        totalBytes: result.totalBytes ?? result.receivedBytes,
        absolutePath: result.absolutePath,
      });
      return { ok: true, absolutePath: result.absolutePath };
    }

    if (run.stop === 'cancel') {
      await discard(d);
    }
    d.receivedBytes = await fileSize(d.incompletePath);
    // With no bytes on disk there is nothing to resume, so the download is not kept.
    if (d.receivedBytes === 0) {
      all.delete(downloadId);
      save();
      if (result.aborted) {
        broadcast(d, { phase: 'cancelled', receivedBytes: 0, totalBytes: null });
        return { ok: false, error: 'Download cancelled.' };
      }
      broadcast(d, { phase: 'error', receivedBytes: 0, totalBytes: null, error: result.error });
      return { ok: false, error: result.error };
    }
    if (result.aborted) {
      delete d.error;
      save();
      broadcast(d, { phase: 'paused', receivedBytes: d.receivedBytes, totalBytes: d.totalBytes });
      return { ok: false, error: 'Download paused.' };
    }
    d.error = result.error;
    save();
    broadcast(d, {
      phase: 'error',
      receivedBytes: d.receivedBytes,
      totalBytes: d.totalBytes,
      error: result.error,
      resumable: true,
    });
    return { ok: false, error: result.error };
  } finally {
    d.run = null;
    release();
  }
}

/** Stop a running download and keep its partial file. */
export function pauseHfDownload(downloadId: HfDownloadId): { ok: true } | { ok: false; error: string } {
  const d = tracked().get(downloadId);
  if (!d?.run) {
    return { ok: false, error: 'No active download for that id.' };
  }
  stopRun(d, 'pause');
  return { ok: true };
}

/** Stop a download for good, running or not, and delete its partial file. */
export async function cancelHfDownload(downloadId: HfDownloadId): Promise<{ ok: true } | { ok: false; error: string }> {
  const all = tracked();
  const d = all.get(downloadId);
  if (!d) {
    return { ok: false, error: 'No download for that id.' };
  }
  if (d.run) {
    // The run deletes the file itself once its write stream has let go of it.
    stopRun(d, 'cancel');
    return { ok: true };
  }
  await discard(d);
  all.delete(downloadId);
  save();
  broadcast(d, { phase: 'cancelled', receivedBytes: 0, totalBytes: null });
  return { ok: true };
}

/**
 * Cancel every download that writes under ``dir``, and wait for the running ones to let go of their
 * files. For deleting a model folder, which would otherwise fail on an open file or leave a stopped
 * download listed with nothing behind it.
 */
export async function cancelHfDownloadsUnder(dir: string): Promise<void> {
  const under = [...tracked().values()].filter((d) => isWithin(dir, d.repoFolder));
  await Promise.all(
    under.map(async (d) => {
      const settled = d.run?.settled;
      await cancelHfDownload(d.downloadId);
      await settled;
    }),
  );
}

/** Running and stopped downloads, for a window that has just opened. */
export async function listHfDownloads(): Promise<HfDownloadSnapshot[]> {
  const all = tracked();
  const onDisk = new Map<HfDownloadId, number>();
  await Promise.all(
    [...all.values()]
      .filter((d) => !d.run)
      .map(async (d) => {
        onDisk.set(d.downloadId, await fileSize(d.incompletePath));
      }),
  );
  // No await from here on, so the reply cannot be older than a progress event sent before it.
  const out: HfDownloadSnapshot[] = [];
  let dropped = false;
  for (const d of [...all.values()]) {
    if (!d.run) {
      const size = onDisk.get(d.downloadId);
      if (size === 0) {
        // The partial file was deleted outside the app.
        all.delete(d.downloadId);
        dropped = true;
        continue;
      }
      d.receivedBytes = size ?? d.receivedBytes;
    }
    out.push({
      downloadId: d.downloadId,
      repoId: d.repoId,
      fileName: d.fileName,
      status: d.run ? 'downloading' : d.error ? 'error' : 'paused',
      receivedBytes: d.receivedBytes,
      totalBytes: d.totalBytes,
      ...(d.error && !d.run ? { error: d.error } : {}),
    });
  }
  if (dropped) {
    save();
  }
  return out;
}

/** Forget everything in memory, so a test can start from the saved file. */
export function resetHfDownloadTrackerForTests(): void {
  downloads = null;
}
