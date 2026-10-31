import { describe, expect, it } from 'vitest';

import { resolveReleaseVersion } from './release-version.mjs';

describe('resolveReleaseVersion', () => {
  it('stamps beta builds as <next>-beta.<run>', () => {
    expect(resolveReleaseVersion({ channel: 'beta', pkgVersion: '0.2.0', build: '42' })).toEqual({
      version: '0.2.0-beta.42',
      tag: 'v0.2.0-beta.42',
      prerelease: true,
    });
  });

  it('uses package.json version for stable when the tag matches', () => {
    expect(resolveReleaseVersion({ channel: 'stable', pkgVersion: '0.2.0', tag: 'v0.2.0' })).toEqual({
      version: '0.2.0',
      tag: 'v0.2.0',
      prerelease: false,
    });
  });

  it.each([undefined, 'v0.1.9', '0.2.0', 'v0.2.0-beta.1'])('rejects stable tag %s for 0.2.0', (tag) => {
    expect(() => resolveReleaseVersion({ channel: 'stable', pkgVersion: '0.2.0', tag })).toThrow(/does not match/);
  });

  it.each([undefined, '', '0', '-3', '1.5', 'abc'])('rejects beta build number %s', (build) => {
    expect(() => resolveReleaseVersion({ channel: 'beta', pkgVersion: '0.2.0', build })).toThrow(/positive integer/);
  });

  it.each(['0.2.0-beta.1', '0.2', 'v0.2.0', '01.2.0'])('rejects non-plain package.json version %s', (pkgVersion) => {
    expect(() => resolveReleaseVersion({ channel: 'beta', pkgVersion, build: '1' })).toThrow(/plain X\.Y\.Z/);
  });

  it('rejects unknown channels such as "dev"', () => {
    expect(() => resolveReleaseVersion({ channel: 'dev', pkgVersion: '0.2.0', build: '1' })).toThrow(/Unknown channel/);
  });
});
