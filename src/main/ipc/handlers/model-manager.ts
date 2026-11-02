import { BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs, type WriteStream } from 'fs';
import { homedir } from 'os';
import path = require('path');
import {
  hubSnapshotManagedPaths,
  type HfDownloadId,
  type HfDownloadProgressEvent,
  type HuggingFaceModelFile,
  type HuggingFaceModelSearchItem,
  type ModelManagerDownloadHfResult,
  type ModelManagerFileEntry,
  type ModelManagerHfDetailsResult,
  type ModelManagerHfFilesResult,
  type ModelManagerHfSearchResult,
  type ModelManagerListModelsResult,
  type ModelManagerMutationResult,
  type SecretStorageMode,
} from '../../../shared';
import { secretStorageMode } from '../../config/load-save';
import { mainState } from '../../state';
import { isBlobLikeFileName, looksLikeHubRepoLayout } from '../../utils/hub-repo-layout';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';
import { downloadHfGgufToHubCache } from './hf-hub-download';
import { fetchHfModelDetails } from './hf-model-details';

const MODEL_EXTENSIONS = new Set(['.gguf', '.ggml']);

/** Smallest size (bytes) before we peek the GGUF magic for extensionless / odd names. */
const MIN_BYTES_FOR_GGUF_HEADER_PROBE = 4096;

const SKIP_GGUF_HEADER_PROBE_EXT = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.mp4',
  '.mkv',
  '.avi',
  '.mp3',
  '.wav',
  '.json',
  '.md',
  '.txt',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.exe',
  '.dll',
  '.msi',
  '.iso',
  '.safetensors',
  '.pt',
  '.pth',
  '.pkl',
  '.onnx',
  '.npz',
  '.npy',
]);

/** Normalize user-entered paths: trim, strip quotes, expand ~ and (Windows) %ENV%. */
function normalizeModelManagerPath(p: string): string {
  let t = String(p || '').trim();
  if (!t) {
    return '';
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  if (!t) {
    return '';
  }
  if (process.platform === 'win32') {
    t = t.replace(/%([^%]+)%/g, (_, key: string) => process.env[key.toUpperCase()] ?? `%${key}%`);
  }
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    const rest = t === '~' ? '' : t.slice(2);
    t = path.join(homedir(), rest);
  } else if (t.startsWith('~') && process.platform !== 'win32') {
    t = path.join(homedir(), t.slice(1).replace(/^\//, ''));
  }
  return path.resolve(t);
}

function normalizeAbs(p: string): string {
  return normalizeModelManagerPath(p);
}

/** In-flight HF GGUF downloads keyed by {@link HfDownloadId}. */
interface InFlightDownload {
  downloadId: HfDownloadId;
  repoId: string;
  fileName: string;
  abort: AbortController;
  writeStream: WriteStream | null;
  receivedBytes: number;
  /** Timestamp (ms) of the last broadcast progress event, for throttling. */
  lastProgressBroadcastMs: number;
}

const inFlightDownloads = new Map<HfDownloadId, InFlightDownload>();

function makeDownloadId(repoId: string, fileName: string): HfDownloadId {
  return `${repoId}/${fileName}`;
}

/** Broadcast a download progress event to every live BrowserWindow (main + settings). */
function broadcastHfDownloadProgress(payload: HfDownloadProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('model-manager:hf-download-progress', payload);
    } catch {
      /* window gone */
    }
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const r = normalizeAbs(root);
  const t = normalizeAbs(target);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasModelExtension(filePath: string): boolean {
  return MODEL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function sanitizeModelFileName(name: string): string {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') {
    return '';
  }
  const sanitized = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return '';
  }
  return hasModelExtension(sanitized) ? sanitized : `${sanitized}.gguf`;
}

function suggestModelFileName(sourcePath: string): string {
  const base = path.basename(sourcePath);
  if (hasModelExtension(base)) {
    return sanitizeModelFileName(base);
  }
  const parts = path.normalize(sourcePath).split(path.sep);
  const modelDir = [...parts].reverse().find((part) => part.startsWith('models--'));
  if (modelDir) {
    const repoName = modelDir.replace(/^models--/, '').replace(/--/g, '-');
    const suffix = isBlobLikeFileName(base) ? base.replace(/^sha256[-_]/i, '').slice(0, 12) : base;
    return sanitizeModelFileName(`${repoName}-${suffix}`);
  }
  return sanitizeModelFileName(base);
}

async function fileStartsWithGgufMagic(filePath: string): Promise<boolean> {
  let h: import('fs/promises').FileHandle | undefined;
  try {
    h = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(4);
    const { bytesRead } = await h.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.equals(Buffer.from('GGUF', 'ascii'));
  } catch {
    return false;
  } finally {
    await h?.close();
  }
}

/** Accept `.gguf` / `.ggml`, or large blobs whose first bytes match the GGUF container magic. */
async function isRecognizedGgufFile(filePath: string, sizeBytes: number): Promise<boolean> {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 4) {
    return false;
  }
  if (hasModelExtension(filePath)) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_GGUF_HEADER_PROBE_EXT.has(ext)) {
    return false;
  }
  if (sizeBytes < MIN_BYTES_FOR_GGUF_HEADER_PROBE) {
    return false;
  }
  return await fileStartsWithGgufMagic(filePath);
}

