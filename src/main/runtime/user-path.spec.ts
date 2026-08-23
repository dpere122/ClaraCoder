import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyResolvedUserPath,
  existingKnownUserBins,
  isNologinShell,
  LOGIN_SHELL_PATH_TIMEOUT_MS,
  mergePathSegments,
  parseExtraUserPath,
  parseProbedPathOutput,
  probeLoginShellPath,
  resetUserPathStateForTests,
  resolveUserPath,
} from './user-path';

afterEach(() => {
  resetUserPathStateForTests();
});

describe('mergePathSegments', () => {
  it('dedupes while preserving first-seen order', () => {
    expect(
      mergePathSegments(
        ['/home/u/.local/bin:/usr/bin', ['/home/u/.local/bin', '/home/u/.cargo/bin'], '/usr/bin:/bin'],
        ':',
        false,
      ),
    ).toBe('/home/u/.local/bin:/usr/bin:/home/u/.cargo/bin:/bin');
  });

  it('uses Windows path delimiter and case-insensitive dedupe', () => {
    expect(
      mergePathSegments(
        ['C:\\Users\\a\\.cargo\\bin', 'c:\\Users\\a\\.cargo\\bin;C:\\Windows\\System32'],
        ';',
        true,
      ),
    ).toBe('C:\\Users\\a\\.cargo\\bin;C:\\Windows\\System32');
  });
});

describe('parseExtraUserPath', () => {
  it('splits on newlines and the platform delimiter, expanding ~', () => {
    const dirs = parseExtraUserPath('~/tools\n/opt/extra:/opt/extra\n', ':', '/home/me');
    expect(dirs).toEqual([path.join('/home/me', 'tools'), '/opt/extra']);
  });

  it('rejects env-assignment looking entries', () => {
    expect(parseExtraUserPath('OPENAI_API_KEY=sk-secret\n/opt/ok', ':', '/home/me')).toEqual(['/opt/ok']);
  });
});

describe('existingKnownUserBins', () => {
  it('returns only directories that exist', () => {
    const home = '/home/me';
    const present = new Set([path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), '/usr/local/bin']);
    const bins = existingKnownUserBins(home, 'linux', (dir) => present.has(dir));
    expect(bins).toEqual([
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      '/usr/local/bin',
    ]);
  });
});

describe('resolveUserPath', () => {
  it('prepends extra dirs, then known bins, then login PATH, then current PATH', () => {
    const resolved = resolveUserPath({
      extraUserPath: '/opt/extra',
      knownBins: ['/home/me/.local/bin'],
      loginPath: '/home/me/.cargo/bin:/usr/bin',
      currentPath: '/usr/bin:/bin',
      delimiter: ':',
      platform: 'linux',
      home: '/home/me',
    });
    expect(resolved).toBe('/opt/extra:/home/me/.local/bin:/home/me/.cargo/bin:/usr/bin:/bin');
  });

  it('falls back to known bins + current PATH when login probe is null', () => {
    const resolved = resolveUserPath({
      knownBins: ['/home/me/.local/bin'],
      loginPath: null,
      currentPath: '/usr/bin:/bin',
      delimiter: ':',
      platform: 'linux',
    });
    expect(resolved).toBe('/home/me/.local/bin:/usr/bin:/bin');
  });
});

describe('parseProbedPathOutput', () => {
  it('takes the last PATH-looking line and ignores KEY=value dumps', () => {
    const stdout = [
      'Welcome to fish',
      'SECRET_TOKEN=super-secret',
      'OPENAI_API_KEY=sk-leak',
      '/home/me/.local/bin:/usr/bin:/bin',
    ].join('\n');
    expect(parseProbedPathOutput(stdout, ':')).toBe('/home/me/.local/bin:/usr/bin:/bin');
  });

  it('returns null when stdout has no PATH', () => {
    expect(parseProbedPathOutput('hello\nSECRET=1', ':')).toBeNull();
  });
});

describe('isNologinShell', () => {
  it('skips nologin and false shells', () => {
    expect(isNologinShell('/usr/sbin/nologin')).toBe(true);
    expect(isNologinShell('/bin/false')).toBe(true);
    expect(isNologinShell('/bin/bash')).toBe(false);
  });
});

describe('probeLoginShellPath', () => {
  it('returns PATH-only stdout from the runner', async () => {
    const probed = await probeLoginShellPath({
      platform: 'linux',
      shell: '/bin/bash',
      delimiter: ':',
      runner: async (command, args, options) => {
        expect(command).toBe('/bin/bash');
        expect(args).toEqual(['-ilc', 'printf %s "$PATH"']);
        expect(options.env.TERM).toBe('dumb');
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
        expect(options.timeoutMs).toBe(LOGIN_SHELL_PATH_TIMEOUT_MS);
        return {
          stdout: 'TOKEN=leak\n/home/me/.local/bin:/usr/bin\n',
          exitCode: 0,
        };
      },
    });
    expect(probed).toBe('/home/me/.local/bin:/usr/bin');
  });

  it('returns null for nologin shells without invoking the runner', async () => {
    const runner = vi.fn();
    const probed = await probeLoginShellPath({
      platform: 'linux',
      shell: '/usr/sbin/nologin',
      runner,
    });
    expect(probed).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null when the runner fails (timeout fallback)', async () => {
    const probed = await probeLoginShellPath({
      platform: 'linux',
      shell: '/bin/bash',
      runner: async () => {
        throw new Error('timeout');
      },
    });
    expect(probed).toBeNull();
  });
});

describe('applyResolvedUserPath', () => {
  it('writes the merged PATH onto process.env and does not re-probe', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    resetUserPathStateForTests();
    const probe = vi.fn(async () => '/home/me/.cargo/bin:/usr/bin');
    try {
      const first = await applyResolvedUserPath({
        extraUserPath: '/opt/extra',
        knownBins: ['/home/me/.local/bin'],
        probe,
      });
      expect(first.startsWith('/opt/extra:/home/me/.local/bin:/home/me/.cargo/bin:')).toBe(true);
      expect(process.env.PATH).toBe(first);
      const second = await applyResolvedUserPath({
        extraUserPath: '/opt/other',
        knownBins: ['/home/me/.local/bin'],
        probe,
      });
      expect(second.startsWith('/opt/other:')).toBe(true);
      expect(second).toContain('/usr/bin');
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      process.env.PATH = previous;
      resetUserPathStateForTests();
    }
  });
});

describe('login shell timeout budget', () => {
  it('stays short enough not to block packaged startup', () => {
    expect(LOGIN_SHELL_PATH_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
