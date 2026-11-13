import { describe, expect, it } from 'vitest';

import { nextBetaBuild, resolveReleaseVersion } from './release-version.mjs';

describe('nextBetaBuild', () => {
  it('starts each version at 1', () => {
    expect(nextBetaBuild('0.4.8', [])).toBe(1);
    // Betas of other versions do not count, whatever their numbers.
    const others = ['v0.4.7-beta.17', 'v0.3.1-beta.9', 'v0.4.7', 'v10.4.8-beta.5', 'v0.4.80-beta.5', 'v0x4y8-beta.5'];
    expect(nextBetaBuild('0.4.8', others)).toBe(1);
  });

  it('goes one above the highest beta of the version', () => {
    expect(nextBetaBuild('0.4.7', ['v0.4.7-beta.1', 'v0.4.7-beta.2'])).toBe(3);
    // Numbers, not text: 17 is above 9.
    expect(nextBetaBuild('0.4.7', ['v0.4.7-beta.9', 'v0.4.7-beta.17', 'v0.4.7-beta.2'])).toBe(18);
    // A deleted beta leaves a gap; a count would hand out 3 again.
    expect(nextBetaBuild('0.4.7', ['v0.4.7-beta.1', 'v0.4.7-beta.3'])).toBe(4);
  });

  it('reads the lines git ls-remote prints, peeled tags included', () => {
    const listing = [
      '3f2a9c1d\trefs/tags/v0.4.7-beta.1',
      '77b69be4\trefs/tags/v0.4.7-beta.2',
      '19e2ca3b\trefs/tags/v0.4.7-beta.2^{}',
      '461f7cc3\trefs/tags/v0.4.7-beta.20-hotfix',
      '',
    ];
    expect(nextBetaBuild('0.4.7', listing)).toBe(3);
  });

  it('rejects a version that is not plain X.Y.Z', () => {
    expect(() => nextBetaBuild('0.4.7-beta.1', [])).toThrow(/plain X\.Y\.Z/);
  });
});

describe('resolveReleaseVersion', () => {
  it('stamps beta builds as <next>-beta.<number>', () => {
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