async function pathExistsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Create ``dir`` (and parents) so Model Manager / downloads have a ready root. */
async function ensureModelsDirExists(dir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function childEntryKind(parent: string, baseName: string): Promise<'dir' | 'file' | 'missing'> {
  const full = path.join(parent, baseName);
  try {
    const st = await fs.stat(full);
    if (st.isDirectory()) {
      return 'dir';
    }
    return st.isFile() ? 'file' : 'missing';
  } catch {
    return 'missing';
  }
}

/** True for Hugging Face Hub repo dirs (`models--org--repo`) or trees with blobs/snapshots (refs optional). */
async function isHubRepoLayoutDir(dirPath: string): Promise<boolean> {
  const blobs = (await childEntryKind(dirPath, 'blobs')) === 'dir';
  const refs = (await childEntryKind(dirPath, 'refs')) === 'dir';
  const snapshots = (await childEntryKind(dirPath, 'snapshots')) === 'dir';
  return looksLikeHubRepoLayout(path.basename(dirPath), { blobs, refs, snapshots });
}

async function computeHubFolderStats(dirPath: string): Promise<{ sizeBytes: number; modifiedMs: number }> {
  let sizeBytes = 0;
  let modifiedMs = 0;
  const stack: string[] = [dirPath];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    const real = await fs.realpath(current).catch(() => current);
    const key = pathKey(real);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    let names: string[];
    try {
      names = await fs.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(current, name);
      let lst: import('fs').Stats;
      try {
        lst = await fs.lstat(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let st: import('fs').Stats;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        modifiedMs = Math.max(modifiedMs, st.mtimeMs);
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          sizeBytes += st.size;
        }
        continue;
      }
      modifiedMs = Math.max(modifiedMs, lst.mtimeMs);
      if (lst.isDirectory()) {
        stack.push(full);
      } else if (lst.isFile()) {
        sizeBytes += lst.size;
      }
    }
  }
  return { sizeBytes, modifiedMs };
}

function isHubBlobsDir(hubDir: string, dirPath: string): boolean {
  return pathKey(path.resolve(dirPath)) === pathKey(path.resolve(hubDir, 'blobs'));
}

function preferHubGgufPath(candidate: string, current: string): boolean {
  const cSnap = /(^|[/\\])snapshots[/\\]/i.test(candidate);
  const eSnap = /(^|[/\\])snapshots[/\\]/i.test(current);
  if (cSnap !== eSnap) {
    return cSnap;
  }
  return candidate.length < current.length;
}

/**
 * Language + mmproj GGUFs in a hub folder. Walks the whole tree (repo-root files
 * and ``snapshots/``) and skips ``blobs/`` hash names. Snapshot pointers win
 * when they resolve to the same bytes as a root copy.
 */
async function findHubModelGgufPaths(hubDir: string): Promise<string[]> {
  const byReal = new Map<string, string>();
  const stack: string[] = [hubDir];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    const real = await fs.realpath(current).catch(() => current);
    const key = pathKey(real);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    let names: string[];
    try {
      names = await fs.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(current, name);
      let st: import('fs').Stats;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (isHubBlobsDir(hubDir, full)) {
          continue;
        }
        stack.push(full);
      } else if (st.isFile() && hasModelExtension(full) && !isBlobLikeFileName(name)) {
        const realFile = await fs.realpath(full).catch(() => full);
        const realKey = pathKey(realFile);
        const existing = byReal.get(realKey);
        if (!existing || preferHubGgufPath(full, existing)) {
          byReal.set(realKey, full);
        }
      }
    }
  }
  return [...byReal.values()];
}

