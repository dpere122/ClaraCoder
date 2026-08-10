import type { WebContents } from 'electron';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { homedir } from 'os';
import path = require('path');
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type {
  HuggingFaceModelFile,
  HuggingFaceModelSearchItem,
  ModelManagerCacheLocation,
  ModelManagerDetectCachesResult,
  ModelManagerEntryKind,
  ModelManagerFileEntry,
  ModelManagerHfFilesResult,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMigrateProgressPhase,
  ModelManagerMigrateProgressPayload,
  ModelManagerMutationResult,
} from '../../../shared';
import { mainState } from '../../state';

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

function isHubSnapshotPath(filePath: string): boolean {
  return path.normalize(filePath).split(path.sep).includes('snapshots');
}

function isBlobLikeFileName(fileName: string): boolean {
  const ext = path.extname(fileName);
  if (ext) {
    return false;
  }
  return /^[a-f0-9]{32,}$/i.test(fileName) || /^sha256[-_][a-f0-9]{32,}$/i.test(fileName);
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

async function uniqueModelTargetPath(customDir: string, suggestedName: string): Promise<string> {
  const safeName = sanitizeModelFileName(suggestedName) || 'model.gguf';
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = path.join(customDir, safeName);
  for (let i = 1; ; i += 1) {
    try {
      await fs.stat(candidate);
      candidate = path.join(customDir, `${stem} (${i})${ext || '.gguf'}`);
    } catch {
      return candidate;
    }
  }
}

function preferCacheEntry(candidate: ModelManagerFileEntry, existing: ModelManagerFileEntry): boolean {
  const candidateSnapshot = isHubSnapshotPath(candidate.absolutePath);
  const existingSnapshot = isHubSnapshotPath(existing.absolutePath);
  if (candidateSnapshot !== existingSnapshot) {
    return candidateSnapshot;
  }
  const candidateNamed = hasModelExtension(candidate.fileName) || !isBlobLikeFileName(candidate.fileName);
  const existingNamed = hasModelExtension(existing.fileName) || !isBlobLikeFileName(existing.fileName);
  if (candidateNamed !== existingNamed) {
    return candidateNamed;
  }
  return candidate.modifiedMs > existing.modifiedMs;
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

/** True for Hugging Face Hub repo dirs (`models--org--repo`) or trees with blobs/refs/snapshots. */
async function isHubRepoLayoutDir(dirPath: string): Promise<boolean> {
  const base = path.basename(dirPath);
  if (base.toLowerCase().startsWith('models--')) {
    return true;
  }
  const blobs = (await childEntryKind(dirPath, 'blobs')) === 'dir';
  const refs = (await childEntryKind(dirPath, 'refs')) === 'dir';
  const snapshots = (await childEntryKind(dirPath, 'snapshots')) === 'dir';
  return blobs && refs && snapshots;
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
    out.push({
      fileName: name,
      absolutePath: full,
      sizeBytes,
      modifiedMs,
      source,
      entryKind: 'hubRepo',
      suggestedFileName: name,
      ...(sourceRoot ? { sourceRoot } : {}),
    });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.fileName.localeCompare(b.fileName));
  return out;
}

function sanitizeHubFolderBaseName(name: string): string {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') {
    return '';
  }
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

async function uniqueHubFolderTargetPath(customDir: string, folderName: string): Promise<string> {
  const safe = sanitizeHubFolderBaseName(folderName) || 'hub-model';
  let candidate = path.join(customDir, safe);
  for (let i = 1; ; i += 1) {
    try {
      await fs.stat(candidate);
      candidate = path.join(customDir, `${safe} (${i})`);
    } catch {
      return candidate;
    }
  }
}

function preferHubDupEntry(a: ModelManagerFileEntry, b: ModelManagerFileEntry): ModelManagerFileEntry {
  return a.modifiedMs >= b.modifiedMs ? a : b;
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

function detectModelCacheLocations(): ModelManagerCacheLocation[] {
  const home = process.env.USERPROFILE || homedir();
  const hfHome = process.env.HF_HOME?.trim() || '';
  const localAppData = process.env.LOCALAPPDATA?.trim() || '';
  const candidates: Array<{ label: string; path: string }> = [
    { label: 'LLAMA_CACHE', path: process.env.LLAMA_CACHE?.trim() || '' },
    { label: 'HUGGINGFACE_HUB_CACHE', path: process.env.HUGGINGFACE_HUB_CACHE?.trim() || '' },
    { label: 'TRANSFORMERS_CACHE', path: process.env.TRANSFORMERS_CACHE?.trim() || '' },
    { label: 'HF_HOME/hub', path: hfHome ? path.join(hfHome, 'hub') : '' },
    { label: 'HF default cache', path: path.join(home, '.cache', 'huggingface', 'hub') },
    { label: 'LocalAppData Hugging Face cache', path: localAppData ? path.join(localAppData, 'huggingface', 'hub') : '' },
    { label: 'llama.cpp cache', path: path.join(home, '.cache', 'llama.cpp') },
    { label: 'llama.cpp models', path: path.join(home, '.cache', 'llama.cpp', 'models') },
    { label: 'LocalAppData llama.cpp models', path: localAppData ? path.join(localAppData, 'llama.cpp', 'models') : '' },
  ];
  const seen = new Set<string>();
  const out: ModelManagerCacheLocation[] = [];
  for (const c of candidates) {
    const raw = c.path.trim();
    if (!raw) {
      continue;
    }
    const abs = normalizeModelManagerPath(raw);
    const key = pathKey(abs);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ label: c.label, path: abs, exists: false });
  }
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

async function resolveMigrationSource(
  sourcePath: string,
): Promise<
  | { ok: true; readPath: string; removePath: string; stat: import('fs').Stats; isSymlink: boolean }
  | { ok: false; error: string }
> {
  let lst: import('fs').Stats;
  try {
    lst = await fs.lstat(sourcePath);
  } catch {
    return {
      ok: false,
      error: 'Source path does not exist. Refresh cache detection and ensure the Hugging Face download finished.',
    };
  }

  const resolvedPath = await fs.realpath(sourcePath).catch(() => '');
  const readPath = resolvedPath || sourcePath;
  let stat: import('fs').Stats;
  try {
    stat = await fs.stat(readPath);
  } catch {
    return {
      ok: false,
      error: 'Could not resolve the cache file. Refresh cache detection or select a completed snapshots/... model file.',
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      error: 'Source path did not resolve to a regular model file. Refresh cache detection or ensure the Hugging Face download finished.',
    };
  }

  return { ok: true, readPath, removePath: sourcePath, stat, isSymlink: lst.isSymbolicLink() };
}

function createMigrateProgressReporter(sender: WebContents) {
  let lastPct = -1;
  let lastPhase: ModelManagerMigrateProgressPhase | '' = '';
  let lastSentAt = 0;
  const MIN_INTERVAL_MS = 120;

  return (
    bytesDone: number,
    bytesTotal: number,
    phase: ModelManagerMigrateProgressPhase,
    opts?: { force?: boolean },
  ): void => {
    if (sender.isDestroyed()) {
      return;
    }
    const safeTotal = Math.max(1, bytesTotal);
    const cappedDone = Math.min(bytesDone, bytesTotal);
    const pct = Math.min(100, Math.floor((cappedDone / safeTotal) * 100));
    const force = opts?.force === true || phase === 'done';
    const now = Date.now();
    if (!force && phase === lastPhase && pct === lastPct && now - lastSentAt < MIN_INTERVAL_MS) {
      return;
    }
    lastPhase = phase;
    lastPct = pct;
    lastSentAt = now;
    const payload: ModelManagerMigrateProgressPayload = {
      bytesDone: cappedDone,
      bytesTotal: safeTotal,
      phase,
    };
    sender.send('model-manager:migrate-progress', payload);
  };
}

async function collectMigrationFilesUnderRoot(rootAbs: string): Promise<Array<{ src: string; rel: string; size: number }>> {
  const rootResolved = path.normalize(await fs.realpath(rootAbs).catch(() => rootAbs));
  const files: Array<{ src: string; rel: string; size: number }> = [];
  const stack: string[] = [rootResolved];
  const visitedDirReal = new Set<string>();

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const dirReal = await fs.realpath(dir).catch(() => dir);
    const dirKey = pathKey(dirReal);
    if (visitedDirReal.has(dirKey)) {
      continue;
    }
    visitedDirReal.add(dirKey);

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      const full = path.join(dir, name);
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
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          const srcReal = await fs.realpath(full).catch(() => full);
          let rel = path.relative(rootResolved, srcReal);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            rel = path.relative(rootResolved, full);
          }
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            continue;
          }
          files.push({ src: full, rel, size: st.size });
        }
      } else if (lst.isDirectory()) {
        stack.push(full);
      } else if (lst.isFile()) {
        const rel = path.relative(rootResolved, full);
        files.push({ src: full, rel, size: lst.size });
      }
    }
  }

  return files;
}

