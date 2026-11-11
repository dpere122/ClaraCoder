import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  APP_UPDATE_REPO,
  appReleaseAction,
  compareAppVersions,
  isPrereleaseVersion,
  versionFromReleaseTag,
  visibleAppReleases,
  type AppReleaseSummary,
} from './app-updater';

function release(version: string, prerelease = isPrereleaseVersion(version)): AppReleaseSummary {
  return {
    version,
    tag: `v${version}`,
    name: `v${version}`,
    notes: '',
    prerelease,
    publishedAt: null,
    htmlUrl: '',
    installer: null,
  };
}

describe('compareAppVersions', () => {
  it.each([
    ['0.1.1', '0.1.0', 1],
    ['0.2.0', '0.10.0', -1],
    ['1.0.0', '1.0.0', 0],
    ['0.2.0', '0.2.0-beta.9', 1],
    ['0.2.0-beta.10', '0.2.0-beta.9', 1],
    ['0.2.0-beta.1', '0.2.0-alpha.5', 1],
    ['0.2.0-beta', '0.2.0-beta.1', -1],
    ['0.2.0+build.7', '0.2.0', 0],
    ['not-a-version', '0.0.1', -1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareAppVersions(a, b)).toBe(expected);
    expect(compareAppVersions(b, a)).toBe(-expected || 0);
  });
});

describe('appReleaseAction', () => {
  it('picks update / downgrade / reinstall from the comparison', () => {
    expect(appReleaseAction('0.1.1', '0.2.0')).toBe('update');
    expect(appReleaseAction('0.2.0', '0.2.0-beta.3')).toBe('downgrade');
    expect(appReleaseAction('0.2.0-beta.3', '0.2.0-beta.3')).toBe('reinstall');
  });
});

describe('versionFromReleaseTag', () => {
  it('strips the v prefix and rejects non-semver tags', () => {
    expect(versionFromReleaseTag('v0.2.0-beta.4')).toBe('0.2.0-beta.4');
    expect(versionFromReleaseTag('0.3.0')).toBe('0.3.0');
    expect(versionFromReleaseTag('dev')).toBeNull();
    expect(versionFromReleaseTag('v0.2')).toBeNull();
  });
});

describe('visibleAppReleases', () => {
  const all = [release('0.1.0'), release('0.2.0-beta.2'), release('0.2.0'), release('0.3.0-beta.1')];

  it('lists stable releases only by default, newest first', () => {
    expect(visibleAppReleases(all, false).map((r) => r.version)).toEqual(['0.2.0', '0.1.0']);
  });

  it('includes pre-releases when beta versions are on', () => {
    expect(visibleAppReleases(all, true).map((r) => r.version)).toEqual([
      '0.3.0-beta.1',
      '0.2.0',
      '0.2.0-beta.2',
      '0.1.0',
    ]);
  });
});

describe('APP_UPDATE_REPO', () => {
  it('matches the electron-builder publish config', () => {
    const yml = readFileSync(path.join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/publish:\s*\n\s+provider: github\s*\n\s+owner: (\S+)\s*\n\s+repo: (\S+)/);
    const [, owner, repo] = /publish:\s*\n\s+provider: github\s*\n\s+owner: (\S+)\s*\n\s+repo: (\S+)/.exec(yml)!;
    expect({ owner, repo }).toEqual(APP_UPDATE_REPO);
  });
});
