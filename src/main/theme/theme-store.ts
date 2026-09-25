/**
 * On-disk theme library: `{userData}/themes/<id>/theme.json` plus `assets/` for background
 * images. Built-in themes never touch disk. Every read is validated; every write is atomic.
 *
 * Portable bundles (`*.clara-theme.json`) are the same document with assets embedded as
 * `data:image/…;base64,` URLs; import unpacks them into files, export re-embeds them.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { getAppDataDir } from '../paths';
import {
  BUILTIN_THEMES,
  builtInThemeForMode,
  findBuiltInTheme,
  isBuiltInThemeId,
} from '../../shared/theme/builtin';
import {
  THEME_ASSET_NAME_PATTERN,
  THEME_ID_PATTERN,
  cloneThemeDocument,
  isThemeAssetDataUrl,
  slugifyThemeId,
  validateThemeDocument,
  type ClaraThemeDocument,
  type ThemeMode,
} from '../../shared/theme/theme-document';
import type {
  ThemeAssetPickResult,
  ThemeMutationResult,
  ThemeSaveResult,
} from '../../shared/theme/theme-ipc';
import { sanitizeSvg } from '../protocol/nemo-asset';

export const THEME_FILE_NAME = 'theme.json';
export const THEME_ASSETS_DIR_NAME = 'assets';
export const THEME_BUNDLE_EXTENSION = '.clara-theme.json';
export const THEME_ASSET_MAX_BYTES = 24 * 1024 * 1024;

/** Image types accepted as background assets → served MIME type. */
export const THEME_ASSET_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export function getThemesDir(): string {
  return path.join(getAppDataDir(), 'themes');
}

function assertThemeId(themeId: string): string {
  const id = typeof themeId === 'string' ? themeId.trim() : '';
  if (!THEME_ID_PATTERN.test(id)) {
    throw new Error(`Invalid theme id "${themeId}"`);
  }
  return id;
}

export function getThemeDir(themeId: string): string {
  return path.join(getThemesDir(), assertThemeId(themeId));
}

export function getThemeAssetsDir(themeId: string): string {
  return path.join(getThemeDir(themeId), THEME_ASSETS_DIR_NAME);
}

export function themeAssetExtension(fileName: string): string {
  return path.extname(fileName).replace(/^\./, '').toLowerCase();
}

/**
 * Absolute path of an asset file inside a theme's `assets/` folder, or null when either name
 * is malformed or the resolved path escapes the folder.
 */