async function copyFileWithProgressBytes(src: string, dest: string, onDelta: (n: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let size = 0;
  try {
    size = (await fs.stat(src)).size;
  } catch {
    /* missing */
  }
  if (size === 0) {
    await fs.copyFile(src, dest);
    return;
  }
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onDelta(chunk.length);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), counter, createWriteStream(dest));
}

async function copyDirectoryTreeWithProgress(
  sourcePath: string,
  destRoot: string,
  report: ReturnType<typeof createMigrateProgressReporter>,
): Promise<number> {
  const rootResolved = path.normalize(await fs.realpath(sourcePath).catch(() => sourcePath));
  report(0, 1, 'scanning', { force: true });
  const files = await collectMigrationFilesUnderRoot(rootResolved);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const safeTotal = Math.max(1, totalBytes);
  report(0, safeTotal, 'copying', { force: true });

  let done = 0;
  for (const f of files) {
    const destPath = path.join(destRoot, f.rel);
    const chunkStart = done;
    await copyFileWithProgressBytes(f.src, destPath, (d) => {
      done += d;
      report(Math.min(done, safeTotal), safeTotal, 'copying');
    });
    done = chunkStart + f.size;
    report(Math.min(done, safeTotal), safeTotal, 'copying');
  }
  report(safeTotal, safeTotal, 'copying', { force: true });
  return safeTotal;
}

