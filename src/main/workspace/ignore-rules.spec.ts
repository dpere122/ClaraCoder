/**
 * Tests for security/workspace-ignore-expose — secrets denylist and
 * .gitignore negation support.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./log-files', () => ({ isLogRelatedFile: vi.fn(() => false) }));

import {
  isAlwaysIgnoredWorkspaceEntry,
  matchesIgnoreRule,
  shouldIgnoreWorkspaceEntry,
} from './ignore-rules';

describe('isAlwaysIgnoredWorkspaceEntry (secrets denylist)', () => {
  it.each([
    ['.env', '.env'],
    ['.env.local', '.env.local'],
    ['.env.production', '.env.production'],
    ['id_rsa', 'id_rsa'],
    ['id_ed25519', 'id_ed25519'],
    ['credentials.json', 'credentials.json'],
  ])('denies %s at %s', (name, rel) => {
    expect(isAlwaysIgnoredWorkspaceEntry(name, rel)).toBe(true);
  });

  it('denies .git directory', () => {
    expect(isAlwaysIgnoredWorkspaceEntry('.git', '.git')).toBe(true);
    expect(isAlwaysIgnoredWorkspaceEntry('config', '.git/config')).toBe(true);
  });

  it.each(['.pem', 'private.key', 'cert.p12', 'bundle.pfx'])('denies secret suffix %s', (suffix) => {
    const name = `file.${suffix}`;
    expect(isAlwaysIgnoredWorkspaceEntry(name, name)).toBe(true);
  });

  it('is case-insensitive (APFS/NTFS): .ENV / ID_RSA / key.PEM', () => {
    expect(isAlwaysIgnoredWorkspaceEntry('.ENV', '.ENV')).toBe(true);
    expect(isAlwaysIgnoredWorkspaceEntry('ID_RSA', 'ID_RSA')).toBe(true);
    expect(isAlwaysIgnoredWorkspaceEntry('key.PEM', 'key.PEM')).toBe(true);
  });

  it('catches denylisted basenames anywhere in the relative path', () => {
    expect(isAlwaysIgnoredWorkspaceEntry('credentials.json', 'secrets/credentials.json')).toBe(true);
  });

  it('allows a benign entry', () => {
    expect(isAlwaysIgnoredWorkspaceEntry('README.md', 'README.md')).toBe(false);
    expect(isAlwaysIgnoredWorkspaceEntry('app.ts', 'src/app.ts')).toBe(false);
  });
});

describe('matchesIgnoreRule', () => {
  it('matches a directory rule (with trailing slash)', () => {
    expect(matchesIgnoreRule('build/dist', 'build', 'build/')).toBe(true);
    expect(matchesIgnoreRule('build', 'build', 'build/')).toBe(true);
    expect(matchesIgnoreRule('src/build', 'build', 'build/')).toBe(true);
  });

  it('matches a *.ext rule', () => {
    expect(matchesIgnoreRule('app.log', 'app.log', '*.log')).toBe(true);
    expect(matchesIgnoreRule('app.ts', 'app.ts', '*.log')).toBe(false);
  });

  it('matches a basename rule anywhere in the path', () => {
    expect(matchesIgnoreRule('dist/out.txt', 'out.txt', 'out.txt')).toBe(true);
    expect(matchesIgnoreRule('dist/out.txt', 'out.txt', 'other.txt')).toBe(false);
  });

  it('matches an anchored path rule', () => {
    // normalizeContextPath keeps the leading slash, so '/secret.cfg' anchors to the workspace root.
    expect(matchesIgnoreRule('secret.cfg', 'secret.cfg', '/secret.cfg')).toBe(true);
    expect(matchesIgnoreRule('x/secret.cfg', 'secret.cfg', '/secret.cfg')).toBe(false);
  });
});

describe('shouldIgnoreWorkspaceEntry (denylist wins, negation, exposeAll)', () => {
  it('denylist wins over exposeAll=true', () => {
    expect(shouldIgnoreWorkspaceEntry('.env', '.env', [], true)).toBe(true);
  });

  it('denylist wins over a !negation rule', () => {
    expect(shouldIgnoreWorkspaceEntry('.env', '.env', ['.env', '!.env'], false)).toBe(true);
  });

  it('a benign entry with exposeAll=true is not ignored', () => {
    expect(shouldIgnoreWorkspaceEntry('README.md', 'README.md', [], true)).toBe(false);
  });

  it('a positive rule ignores a non-denylisted entry', () => {
    expect(shouldIgnoreWorkspaceEntry('app.log', 'app.log', ['*.log'], false)).toBe(true);
  });

  it('a !negation rule re-includes a non-denylisted entry', () => {
    expect(shouldIgnoreWorkspaceEntry('secret.cfg', 'secret.cfg', ['secret.cfg', '!secret.cfg'], false)).toBe(false);
  });

  it('denylist wins even when a positive rule would not match', () => {
    expect(shouldIgnoreWorkspaceEntry('id_rsa', 'id_rsa', ['*.log'], false)).toBe(true);
  });
});
