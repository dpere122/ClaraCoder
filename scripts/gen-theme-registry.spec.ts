import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { THEME_GROUPS } from '../src/shared/theme/theme-registry.generated';
import { isValidThemeGroupId } from '../src/shared/theme/theme-registry-types';
import { THEME_RUNTIME_ONLY_PROPERTIES, THEME_TOKENS } from '../src/shared/theme/theme-tokens';

const projectRoot = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('gen-theme-registry', () => {
  it('committed registry outputs are up to date (run node scripts/gen-theme-registry.mjs)', () => {
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'gen-theme-registry.mjs'), '--check'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('every generated group has a valid id, selector, and known tokens', () => {
    expect(THEME_GROUPS.length).toBeGreaterThan(0);
    const known = new Set(THEME_TOKENS.map((t) => t.name));
    const seen = new Set<string>();
    for (const g of THEME_GROUPS) {
      expect(isValidThemeGroupId(g.id), g.id).toBe(true);
      expect(seen.has(g.id), `duplicate ${g.id}`).toBe(false);
      seen.add(g.id);
      expect(g.selector).toBe(`[data-theme-group="${g.id}"]`);
      expect(g.id.indexOf(`${g.category}.`)).toBe(0);
      for (const token of g.tokens) {
        expect(known.has(token), `${g.id} consumes uncatalogued token ${token}`).toBe(true);
      }
    }
  });

  it('every --t-* property the renderer reads is in the token catalog (or runtime-only)', () => {
    const known = new Set<string>([...THEME_TOKENS.map((t) => t.name), ...THEME_RUNTIME_ONLY_PROPERTIES]);
    const unknown = new Map<string, string>();
    const files = walk(path.join(projectRoot, 'src', 'renderer', 'src')).filter(
      (f) => (f.endsWith('.css') || f.endsWith('.ts') || f.endsWith('.html')) && !f.endsWith('.spec.ts'),
    );
    const re = /var\(\s*(--t-[a-z0-9-]+)/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!known.has(m[1]!) && !unknown.has(m[1]!)) {
          unknown.set(m[1]!, path.relative(projectRoot, file));
        }
      }
    }
    expect([...unknown.entries()].map(([t, f]) => `${t} (${f})`)).toEqual([]);
  });

  it('background-capable groups exist for chat transcript and Monaco', () => {
    const bg = THEME_GROUPS.filter((g) => g.supportsBackground).map((g) => g.id);
    expect(bg).toEqual(expect.arrayContaining(['chat.transcript', 'editor.monaco']));
  });

  it('python registry.json mirrors the token catalog and groups', () => {
    const json = JSON.parse(
      readFileSync(path.join(projectRoot, 'python', 'clara_coder_backend', 'theme', 'registry.json'), 'utf8'),
    ) as { groups: { id: string }[]; tokens: { name: string; category: string; kind: string }[] };
    expect(json.groups.map((g) => g.id)).toEqual(THEME_GROUPS.map((g) => g.id));
    expect(json.tokens.map((t) => t.name)).toEqual(THEME_TOKENS.map((t) => t.name));
    for (let i = 0; i < json.tokens.length; i++) {
      expect(json.tokens[i]!.category).toBe(THEME_TOKENS[i]!.category);
      expect(json.tokens[i]!.kind).toBe(THEME_TOKENS[i]!.kind);
    }
  });
});