export function resolveThemeAssetPath(themeId: string, fileName: string): string | null {
  if (!THEME_ID_PATTERN.test(themeId) || !THEME_ASSET_NAME_PATTERN.test(fileName)) {
    return null;
  }
  if (!THEME_ASSET_MIME_BY_EXT[themeAssetExtension(fileName)]) {
    return null;
  }
  const assetsDir = path.resolve(getThemeAssetsDir(themeId));
  const abs = path.resolve(assetsDir, fileName);
  const rel = path.relative(assetsDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return null;
  }
  return abs;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Ids of every theme directory on disk (unvalidated). */
async function listUserThemeIds(): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(getThemesDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && THEME_ID_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Read and validate one user theme; null when missing or invalid. */
export async function readUserTheme(themeId: string): Promise<ClaraThemeDocument | null> {
  if (!THEME_ID_PATTERN.test(themeId) || isBuiltInThemeId(themeId)) {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(getThemeDir(themeId), THEME_FILE_NAME), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[themes] ${themeId}/theme.json is not valid JSON`);
    return null;
  }
  const result = validateThemeDocument(parsed);
  if (!result.ok || !result.doc) {
    console.warn(`[themes] ${themeId}/theme.json rejected: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    return null;
  }
  // The folder name is authoritative for the id.
  result.doc.id = themeId;
  return result.doc;
}

export async function listUserThemes(): Promise<ClaraThemeDocument[]> {
  const ids = await listUserThemeIds();
  const out: ClaraThemeDocument[] = [];
  for (const id of ids) {
    const doc = await readUserTheme(id);
    if (doc) {
      out.push(doc);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Built-ins first, then user themes sorted by name. */
export async function listAllThemes(): Promise<ClaraThemeDocument[]> {
  return [...BUILTIN_THEMES.map((t) => cloneThemeDocument(t)), ...(await listUserThemes())];
}

export async function findTheme(themeId: string): Promise<ClaraThemeDocument | null> {
  const builtIn = findBuiltInTheme(themeId);
  if (builtIn) {
    return cloneThemeDocument(builtIn);
  }
  return readUserTheme(themeId);
}

async function themeIdTaken(id: string): Promise<boolean> {
  return isBuiltInThemeId(id) || (await pathExists(getThemeDir(id)));
}

/** `neon`, `neon-2`, `neon-3`, … — first id not already used by a built-in or a user theme. */
export async function uniqueThemeId(base: string): Promise<string> {
  const slug = slugifyThemeId(base);
  if (!(await themeIdTaken(slug))) {
    return slug;
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug.slice(0, 60)}-${n}`;
    if (!(await themeIdTaken(candidate))) {
      return candidate;
    }
  }
  throw new Error('Could not allocate a unique theme id');
}

function parseDataImageUrl(value: string): { mime: string; bytes: Buffer } | null {
  if (!isThemeAssetDataUrl(value)) {
    return null;
  }
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(value);
  if (!m) {
    return null;
  }
  const mime = m[1]!.toLowerCase();
  if (!EXT_BY_MIME[mime]) {
    return null;
  }
  return { mime, bytes: Buffer.from(m[2]!, 'base64') };
}

function prepareAssetBytes(bytes: Buffer, ext: string): Buffer {
  return ext === 'svg' ? sanitizeSvg(bytes) : bytes;
}

async function uniqueAssetFileName(assetsDir: string, baseName: string, ext: string): Promise<string> {
  const stem = baseName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'asset';
  let candidate = `${stem}.${ext}`;
  for (let n = 2; await pathExists(path.join(assetsDir, candidate)); n++) {
    candidate = `${stem}-${n}.${ext}`;
  }
  return candidate;
}

/**
 * Validate and persist `input` under its id. Embedded `data:` assets are written to `assets/`
 * and replaced by file names; asset files no longer referenced are deleted. Built-in ids are
 * rejected. Accepts unknown JSON (IPC payloads) as well as typed documents.
 */
export async function writeUserTheme(input: unknown): Promise<ThemeSaveResult> {
  const validated = validateThemeDocument(input);
  if (!validated.ok || !validated.doc) {
    return { ok: false, error: 'Theme document is invalid', errors: validated.errors, warnings: validated.warnings };
  }
  const doc = validated.doc;
  if (isBuiltInThemeId(doc.id)) {
    return { ok: false, error: `"${doc.id}" is a built-in theme; duplicate it to make changes` };
  }
  delete doc.builtIn;

  const themeDir = getThemeDir(doc.id);
  const assetsDir = getThemeAssetsDir(doc.id);
  await fs.mkdir(assetsDir, { recursive: true });

  const assets: Record<string, string> = {};
  for (const key of Object.keys(doc.assets ?? {})) {
    const value = doc.assets![key]!;
    if (/^data:/i.test(value)) {
      const parsed = parseDataImageUrl(value);
      if (!parsed || parsed.bytes.length === 0 || parsed.bytes.length > THEME_ASSET_MAX_BYTES) {
        validated.warnings.push({ path: `assets.${key}`, message: 'embedded image could not be decoded (dropped)' });
        continue;
      }
      const ext = EXT_BY_MIME[parsed.mime]!;
      const fileName = await uniqueAssetFileName(assetsDir, key, ext);
      await writeFileAtomic(path.join(assetsDir, fileName), prepareAssetBytes(parsed.bytes, ext));
      assets[key] = fileName;
      continue;
    }
    if (resolveThemeAssetPath(doc.id, value) && (await pathExists(path.join(assetsDir, value)))) {
      assets[key] = value;
    } else {
      validated.warnings.push({ path: `assets.${key}`, message: `file "${value}" is missing (dropped)` });
    }
  }
  if (Object.keys(assets).length > 0) {
    doc.assets = assets;
  } else {
    delete doc.assets;
  }

  // Prune orphaned asset files.
  const referenced = new Set(Object.keys(assets).map((k) => assets[k]!));
  try {
    for (const entry of await fs.readdir(assetsDir)) {
      if (!referenced.has(entry)) {
        await fs.rm(path.join(assetsDir, entry), { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Missing folder is fine.
  }

  await writeFileAtomic(path.join(themeDir, THEME_FILE_NAME), `${JSON.stringify(doc, null, 2)}\n`);
  return { ok: true, theme: doc, warnings: validated.warnings };
}

export async function deleteUserTheme(themeId: string): Promise<ThemeMutationResult> {
  if (!THEME_ID_PATTERN.test(themeId)) {
    return { ok: false, error: 'Invalid theme id' };
  }
  if (isBuiltInThemeId(themeId)) {
    return { ok: false, error: 'Built-in themes cannot be deleted' };
  }
  try {
    await fs.rm(getThemeDir(themeId), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Copy every asset file of `from` into the assets folder of `toId`. */
async function copyThemeAssets(from: ClaraThemeDocument, toId: string): Promise<void> {
  if (!from.assets || isBuiltInThemeId(from.id)) {
    return;
  }
  const targetDir = getThemeAssetsDir(toId);
  await fs.mkdir(targetDir, { recursive: true });
  for (const key of Object.keys(from.assets)) {
    const fileName = from.assets[key]!;
    const src = resolveThemeAssetPath(from.id, fileName);
    if (!src) {
      continue;
    }
    try {
      await fs.copyFile(src, path.join(targetDir, fileName));
    } catch {
      // Skip missing source files; the validator will drop the dangling reference on save.
    }
  }
}

/**
 * Create a new user theme named `name`, starting from `fromThemeId` (built-in or user) or the
 * built-in for `mode`.
 */
export async function createUserTheme(payload: {
  name: string;
  mode: ThemeMode;
  fromThemeId?: string;
}): Promise<ThemeSaveResult> {
  const name = (payload.name ?? '').trim().slice(0, 80) || 'Custom theme';
  const base = payload.fromThemeId ? await findTheme(payload.fromThemeId) : null;
  const source = base ?? builtInThemeForMode(payload.mode === 'light' ? 'light' : 'dark');
  const doc = cloneThemeDocument(source);
  doc.id = await uniqueThemeId(name);
  doc.name = name;
  delete doc.builtIn;
  if (base && !isBuiltInThemeId(base.id)) {
    await copyThemeAssets(base, doc.id);
  } else {
    delete doc.assets;
  }
  return writeUserTheme(doc);
}

export async function duplicateTheme(themeId: string, name: string): Promise<ThemeSaveResult> {
  const source = await findTheme(themeId);
  if (!source) {
    return { ok: false, error: `Theme "${themeId}" not found` };
  }
  return createUserTheme({ name: name?.trim() || `${source.name} copy`, mode: source.mode, fromThemeId: source.id });
}

/** Document with assets embedded as data URLs (portable single-file bundle). */
export async function exportThemeBundle(themeId: string): Promise<{ json: string; fileName: string } | null> {
  const doc = await findTheme(themeId);
  if (!doc) {
    return null;
  }
  const bundle = cloneThemeDocument(doc);
  delete bundle.builtIn;
  const assets: Record<string, string> = {};
  for (const key of Object.keys(bundle.assets ?? {})) {
    const fileName = bundle.assets![key]!;
    const abs = resolveThemeAssetPath(doc.id, fileName);
    if (!abs) {
      continue;
    }
    try {
      const bytes = await fs.readFile(abs);
      const mime = THEME_ASSET_MIME_BY_EXT[themeAssetExtension(fileName)]!;
      assets[key] = `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      // Skip unreadable asset.
    }
  }
  if (Object.keys(assets).length > 0) {
    bundle.assets = assets;
  } else {
    delete bundle.assets;
  }
  return { json: `${JSON.stringify(bundle, null, 2)}\n`, fileName: `${doc.id}${THEME_BUNDLE_EXTENSION}` };
}

/** Parse a bundle and store it as a new user theme (id de-duplicated). */
export async function importThemeBundle(json: string): Promise<ThemeSaveResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'File is not valid JSON' };
  }
  const validated = validateThemeDocument(parsed);
  if (!validated.ok || !validated.doc) {
    return { ok: false, error: 'File is not a valid Clara theme', errors: validated.errors, warnings: validated.warnings };
  }
  const doc = validated.doc;
  delete doc.builtIn;
  doc.id = await uniqueThemeId(doc.id);
  const saved = await writeUserTheme(doc);
  if (saved.ok) {
    saved.warnings = [...validated.warnings, ...(saved.warnings ?? [])];
  }
  return saved;
}