/** Model Manager IPC: custom model folder CRUD, cache detection/migration, and Hugging Face search. */
export function registerModelManagerIpc(): void {
  ipcMain.handle(
    'model-manager:choose-migrate-mode',
    async (_event, payload: { title?: string; detail?: string }): Promise<'copy' | 'move' | null> => {
      const title = String(payload?.title ?? 'Migrate model').trim() || 'Migrate model';
      const detail =
        String(payload?.detail ?? '').trim() ||
        'Copy keeps the original in the cache. Move removes it from the source location after it has been copied.';
      const win = BrowserWindow.getFocusedWindow() ?? mainState.settingsWindow ?? mainState.mainWindow;
      if (!win) {
        return null;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Copy', 'Move', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Migrate model',
        message: title,
        detail,
      });
      if (response === 2) {
        return null;
      }
      return response === 0 ? 'copy' : 'move';
    },
  );

  ipcMain.handle('model-manager:pick-custom-dir', async (): Promise<string | null> => {
    const mw = mainState.mainWindow;
    if (!mw) return null;
    const result = await dialog.showOpenDialog(mw, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'model-manager:list-custom-models',
    async (_event, payload: { customDir: string }): Promise<ModelManagerListModelsResult> => {
      try {
        const customDir = normalizeModelManagerPath(String(payload?.customDir || '').trim());
        if (!customDir) {
          return { ok: false, error: 'Custom model directory is empty.' };
        }
        if (!(await pathExistsDir(customDir))) {
          return { ok: true, models: [], resolvedDir: customDir, directoryMissing: true };
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

  ipcMain.handle('model-manager:detect-caches', async (): Promise<ModelManagerDetectCachesResult> => {
    try {
      const caches = detectModelCacheLocations();
      for (const c of caches) {
        c.exists = await pathExistsDir(c.path);
      }
      return { ok: true, caches };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(
    'model-manager:list-cache-candidates',
    async (_event, payload: { cachePaths: string[] }): Promise<ModelManagerListModelsResult> => {
      try {
        const input = Array.isArray(payload?.cachePaths) ? payload.cachePaths : [];
        const roots = input.map((p) => normalizeModelManagerPath(String(p || '').trim())).filter(Boolean);
        const models: ModelManagerFileEntry[] = [];
        for (const root of roots) {
          if (!(await pathExistsDir(root))) {
            continue;
          }
          const hubFolders = await listHubRepoFoldersAtDepthOne(root, 'cache', root);
          if (hubFolders.length > 0) {
            models.push(...hubFolders);
          } else {
            const found = await walkModelFiles(root, 'cache', root);
            models.push(...found);
          }
        }
        const dedup = new Map<string, ModelManagerFileEntry>();
        for (const model of models) {
          const realPath = await fs.realpath(model.absolutePath).catch(() => model.absolutePath);
          const key = pathKey(realPath);
          const existing = dedup.get(key);
          if (!existing) {
            dedup.set(key, model);
            continue;
          }
          const bothHub = model.entryKind === 'hubRepo' && existing.entryKind === 'hubRepo';
          if (bothHub) {
            dedup.set(key, preferHubDupEntry(model, existing));
          } else if (model.entryKind === 'hubRepo') {
            dedup.set(key, model);
          } else if (existing.entryKind === 'hubRepo') {
            /* keep hub folder entry */
          } else if (preferCacheEntry(model, existing)) {
            dedup.set(key, model);
          }
        }
        const unique = [...dedup.values()].sort((a, b) => b.modifiedMs - a.modifiedMs);
        return { ok: true, models: unique };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:migrate-model',
    async (
      _event,
      payload: {
        sourcePath: string;
        customDir: string;
        mode: 'copy' | 'move';
        suggestedFileName?: string;
        entryKind?: ModelManagerEntryKind;
      },
    ): Promise<ModelManagerMutationResult> => {
      try {
        const sender = _event.sender;
        const report = createMigrateProgressReporter(sender);
        const sourcePath = normalizeModelManagerPath(String(payload?.sourcePath || '').trim());
        const customDir = normalizeModelManagerPath(String(payload?.customDir || '').trim());
        const mode = payload?.mode === 'move' ? 'move' : 'copy';
        if (!sourcePath || !customDir) {
          return { ok: false, error: 'Missing source path or custom directory.' };
        }

        let srcLst: import('fs').Stats;
        try {
          srcLst = await fs.lstat(sourcePath);
        } catch {
          return { ok: false, error: 'Source path does not exist. Refresh cache detection and try again.' };
        }

        let effectiveStat: import('fs').Stats = srcLst;
        if (srcLst.isSymbolicLink()) {
          try {
            effectiveStat = await fs.stat(sourcePath);
          } catch {
            return { ok: false, error: 'Broken symlink or unreadable source path.' };
          }
        }

        const hubRequested = payload?.entryKind === 'hubRepo';
        if (effectiveStat.isDirectory()) {
          if (!(await isHubRepoLayoutDir(sourcePath))) {
            return {
              ok: false,
              error:
                'Source folder is not a Hugging Face hub cache (expected blobs/, refs/, snapshots/ under the folder, or a models--* folder name).',
            };
          }

          await fs.mkdir(customDir, { recursive: true });
          const folderName =
            sanitizeHubFolderBaseName(String(payload?.suggestedFileName || '').trim()) || path.basename(sourcePath);
          const targetDir = await uniqueHubFolderTargetPath(customDir, folderName);

          if (mode === 'move') {
            try {
              await fs.rename(sourcePath, targetDir);
              report(1, 1, 'copying', { force: true });
              report(1, 1, 'done', { force: true });
              const agg = await computeHubFolderStats(targetDir);
              const model: ModelManagerFileEntry = {
                fileName: path.basename(targetDir),
                absolutePath: targetDir,
                sizeBytes: agg.sizeBytes,
                modifiedMs: agg.modifiedMs,
                source: 'custom',
                entryKind: 'hubRepo',
                suggestedFileName: path.basename(targetDir),
              };
              return { ok: true, model };
            } catch {
              /* cross-volume or locked: copy then remove source */
            }
          }

          const copiedTotal = await copyDirectoryTreeWithProgress(sourcePath, targetDir, report);
          const bt = Math.max(1, copiedTotal);
          if (mode === 'move') {
            report(bt, bt, 'finishing', { force: true });
            await fs.rm(sourcePath, { recursive: true, force: true });
          }
          report(bt, bt, 'done', { force: true });
          const agg = await computeHubFolderStats(targetDir);
          const model: ModelManagerFileEntry = {
            fileName: path.basename(targetDir),
            absolutePath: targetDir,
            sizeBytes: agg.sizeBytes,
            modifiedMs: agg.modifiedMs,
            source: 'custom',
            entryKind: 'hubRepo',
            suggestedFileName: path.basename(targetDir),
          };
          return { ok: true, model };
        }

        if (hubRequested) {
          return { ok: false, error: 'This cache entry is not a folder; refresh the model list.' };
        }

        const source = await resolveMigrationSource(sourcePath);
        if (!source.ok) {
          return source;
        }
        if (!(await isRecognizedGgufFile(source.readPath, source.stat.size))) {
          return { ok: false, error: 'Only GGUF model files are supported for migration.' };
        }
        await fs.mkdir(customDir, { recursive: true });
        const suggestedFileName = sanitizeModelFileName(String(payload?.suggestedFileName || ''))
          || suggestModelFileName(sourcePath);
        const targetPath = await uniqueModelTargetPath(customDir, suggestedFileName);
        const totalBytes = Math.max(1, source.stat.size);

        report(0, totalBytes, 'copying', { force: true });

        if (mode === 'move' && !source.isSymlink) {
          try {
            await fs.rename(source.readPath, targetPath);
            report(totalBytes, totalBytes, 'copying', { force: true });
            report(totalBytes, totalBytes, 'done', { force: true });
            const model = await readSingleModel(targetPath, 'custom');
            return { ok: true, model };
          } catch {
            /* fall through to streamed copy */
          }
        }

        let done = 0;
        await copyFileWithProgressBytes(source.readPath, targetPath, (d) => {
          done += d;
          report(Math.min(done, totalBytes), totalBytes, 'copying');
        });
        report(totalBytes, totalBytes, 'copying', { force: true });

        if (mode === 'move') {
          report(totalBytes, totalBytes, 'finishing', { force: true });
          try {
            await fs.unlink(source.removePath);
          } catch {
            await fs.unlink(source.readPath).catch(() => {});
          }
        }
        report(totalBytes, totalBytes, 'done', { force: true });
        const model = await readSingleModel(targetPath, 'custom');
        return { ok: true, model };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'model-manager:rename-model',
    async (
      _event,
      payload: { customDir: string; modelPath: string; newFileName: string },
    ): Promise<ModelManagerMutationResult> => {
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
        if (!hasModelExtension(newFileName)) {
          return { ok: false, error: 'Renamed model file must keep a .gguf or .ggml extension.' };
        }
        const targetPath = path.join(path.dirname(modelPath), newFileName);
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
      _event,
      payload: { customDir: string; modelPath: string },
    ): Promise<ModelManagerMutationResult> => {
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
      _event,
      payload: { query: string; token?: string; limit?: number; skip?: number; fileType?: string },
    ): Promise<ModelManagerHfSearchResult> => {
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
    'model-manager:list-hf-files',
    async (
      _event,
      payload: { id: string; token?: string },
    ): Promise<ModelManagerHfFilesResult> => {
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
