/**
 * Tests for security/scripts-supply-chain — exact-semver pinning and
 * SHA256 verification of downloaded portable Python.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXACT_SEMVER } from './assemble-vtsls-bundle.mjs';
import { EXPECTED_SHA256, sha256File, verifyArchiveSha256 } from './bundle-portable-python.mjs';
import { EXPECTED_RG_SHA256, RG_VERSION, rgAssetStem, verifyRgArchiveSha256 } from './bundle-ripgrep.mjs';

describe('EXACT_SEMVER (vtsls version pin)', () => {
  it.each(['0.3.0', '1.2.3', '0.3.0-beta.1', '10.20.30-rc.4'])(
    'accepts exact semver: %s',
    (v) => {
      expect(EXACT_SEMVER.test(v)).toBe(true);
    },
  );

  it.each([
    'latest',
    'next',
    'beta',
    '^1.2.3',
    '~1.2.3',
    '>=0.3.0',
    '0.3.x',
    '*',
    '0.3',
    '',
  ])('rejects dist-tags / ranges / partial: %s', (v) => {
    expect(EXACT_SEMVER.test(v)).toBe(false);
  });
});

describe('EXPECTED_SHA256 (portable Python assets)', () => {
  it('has an entry for every supported platform asset', () => {
    expect(Object.keys(EXPECTED_SHA256).length).toBeGreaterThanOrEqual(5);
  });

  it.each(Object.keys(EXPECTED_SHA256))('is a 64-char hex digest: %s', (asset) => {
    expect(EXPECTED_SHA256[asset]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('EXPECTED_RG_SHA256 (bundled ripgrep assets)', () => {
  it.each(['win32/x64', 'linux/x64', 'linux/arm64', 'darwin/x64', 'darwin/arm64'])(
    'pins a digest for every supported host: %s',
    (host) => {
      const [platform, arch] = host.split('/');
      const ext = platform === 'win32' ? '.zip' : '.tar.gz';
      const asset = `${rgAssetStem(platform, arch)}${ext}`;
      expect(asset).toContain(RG_VERSION);
      expect(EXPECTED_RG_SHA256[asset]).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it('verifyRgArchiveSha256 throws on a mismatch', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'clara-rg-sha-'));
    try {
      const file = path.join(tmp, 'rg.zip');
      writeFileSync(file, 'not ripgrep');
      await expect(
        verifyRgArchiveSha256(file, `${rgAssetStem('win32', 'x64')}.zip`),
      ).rejects.toThrow(/SHA256 mismatch/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('sha256File / verifyArchiveSha256', () => {
  let tmp = '';
  let file = '';
  let tempKey: string | undefined;
  const content = 'not a real tarball, just test bytes';

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'clara-sha-'));
    file = path.join(tmp, 'archive.tar.gz');
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (tempKey && tempKey in EXPECTED_SHA256) {
      delete EXPECTED_SHA256[tempKey];
      tempKey = undefined;
    }
  });

  it('sha256File matches node crypto for the same bytes', async () => {
    writeFileSync(file, content);
    const got = await sha256File(file);
    expect(got).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('verifyArchiveSha256 throws on an unknown asset', async () => {
    writeFileSync(file, content);
    await expect(verifyArchiveSha256(file, 'not-a-real-asset')).rejects.toThrow(
      /No expected SHA256/,
    );
  });

  it('verifyArchiveSha256 throws on a mismatch', async () => {
    writeFileSync(file, content);
    await expect(verifyArchiveSha256(file, 'cpython-3.12.11+20250630-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz')).rejects.toThrow(
      /SHA256 mismatch/,
    );
  });

  it('verifyArchiveSha256 passes when the file hash matches the expected entry', async () => {
    writeFileSync(file, content);
    const hash = createHash('sha256').update(content).digest('hex');
    tempKey = 'test-asset-matches.tar.gz';
    EXPECTED_SHA256[tempKey] = hash;
    await expect(verifyArchiveSha256(file, tempKey)).resolves.toBeUndefined();
  });
});