async function listHubRepoFoldersAtDepthOne(
  parentDir: string,
  source: 'custom' | 'cache',
  sourceRoot?: string,
): Promise<ModelManagerFileEntry[]> {
  const out: ModelManagerFileEntry[] = [];
  const parentAbs = normalizeModelManagerPath(parentDir);
  if (!parentAbs || !(await pathExistsDir(parentAbs))) {
    return out;
  }
  let names: string[];
  try {
    names = await fs.readdir(parentAbs);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(parentAbs, name);
    let lst: import('fs').Stats;
    try {
      lst = await fs.lstat(full);
    } catch {
      continue;
    }
    let isDir = lst.isDirectory();
    if (lst.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) {
      continue;
    }
    if (!(await isHubRepoLayoutDir(full))) {
      continue;
    }
    const { sizeBytes, modifiedMs } = await computeHubFolderStats(full);
    const snapshotGgufs = await findHubModelGgufPaths(full);
    out.push({
      fileName: name,
      absolutePath: full,
      sizeBytes,
      modifiedMs,
      source,
      entryKind: 'hubRepo',
      suggestedFileName: name,
      ...(sourceRoot ? { sourceRoot } : {}),
      ...hubSnapshotManagedPaths(snapshotGgufs),
    });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.fileName.localeCompare(b.fileName));
  return out;
}

async function walkModelFiles(
  root: string,
  source: 'custom' | 'cache',
  sourceRoot?: string,
  opts?: { skipHubRepoDirectories?: boolean },
): Promise<ModelManagerFileEntry[]> {
  const out: ModelManagerFileEntry[] = [];
  const rootAbs = normalizeModelManagerPath(root);
  if (!rootAbs) {
    return out;
  }
  const stack: string[] = [rootAbs];
  const visitedDirs = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    const realCurrent = await fs.realpath(current).catch(() => current);
    const currentKey = pathKey(realCurrent);
    if (visitedDirs.has(currentKey)) {
      continue;
    }
    visitedDirs.add(currentKey);
    let names: string[];
    try {
      names = await fs.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(current, name);
      let lst: import('fs').Stats;
      try {
        lst = await fs.lstat(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let followed: import('fs').Stats;
        try {
          followed = await fs.stat(full);
        } catch {
          continue;
        }
        if (followed.isDirectory()) {
          if (opts?.skipHubRepoDirectories && (await isHubRepoLayoutDir(full))) {
            continue;
          }
          stack.push(full);
          continue;
        }
        if (!followed.isFile()) {
          continue;
        }
        if (isBlobLikeFileName(name)) {
          continue;
        }
        if (!(await isRecognizedGgufFile(full, followed.size))) {
          continue;
        }
        out.push({
          fileName: name,
          absolutePath: full,
          sizeBytes: followed.size,
          modifiedMs: followed.mtimeMs,
          source,
          suggestedFileName: suggestModelFileName(full),
          ...(sourceRoot ? { sourceRoot } : {}),
        });
        continue;
      }
      if (lst.isDirectory()) {
        if (opts?.skipHubRepoDirectories && (await isHubRepoLayoutDir(full))) {
          continue;
        }
        stack.push(full);
        continue;
      }
      let fileSize = 0;
      let fileMtime = 0;
      if (lst.isFile()) {
        fileSize = lst.size;
        fileMtime = lst.mtimeMs;
      } else {
        try {
          const st = await fs.stat(full);
          if (!st.isFile()) {
            continue;
          }
          fileSize = st.size;
          fileMtime = st.mtimeMs;
        } catch {
          continue;
        }
      }
      if (isBlobLikeFileName(name)) {
        continue;
      }
      if (!(await isRecognizedGgufFile(full, fileSize))) {
        continue;
      }
      out.push({
        fileName: name,
        absolutePath: full,
        sizeBytes: fileSize,
        modifiedMs: fileMtime,
        source,
        suggestedFileName: suggestModelFileName(full),
        ...(sourceRoot ? { sourceRoot } : {}),
      });
    }
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.fileName.localeCompare(b.fileName));
  return out;
}