/**
 * Copy an image from `sourcePath` into the theme's assets folder. Returns the asset key the
 * renderer should store under `assets` plus the stored file name. The theme document itself is
 * updated by the caller (the settings draft) and persisted on save.
 */
export async function addThemeAssetFromFile(themeId: string, sourcePath: string): Promise<ThemeAssetPickResult> {
  if (!THEME_ID_PATTERN.test(themeId) || isBuiltInThemeId(themeId)) {
    return { ok: false, error: 'Assets can only be added to user themes' };
  }
  const ext = themeAssetExtension(sourcePath);
  if (!THEME_ASSET_MIME_BY_EXT[ext]) {
    return { ok: false, error: `Unsupported image type ".${ext}"` };
  }
  let bytes: Buffer;
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      return { ok: false, error: 'Not a file' };
    }
    if (stat.size > THEME_ASSET_MAX_BYTES) {
      return { ok: false, error: `Image is larger than ${Math.round(THEME_ASSET_MAX_BYTES / (1024 * 1024))} MB` };
    }
    bytes = await fs.readFile(sourcePath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const assetsDir = getThemeAssetsDir(themeId);
  await fs.mkdir(assetsDir, { recursive: true });
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const fileName = await uniqueAssetFileName(assetsDir, stem, ext);
  await writeFileAtomic(path.join(assetsDir, fileName), prepareAssetBytes(bytes, ext));
  const asset = fileName.slice(0, fileName.length - ext.length - 1);
  return { ok: true, asset, fileName };
}
