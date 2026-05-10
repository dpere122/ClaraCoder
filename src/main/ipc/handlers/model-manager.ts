import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import path = require('path');
import type {
  HuggingFaceModelSearchItem,
  ModelManagerCacheLocation,
  ModelManagerDetectCachesResult,
  ModelManagerFileEntry,
  ModelManagerHfSearchResult,
  ModelManagerListModelsResult,
  ModelManagerMutationResult,
} from '../../../shared';
import { mainState } from '../../state';

const MODEL_EXTENSIONS = new Set(['.gguf']);

function normalizeAbs(p: string): string {
  return path.resolve(p);
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

async function pathExistsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function walkModelFiles(
  root: string,
  source: 'custom' | 'cache',
  sourceRoot?: string,
): Promise<ModelManagerFileEntry[]> {
  const out: ModelManagerFileEntry[] = [];
  const stack: string[] = [normalizeAbs(root)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !hasModelExtension(full)) {
        continue;
      }
      const stat = await fs.stat(full);
      out.push({
        fileName: entry.name,
        absolutePath: full,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
        source,
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
    const abs = normalizeAbs(raw);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
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

/** Model Manager IPC: custom model folder CRUD, cache detection/migration, and Hugging Face search. */
export function registerModelManagerIpc(): void {
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
        const customDir = normalizeAbs(String(payload?.customDir || '').trim());
        if (!customDir) {
          return { ok: false, error: 'Custom model directory is empty.' };
        }
        if (!(await pathExistsDir(customDir))) {
          return { ok: true, models: [] };
        }
        const models = await walkModelFiles(customDir, 'custom');
        return { ok: true, models };
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
        const roots = input.map((p) => normalizeAbs(String(p || '').trim())).filter(Boolean);
        const models: ModelManagerFileEntry[] = [];
        for (const root of roots) {
          if (!(await pathExistsDir(root))) {
            continue;
          }
          const found = await walkModelFiles(root, 'cache', root);
          models.push(...found);
        }
        const dedup = new Map<string, ModelManagerFileEntry>();
        for (const model of models) {
          dedup.set(process.platform === 'win32' ? model.absolutePath.toLowerCase() : model.absolutePath, model);
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
      payload: { sourcePath: string; customDir: string; mode: 'copy' | 'move' },
    ): Promise<ModelManagerMutationResult> => {
      try {
        const sourcePath = normalizeAbs(String(payload?.sourcePath || '').trim());
        const customDir = normalizeAbs(String(payload?.customDir || '').trim());
        const mode = payload?.mode === 'move' ? 'move' : 'copy';
        if (!sourcePath || !customDir) {
          return { ok: false, error: 'Missing source path or custom directory.' };
        }
        if (!hasModelExtension(sourcePath)) {
          return { ok: false, error: 'Only .gguf model files are supported for migration.' };
        }
        const sourceStat = await fs.stat(sourcePath);
        if (!sourceStat.isFile()) {
          return { ok: false, error: 'Source path is not a file.' };
        }
        await fs.mkdir(customDir, { recursive: true });
        const targetPath = path.join(customDir, path.basename(sourcePath));
        try {
          await fs.stat(targetPath);
          return { ok: false, error: `Target already exists: ${path.basename(targetPath)}` };
        } catch {
          /* target missing */
        }
        if (mode === 'copy') {
          await fs.copyFile(sourcePath, targetPath);
        } else {
          try {
            await fs.rename(sourcePath, targetPath);
          } catch {
            await fs.copyFile(sourcePath, targetPath);
            await fs.unlink(sourcePath);
          }
        }
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
        const customDir = normalizeAbs(String(payload?.customDir || '').trim());
        const modelPath = normalizeAbs(String(payload?.modelPath || '').trim());
        const newFileName = sanitizeRename(String(payload?.newFileName || ''));
        if (!customDir || !modelPath || !newFileName) {
          return { ok: false, error: 'Missing custom directory, model path, or new filename.' };
        }
        if (!isWithinRoot(customDir, modelPath)) {
          return { ok: false, error: 'Model path must be inside the custom directory.' };
        }
        if (!hasModelExtension(newFileName)) {
          return { ok: false, error: 'Renamed file must keep a .gguf extension.' };
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
        const customDir = normalizeAbs(String(payload?.customDir || '').trim());
        const modelPath = normalizeAbs(String(payload?.modelPath || '').trim());
        if (!customDir || !modelPath) {
          return { ok: false, error: 'Missing custom directory or model path.' };
        }
        if (!isWithinRoot(customDir, modelPath)) {
          return { ok: false, error: 'Model path must be inside the custom directory.' };
        }
        await fs.unlink(modelPath);
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
      payload: { query: string; token?: string; limit?: number },
    ): Promise<ModelManagerHfSearchResult> => {
      try {
        const query = String(payload?.query || '').trim();
        if (!query) {
          return { ok: true, models: [] };
        }
        const limit = Math.min(50, Math.max(1, Number(payload?.limit ?? 24)));
        const token = String(payload?.token || '').trim();
        const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1`;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const response = await fetch(url, { headers });
        if (!response.ok) {
          return { ok: false, error: `Hugging Face search failed (${response.status}).` };
        }
        const raw = (await response.json()) as Array<Record<string, unknown>>;
        const models: HuggingFaceModelSearchItem[] = raw.map((m) => ({
          id: String(m['id'] ?? ''),
          likes: Number(m['likes'] ?? 0) || 0,
          downloads: Number(m['downloads'] ?? 0) || 0,
          lastModified: String(m['lastModified'] ?? ''),
          private: Boolean(m['private']),
          gated: Boolean(m['gated']),
          tags: Array.isArray(m['tags']) ? m['tags'].map((t) => String(t)) : [],
        })).filter((m) => !!m.id);
        return { ok: true, models };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}