function sanitizeRename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
    return '';
  }
  return trimmed;
}

async function readSingleModel(pathname: string, source: 'custom' | 'cache', sourceRoot?: string): Promise<ModelManagerFileEntry> {
  const stat = await fs.stat(pathname);
  return {
    fileName: path.basename(pathname),
    absolutePath: pathname,
    sizeBytes: stat.size,
    modifiedMs: stat.mtimeMs,
    source,
    ...(sourceRoot ? { sourceRoot } : {}),
  };
}

/** Model Manager IPC: custom model folder CRUD and Hugging Face search. */
export function registerModelManagerIpc(): void {
  ipcMain.handle('model-manager:pick-custom-dir', async (event): Promise<string | null> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const mw = mainState.mainWindow;
    if (!mw) return null;
    const result = await dialog.showOpenDialog(mw, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('model-manager:secret-storage', (event): SecretStorageMode => {
    assertTrustedAppRenderer(event);
    return secretStorageMode();
  });

  ipcMain.handle(
    'model-manager:list-custom-models',
    async (event, payload: { customDir: string }): Promise<ModelManagerListModelsResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const customDir = normalizeModelManagerPath(String(payload?.customDir || '').trim());
        if (!customDir) {
          return { ok: false, error: 'Custom model directory is empty.' };
        }
        if (!(await pathExistsDir(customDir))) {
          const ensured = await ensureModelsDirExists(customDir);
          if (!ensured.ok) {
            return {
              ok: false,
              error: `Could not create models directory (${customDir}): ${ensured.error}`,
            };
          }
        }
        const hubFolders = await listHubRepoFoldersAtDepthOne(customDir, 'custom');
        const looseFiles = await walkModelFiles(customDir, 'custom', undefined, { skipHubRepoDirectories: true });
        const models = [...hubFolders, ...looseFiles].sort(
          (a, b) => b.modifiedMs - a.modifiedMs || a.fileName.localeCompare(b.fileName),
        );
        return { ok: true, models, resolvedDir: customDir };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:rename-model',
    async (
      event,
      payload: { customDir: string; modelPath: string; newFileName: string },
    ): Promise<ModelManagerMutationResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const customDir = normalizeModelManagerPath(String(payload?.customDir || '').trim());
        const modelPath = normalizeModelManagerPath(String(payload?.modelPath || '').trim());
        const newFileName = sanitizeRename(String(payload?.newFileName || ''));
        if (!customDir || !modelPath || !newFileName) {
          return { ok: false, error: 'Missing custom directory, model path, or new filename.' };
        }
        if (!isWithinRoot(customDir, modelPath)) {
          return { ok: false, error: 'Model path must be inside the custom directory.' };
        }
        const st = await fs.stat(modelPath);
        if (st.isDirectory()) {
          const targetPath = path.join(path.dirname(modelPath), newFileName);
          await fs.rename(modelPath, targetPath);
          const agg = await computeHubFolderStats(targetPath);
          const model: ModelManagerFileEntry = {
            fileName: newFileName,
            absolutePath: targetPath,
            sizeBytes: agg.sizeBytes,
            modifiedMs: agg.modifiedMs,
            source: 'custom',
            entryKind: 'hubRepo',
            suggestedFileName: newFileName,
          };
          return { ok: true, model };
        }
        // Auto-append the original file's extension when the user submits a bare
        // name (the renderer pre-fills the prompt with the extension trimmed for
        // ergonomics). Preserve the original type — a .ggml rename keeps .ggml,
        // a .gguf rename keeps .gguf. If the user typed an explicit model
        // extension, honor it as-is.
        const originalExt = path.extname(modelPath);
        let finalFileName: string;
        if (hasModelExtension(newFileName)) {
          finalFileName = newFileName;
        } else if (hasModelExtension(originalExt)) {
          finalFileName = `${newFileName}${originalExt}`;
        } else {
          finalFileName = `${newFileName}.gguf`;
        }
        const targetPath = path.join(path.dirname(modelPath), finalFileName);
        await fs.rename(modelPath, targetPath);
        const model = await readSingleModel(targetPath, 'custom');
        return { ok: true, model };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:delete-model',
    async (
      event,
      payload: { customDir: string; modelPath: string },
    ): Promise<ModelManagerMutationResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const customDir = normalizeModelManagerPath(String(payload?.customDir || '').trim());
        const modelPath = normalizeModelManagerPath(String(payload?.modelPath || '').trim());
        if (!customDir || !modelPath) {
          return { ok: false, error: 'Missing custom directory or model path.' };
        }
        if (!isWithinRoot(customDir, modelPath)) {
          return { ok: false, error: 'Model path must be inside the custom directory.' };
        }
        const st = await fs.lstat(modelPath);
        if (st.isDirectory()) {
          await fs.rm(modelPath, { recursive: true, force: true });
        } else {
          await fs.unlink(modelPath);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:search-hf',
    async (
      event,
      payload: { query: string; token?: string; limit?: number; skip?: number; fileType?: string },
    ): Promise<ModelManagerHfSearchResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const query = String(payload?.query || '').trim();
        const limit = Math.min(50, Math.max(1, Number(payload?.limit ?? 10) || 10));
        const skip = Math.max(0, Math.floor(Number(payload?.skip ?? 0) || 0));
        const fileType = String(payload?.fileType || '').trim().toLowerCase();
        if (!query) {
          return { ok: true, models: [], hasMore: false, skip, limit, totalCount: 0, totalPages: 0 };
        }
        const token = String(payload?.token || '').trim();
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'ClaraCoder-ModelManager',
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        let totalCount: number | null = null;
        let totalPages: number | null = null;
        // Website search endpoint exposes numTotalItems when withCount=true.
        // Only needed on the first page; later pages reuse the renderer-held total.
        if (skip === 0) {
          try {
            const countParams = new URLSearchParams({
              search: query,
              sort: 'downloads',
              p: '0',
              withCount: 'true',
            });
            if (fileType) {
              countParams.set('filter', fileType);
            }
            const countResponse = await fetch(`https://huggingface.co/models-json?${countParams}`, {
              headers,
            });
            if (countResponse.ok) {
              const countJson = (await countResponse.json()) as { numTotalItems?: unknown };
              const n = Number(countJson?.numTotalItems);
              if (Number.isFinite(n) && n >= 0) {
                totalCount = Math.floor(n);
                totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);
              }
            }
          } catch {
            // Fall back to link/hasMore pagination below.
          }
        }

        const params = new URLSearchParams({
          search: query,
          limit: String(limit),
          skip: String(skip),
          sort: 'downloads',
          direction: '-1',
        });
        if (fileType) {
          params.set('filter', fileType);
        }
        const url = `https://huggingface.co/api/models?${params.toString()}`;
        const response = await fetch(url, { headers });
        if (!response.ok) {
          return { ok: false, error: `Hugging Face search failed (${response.status}).` };
        }
        const raw = (await response.json()) as Array<Record<string, unknown>>;
        const models: HuggingFaceModelSearchItem[] = raw
          .map((m) => ({
            id: String(m['id'] ?? ''),
            likes: Number(m['likes'] ?? 0) || 0,
            downloads: Number(m['downloads'] ?? 0) || 0,
            lastModified: String(m['lastModified'] ?? ''),
            private: Boolean(m['private']),
            gated: Boolean(m['gated']),
            tags: Array.isArray(m['tags']) ? m['tags'].map((t) => String(t)) : [],
          }))
          .filter((m) => !!m.id);
        const linkHeader = response.headers.get('link') ?? response.headers.get('Link') ?? '';
        const hasNextLink = /rel=["']?next["']?/i.test(linkHeader);
        const pageIndex = Math.floor(skip / limit);
        const hasMore =
          totalPages != null ? pageIndex + 1 < totalPages : hasNextLink || models.length >= limit;
        return { ok: true, models, hasMore, skip, limit, totalCount, totalPages };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:hf-model-details',
    async (event, payload: { id: string; token?: string }): Promise<ModelManagerHfDetailsResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const details = await fetchHfModelDetails(String(payload?.id || ''), String(payload?.token || ''));
        return { ok: true, details };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:list-hf-files',
    async (
      event,
      payload: { id: string; token?: string },
    ): Promise<ModelManagerHfFilesResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      try {
        const repoId = String(payload?.id || '').trim();
        if (!repoId || !/^[^/\s]+\/[^/\s]+$/.test(repoId)) {
          return { ok: false, error: 'Invalid Hugging Face repo id.' };
        }
        const token = String(payload?.token || '').trim();
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'ClaraCoder-ModelManager',
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        // 1. Repo metadata → default revision SHA + sibling file list.
        // Encode org/repo segments separately so the path slash is preserved
        // (encodeURIComponent would turn "/" into "%2F", which HF rejects with 400).
        const [orgPart, repoPart] = repoId.split('/');
        const repoPath = `${encodeURIComponent(orgPart)}/${encodeURIComponent(repoPart)}`;
        const metaUrl = `https://huggingface.co/api/models/${repoPath}`;
        const metaRes = await fetch(metaUrl, { headers });
        if (!metaRes.ok) {
          return {
            ok: false,
            error: `Hugging Face repo lookup failed (${metaRes.status}).`,
          };
        }
        const meta = (await metaRes.json()) as {
          sha?: unknown;
          siblings?: Array<{ rfilename?: unknown }>;
        };
        const sha =
          typeof meta.sha === 'string' && meta.sha.trim() ? meta.sha.trim() : 'main';
        const siblings = Array.isArray(meta.siblings) ? meta.siblings : [];
        const ggufFiles = siblings
          .map((s) => String(s?.rfilename ?? ''))
          .filter((name) => name.toLowerCase().endsWith('.gguf') && !!name.trim());

        if (ggufFiles.length === 0) {
          return { ok: true, files: [] };
        }

        // 2. Tree listing (recursive) for file sizes. Best-effort; falls back to null sizes.
        const sizeByName = new Map<string, number>();
        try {
          const treeUrl = `https://huggingface.co/api/models/${repoPath}/tree/${encodeURIComponent(
            sha,
          )}?recursive=true`;
          const treeRes = await fetch(treeUrl, { headers });
          if (treeRes.ok) {
            const tree = (await treeRes.json()) as Array<{
              path?: unknown;
              size?: unknown;
              type?: unknown;
            }>;
            if (Array.isArray(tree)) {
              for (const entry of tree) {
                if (entry.type && String(entry.type) !== 'file') {
                  continue;
                }
                const p = String(entry.path ?? '').trim();
                const sz = entry.size;
                if (p && typeof sz === 'number' && Number.isFinite(sz) && sz >= 0) {
                  sizeByName.set(p, Math.floor(sz));
                }
              }
            }
          }
        } catch {
          // Sizes are optional; ignore tree failures.
        }

        const files: HuggingFaceModelFile[] = ggufFiles
          .map((fileName) => {
            const base = fileName.slice(0, -5); // strip ".gguf"
            return {
              fileName,
              quant: parseGgufQuant(base),
              sizeBytes: sizeByName.get(fileName) ?? null,
            };
          })
          .sort((a, b) => quantRank(a.quant) - quantRank(b.quant) || a.fileName.localeCompare(b.fileName));

        return { ok: true, files };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:download-hf-file',
    async (
      event,
      payload: { repoId: string; fileName: string; customDir: string; token?: string },
    ): Promise<ModelManagerDownloadHfResult> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      const repoId = String(payload?.repoId || '').trim();
      const fileName = String(payload?.fileName || '').trim();
      const customDirRaw = String(payload?.customDir || '').trim();
      if (!repoId || !/^[^/\s]+\/[^/\s]+$/.test(repoId)) {
        return { ok: false, error: 'Invalid Hugging Face repo id.' };
      }
      if (!fileName || !fileName.toLowerCase().endsWith('.gguf')) {
        return { ok: false, error: 'Invalid GGUF file name.' };
      }
      const customDir = normalizeModelManagerPath(customDirRaw);
      if (!customDir) {
        return { ok: false, error: 'No custom models directory configured.' };
      }
      const downloadId = makeDownloadId(repoId, fileName);
      if (inFlightDownloads.has(downloadId)) {
        return { ok: false, error: 'This quant is already downloading.' };
      }

      const token = String(payload?.token || '').trim();
      {
        const ensured = await ensureModelsDirExists(customDir);
        if (!ensured.ok) {
          return { ok: false, error: `Could not create models directory: ${ensured.error}` };
        }
      }

      const abort = new AbortController();
      const entry: InFlightDownload = {
        downloadId,
        repoId,
        fileName,
        abort,
        writeStream: null,
        receivedBytes: 0,
        lastProgressBroadcastMs: 0,
      };
      inFlightDownloads.set(downloadId, entry);

      broadcastHfDownloadProgress({
        downloadId,
        repoId,
        fileName,
        phase: 'queued',
        receivedBytes: 0,
        totalBytes: null,
      });

      try {
        const result = await downloadHfGgufToHubCache({
          repoId,
          fileName,
          customDir,
          token,
          abort,
          onWriteStream: (stream) => {
            entry.writeStream = stream;
          },
          onProgress: (receivedBytes, totalBytes) => {
            entry.receivedBytes = receivedBytes;
            entry.lastProgressBroadcastMs = Date.now();
            broadcastHfDownloadProgress({
              downloadId,
              repoId,
              fileName,
              phase: 'progress',
              receivedBytes,
              totalBytes,
            });
          },
        });
        entry.receivedBytes = result.receivedBytes;
        if (!result.ok) {
          broadcastHfDownloadProgress({
            downloadId,
            repoId,
            fileName,
            phase: result.aborted ? 'cancelled' : 'error',
            receivedBytes: result.receivedBytes,
            totalBytes: null,
            ...(result.aborted ? {} : { error: result.error }),
          });
          return { ok: false, error: result.error };
        }
        broadcastHfDownloadProgress({
          downloadId,
          repoId,
          fileName,
          phase: 'done',
          receivedBytes: result.receivedBytes,
          totalBytes: result.totalBytes ?? result.receivedBytes,
          absolutePath: result.absolutePath,
        });
        return { ok: true, absolutePath: result.absolutePath };
      } finally {
        inFlightDownloads.delete(downloadId);
      }
    },
  );

  ipcMain.handle(
    'model-manager:cancel-hf-download',
    async (event, payload: { downloadId: HfDownloadId }): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false as const, error: 'Untrusted IPC sender' };
      }
      const id = String(payload?.downloadId || '').trim();
      const entry = inFlightDownloads.get(id);
      if (!entry) {
        return { ok: false, error: 'No active download for that id.' };
      }
      try {
        entry.abort.abort();
        } catch {
          /* ignore */
        }
        try {
          entry.writeStream?.destroy();
        } catch {
          /* ignore */
        }
      return { ok: true };
    },
  );
}

