import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAllowedDownloadUrl, fetchPinned, type FetchLike } from './pinned-fetch';
import {
  assertInstallerIntact,
  downloadVerified,
  expectedInstallerFrom,
  parseUpdateInfoYaml,
  type ExpectedInstaller,
} from './verified-download';
import { compareSignatures, installerArgs } from './run-installer';

const PAYLOAD = Buffer.from('pretend this is an NSIS installer'.repeat(50));
const SHA512 = createHash('sha512').update(PAYLOAD).digest('base64');
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');
const ASSET = 'https://github.com/dpere122/ClaraCoder/releases/download/v0.2.0/Clara-Coder-0.2.0-Windows-x64.exe';
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=1';

const LATEST_YML = `version: 0.2.0
files:
  - url: Clara-Coder-0.2.0-Windows-x64.exe
    sha512: ${SHA512}
    size: ${PAYLOAD.length}
path: Clara-Coder-0.2.0-Windows-x64.exe
sha512: ${SHA512}
releaseDate: '2026-10-31T21:37:05.933Z'
`;

/** Fake fetch: github.com redirects to the CDN, the CDN serves `body`. */
function fakeFetch(body: Buffer, opts: { redirectTo?: string } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (url === ASSET) {
      return new Response(null, { status: 302, headers: { location: opts.redirectTo ?? CDN } });
    }
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const EXPECTED: ExpectedInstaller = { size: PAYLOAD.length, sha512: SHA512, sha256: SHA256 };

describe('parseUpdateInfoYaml / expectedInstallerFrom', () => {
  it('reads electron-builder latest.yml', () => {
    expect(parseUpdateInfoYaml(LATEST_YML)).toEqual({
      version: '0.2.0',
      files: [{ url: 'Clara-Coder-0.2.0-Windows-x64.exe', sha512: SHA512, size: PAYLOAD.length }],
    });
  });

  it('accepts matching metadata from latest.yml and the GitHub asset', () => {
    const info = parseUpdateInfoYaml(LATEST_YML);
    expect(
      expectedInstallerFrom(info, {
        version: '0.2.0',
        installer: { name: 'Clara-Coder-0.2.0-Windows-x64.exe', size: PAYLOAD.length, sha256: SHA256 },
      }),
    ).toEqual(EXPECTED);
  });

  it.each([
    ['another version', { version: '0.2.1' }, /not 0\.2\.1/],
    ['another file', { name: 'Other.exe' }, /does not list/],
    ['another size', { size: 1 }, /size mismatch/],
  ])('refuses latest.yml for %s', (_label, change, error) => {
    const info = parseUpdateInfoYaml(LATEST_YML);
    const installer = { name: 'Clara-Coder-0.2.0-Windows-x64.exe', size: PAYLOAD.length, sha256: SHA256, ...change };
    expect(() =>
      expectedInstallerFrom(info, { version: (change as { version?: string }).version ?? '0.2.0', installer }),
    ).toThrow(error);
  });
});

describe('pinned fetch', () => {
  it.each([
    'http://github.com/x',
    'https://evil.example/x',
    'https://github.com.evil.example/x',
    'https://user:pw@github.com/x',
    'https://github.com:8443/x',
    'file:///C:/Windows/notepad.exe',
  ])('refuses %s', (url) => {
    expect(() => assertAllowedDownloadUrl(url)).toThrow(/Refusing/);
  });

  it('follows a redirect to the GitHub asset CDN', async () => {
    const f = fakeFetch(PAYLOAD);
    const res = await fetchPinned(ASSET, { fetchImpl: f, userAgent: 'test' });
    expect(res.status).toBe(200);
    expect(f.calls).toEqual([ASSET, CDN]);
  });

  it('refuses a redirect that leaves GitHub', async () => {
    const f = fakeFetch(PAYLOAD, { redirectTo: 'https://evil.example/payload.exe' });
    await expect(fetchPinned(ASSET, { fetchImpl: f, userAgent: 'test' })).rejects.toThrow(/untrusted host evil\.example/);
    expect(f.calls).toEqual([ASSET]);
  });
});

describe('downloadVerified', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clara-updater-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the file only after size and both hashes match', async () => {
    const dest = path.join(dir, 'setup.exe');
    const progress: number[] = [];
    await downloadVerified({
      url: ASSET,
      dest,
      expected: EXPECTED,
      fetchImpl: fakeFetch(PAYLOAD),
      userAgent: 'test',
      onProgress: (received) => progress.push(received),
    });
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
    await expect(assertInstallerIntact(dest, EXPECTED)).resolves.toBeUndefined();
  });

  it('deletes a download whose bytes were tampered with', async () => {
    const dest = path.join(dir, 'setup.exe');
    const tampered = Buffer.from(PAYLOAD);
    tampered[10] = tampered[10]! ^ 0xff;
    await expect(
      downloadVerified({ url: ASSET, dest, expected: EXPECTED, fetchImpl: fakeFetch(tampered), userAgent: 'test' }),
    ).rejects.toThrow(/SHA-512 does not match/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('refuses when GitHub’s digest disagrees with latest.yml', async () => {
    const dest = path.join(dir, 'setup.exe');
    await expect(
      downloadVerified({
        url: ASSET,
        dest,
        expected: { ...EXPECTED, sha256: 'b'.repeat(64) },
        fetchImpl: fakeFetch(PAYLOAD),
        userAgent: 'test',
      }),
    ).rejects.toThrow(/SHA-256/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a response larger than the expected size', async () => {
    const dest = path.join(dir, 'setup.exe');
    await expect(
      downloadVerified({
        url: ASSET,
        dest,
        expected: { ...EXPECTED, size: PAYLOAD.length - 1 },
        fetchImpl: fakeFetch(PAYLOAD),
        userAgent: 'test',
      }),
    ).rejects.toThrow(/expected/);
  });

  it('catches an installer changed on disk after download', async () => {
    const dest = path.join(dir, 'setup.exe');
    writeFileSync(dest, Buffer.concat([PAYLOAD.subarray(0, -1), Buffer.from('X')]));
    await expect(assertInstallerIntact(dest, EXPECTED)).rejects.toThrow(/verification failed/);
  });
});

describe('installer hand-off', () => {
  it('only compares signatures when the running app is signed', () => {
    expect(compareSignatures({ status: 'NotSigned', subject: null }, { status: 'NotSigned', subject: null })).toBeNull();
    const app = { status: 'Valid', subject: 'CN=Clara Coder' };
    expect(compareSignatures(app, { status: 'Valid', subject: 'CN=Clara Coder' })).toBeNull();
    expect(compareSignatures(app, { status: 'NotSigned', subject: null })).toMatch(/NotSigned/);
    expect(compareSignatures(app, { status: 'Valid', subject: 'CN=Someone Else' })).toMatch(/different publisher/);
  });

  it('runs the NSIS installer silently, relaunching only for restart-and-install', () => {
    expect(installerArgs(true)).toEqual(['--updated', '/S', '--force-run']);
    expect(installerArgs(false)).toEqual(['--updated', '/S']);
  });
});
