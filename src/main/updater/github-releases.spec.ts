import { describe, expect, it } from 'vitest';
import { parseGithubReleases, releaseAssetUrl } from './github-releases';

const WIN = { platform: 'win32' as const, arch: 'x64' };
const SHA256 = 'a'.repeat(64);

function apiRelease(tag: string, extra: Record<string, unknown> = {}) {
  const version = tag.replace(/^v/, '');
  return {
    tag_name: tag,
    name: `Clara Coder ${version}`,
    body: '## What changed\n* fix',
    draft: false,
    prerelease: version.includes('-'),
    published_at: '2026-10-30T12:00:00Z',
    html_url: 'https://evil.example/not-used',
    assets: [
      { name: `Clara-Coder-${version}-Windows-x64.exe`, size: 1000, state: 'uploaded', digest: `sha256:${SHA256}` },
      { name: `Clara-Coder-${version}-Windows-x64.exe.blockmap`, size: 10, state: 'uploaded' },
      { name: 'latest.yml', size: 300, state: 'uploaded' },
    ],
    ...extra,
  };
}

describe('parseGithubReleases', () => {
  it('keeps the platform installer and latest.yml of each release', () => {
    const [r] = parseGithubReleases([apiRelease('v0.2.0')], WIN);
    expect(r!.summary).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      name: 'Clara Coder 0.2.0',
      prerelease: false,
      htmlUrl: 'https://github.com/dpere122/ClaraCoder/releases/tag/v0.2.0',
      installer: { fileName: 'Clara-Coder-0.2.0-Windows-x64.exe', size: 1000 },
    });
    expect(r!.installer).toEqual({ name: 'Clara-Coder-0.2.0-Windows-x64.exe', size: 1000, sha256: SHA256 });
    expect(r!.updateInfo?.name).toBe('latest.yml');
  });

  it('drops drafts and tags that are not versions', () => {
    const out = parseGithubReleases(
      [apiRelease('dev'), apiRelease('v0.3.0', { draft: true }), apiRelease('v0.2.0-beta.4')],
      WIN,
    );
    expect(out.map((r) => r.summary.version)).toEqual(['0.2.0-beta.4']);
    expect(out[0]!.summary.prerelease).toBe(true);
  });

  it('marks a semver pre-release tag as beta even if GitHub has it as a full release', () => {
    const [r] = parseGithubReleases([apiRelease('v0.2.0-beta.1', { prerelease: false })], WIN);
    expect(r!.summary.prerelease).toBe(true);
  });

  it('lists a release without update metadata but offers no installer', () => {
    const rel = apiRelease('v0.1.1');
    rel.assets = rel.assets.filter((a) => a.name !== 'latest.yml');
    const [r] = parseGithubReleases([rel], WIN);
    expect(r!.summary.installer).toBeNull();
    expect(r!.installer).toBeNull();
  });

  it('ignores assets that are still uploading and malformed digests', () => {
    const rel = apiRelease('v0.2.0');
    rel.assets[0] = { ...rel.assets[0]!, digest: 'sha256:xyz' };
    rel.assets[2] = { ...rel.assets[2]!, state: 'starter' };
    const [r] = parseGithubReleases([rel], WIN);
    expect(r!.installer).toBeNull();
  });

  it('offers no installer on platforms without one', () => {
    const [r] = parseGithubReleases([apiRelease('v0.2.0')], { platform: 'linux', arch: 'x64' });
    expect(r!.summary.installer).toBeNull();
  });

  it('rejects a non-array payload', () => {
    expect(() => parseGithubReleases({ message: 'Not Found' }, WIN)).toThrow(/unexpected/);
  });
});

describe('releaseAssetUrl', () => {
  it('builds the download URL from the pinned repo, encoding tag and name', () => {
    expect(releaseAssetUrl('v0.2.0', 'Clara-Coder-0.2.0-Windows-x64.exe')).toBe(
      'https://github.com/dpere122/ClaraCoder/releases/download/v0.2.0/Clara-Coder-0.2.0-Windows-x64.exe',
    );
    expect(releaseAssetUrl('v1/../x', 'a b')).toBe('https://github.com/dpere122/ClaraCoder/releases/download/v1%2F..%2Fx/a%20b');
  });
});
