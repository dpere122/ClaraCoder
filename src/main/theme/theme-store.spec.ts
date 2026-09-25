import { mkdtempSync, rmSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'clara-themes-'));

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  app: { getPath: () => tmpRoot, isPackaged: false, setPath: vi.fn() },
}));
vi.mock('../paths', () => ({ getAppDataDir: () => tmpRoot }));

import {
  addThemeAssetFromFile,
  createUserTheme,
  deleteUserTheme,
  duplicateTheme,
  exportThemeBundle,
  getThemeAssetsDir,
  importThemeBundle,
  listAllThemes,
  listUserThemes,
  readUserTheme,
  resolveThemeAssetPath,
  uniqueThemeId,
  writeUserTheme,
} from './theme-store';
import { CLARA_DARK_THEME } from '../../shared/theme/builtin';

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('theme-store', () => {
  beforeAll(async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists built-ins when no user themes exist', async () => {
    expect(await listUserThemes()).toEqual([]);
    const all = await listAllThemes();
    expect(all.map((t) => t.id)).toEqual(['clara-dark', 'clara-light']);
    expect(all[0]!.builtIn).toBe(true);
  });

  it('creates a user theme from a built-in with a unique id and round-trips it', async () => {
    const created = await createUserTheme({ name: 'Neon Nights', mode: 'dark', fromThemeId: 'clara-dark' });
    expect(created.ok, created.error).toBe(true);
    expect(created.theme!.id).toBe('neon-nights');
    expect(created.theme!.builtIn).toBeUndefined();
    expect(created.theme!.tokens['--t-bg']).toBe(CLARA_DARK_THEME.tokens['--t-bg']);

    const again = await createUserTheme({ name: 'Neon Nights', mode: 'dark' });
    expect(again.theme!.id).toBe('neon-nights-2');

    const onDisk = await readUserTheme('neon-nights');
    expect(onDisk?.name).toBe('Neon Nights');
    expect((await listUserThemes()).map((t) => t.id)).toEqual(['neon-nights', 'neon-nights-2']);
    expect(await uniqueThemeId('clara-dark')).toBe('clara-dark-2');
  });

  it('refuses to overwrite built-ins', async () => {
    const result = await writeUserTheme({ ...CLARA_DARK_THEME });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/built-in/);
  });

  it('stores picked assets, prunes orphans on save, and guards traversal', async () => {
    const src = path.join(tmpRoot, 'wall.png');
    await fs.writeFile(src, PNG_BYTES);
    const picked = await addThemeAssetFromFile('neon-nights', src);
    expect(picked.ok, picked.error).toBe(true);
    expect(picked.asset).toBe('wall');
    expect(picked.fileName).toBe('wall.png');

    const orphan = await addThemeAssetFromFile('neon-nights', src);
    expect(orphan.fileName).toBe('wall-2.png');

    const doc = (await readUserTheme('neon-nights'))!;
    doc.assets = { wall: 'wall.png' };
    doc.groups = {
      'chat.transcript': { background: { enabled: true, asset: 'wall', opacity: 0.5, fit: 'cover' } },
    };
    const saved = await writeUserTheme(doc);
    expect(saved.ok, saved.error).toBe(true);
    const files = await fs.readdir(getThemeAssetsDir('neon-nights'));
    expect(files).toEqual(['wall.png']);

    expect(resolveThemeAssetPath('neon-nights', 'wall.png')).toBe(path.resolve(getThemeAssetsDir('neon-nights'), 'wall.png'));
    expect(resolveThemeAssetPath('neon-nights', '../theme.json')).toBeNull();
    expect(resolveThemeAssetPath('neon-nights', 'wall.exe')).toBeNull();
    expect(resolveThemeAssetPath('../x', 'wall.png')).toBeNull();
    expect(await addThemeAssetFromFile('neon-nights', path.join(tmpRoot, 'nope.txt'))).toMatchObject({ ok: false });
  });

  it('exports a bundle with embedded assets and imports it as a new theme', async () => {
    const bundle = await exportThemeBundle('neon-nights');
    expect(bundle).not.toBeNull();
    expect(bundle!.fileName).toBe('neon-nights.clara-theme.json');
    const parsed = JSON.parse(bundle!.json) as { assets: Record<string, string>; id: string };
    expect(parsed.assets['wall']).toMatch(/^data:image\/png;base64,/);

    const imported = await importThemeBundle(bundle!.json);
    expect(imported.ok, imported.error).toBe(true);
    expect(imported.theme!.id).toBe('neon-nights-3');
    expect(imported.theme!.assets).toEqual({ wall: 'wall.png' });
    const bytes = await fs.readFile(path.join(getThemeAssetsDir('neon-nights-3'), 'wall.png'));
    expect(bytes.equals(PNG_BYTES)).toBe(true);

    expect((await importThemeBundle('not json')).ok).toBe(false);
    expect((await importThemeBundle('{"version": 9}')).ok).toBe(false);
  });

  it('duplicates user themes (with assets) and deletes them', async () => {
    const dup = await duplicateTheme('neon-nights', 'Neon Copy');
    expect(dup.ok, dup.error).toBe(true);
    expect(dup.theme!.id).toBe('neon-copy');
    expect(dup.theme!.assets).toEqual({ wall: 'wall.png' });

    expect((await deleteUserTheme('clara-dark')).ok).toBe(false);
    expect((await deleteUserTheme('neon-copy')).ok).toBe(true);
    expect(await readUserTheme('neon-copy')).toBeNull();
  });

  it('ignores corrupt theme folders', async () => {
    const dir = path.join(tmpRoot, 'themes', 'broken-one');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'theme.json'), '{ nope', 'utf8');
    const ids = (await listUserThemes()).map((t) => t.id);
    expect(ids).not.toContain('broken-one');
  });
});