/**
 * Parse a GGUF quantization label from a file basename (without extension).
 * Matches llama.cpp quant tokens such as Q8_0, Q6_K, Q5_K_M, Q4_K_S, Q4_0,
 * Q3_K_L, Q2_K, IQ4_XS, IQ3_M, IQ2_XXS, IQ1_S, F16, BF16, F32.
 */
function parseGgufQuant(basename: string): string {
  const m =
    /\b((?:IQ|Q)?\d[0-9]*K?_[A-Z0-9]+|[IQBF]\d{1,2}|BF16|F16|F32)\b/i.exec(basename);
  if (!m) {
    return '';
  }
  return m[1].toUpperCase();
}

/**
 * Sort order so higher-precision quants list first (Q8 → Q2 → IQ → F), with
 * unknown quants last. Lower rank value = listed earlier.
 */
function quantRank(quant: string): number {
  const q = (quant || '').toUpperCase();
  if (!q) {
    return 999;
  }
  if (q === 'F32') return 0;
  if (q === 'BF16') return 1;
  if (q === 'F16') return 2;
  if (q === 'Q8_0') return 10;
  if (q === 'Q6_K') return 11;
  if (q === 'Q5_K_M') return 12;
  if (q === 'Q5_K_S') return 13;
  if (q === 'Q5_0' || q === 'Q5_1') return 14;
  if (q === 'Q4_K_M') return 15;
  if (q === 'Q4_K_S') return 16;
  if (q === 'Q4_0' || q === 'Q4_1') return 17;
  if (q === 'Q3_K_L') return 18;
  if (q === 'Q3_K_M') return 19;
  if (q === 'Q3_K_S') return 20;
  if (q === 'Q2_K') return 21;
  if (q.startsWith('IQ')) return 30;
  return 100;
}
