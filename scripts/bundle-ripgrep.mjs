/**
 * Fetch a pinned ripgrep release into runtime-bundle/ripgrep/ for electron-builder
 * extraResources. The Python sidecar finds it through CLARA_RG_PATH and uses it for
 * `search_workspace` (gitignore-aware, parallel) instead of a system grep.
 *
 * Skip download when the binary already matches the pinned version unless --force is passed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256File } from './bundle-portable-python.mjs';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(root, 'runtime-bundle', 'ripgrep');
const force = process.argv.includes('--force');

export const RG_VERSION = '15.2.0';
const VERSION_FILE = '.clara-rg-version';

/** SHA256 from the release's per-asset .sha256 files — fail closed if download/cache mismatches. */
export const EXPECTED_RG_SHA256 = {
  'ripgrep-15.2.0-aarch64-apple-darwin.tar.gz':
    '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
  'ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz':
    'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d',
  'ripgrep-15.2.0-x86_64-apple-darwin.tar.gz':
    'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
  'ripgrep-15.2.0-x86_64-pc-windows-msvc.zip':
    '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
  'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz':
    '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
};

/** Release asset stem for this host (musl on x64 Linux: static, no glibc floor). */
export function rgAssetStem(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl`;
  if (platform === 'linux' && arch === 'arm64') return `ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu`;
  if (platform === 'darwin' && arch === 'x64') return `ripgrep-${RG_VERSION}-x86_64-apple-darwin`;
  if (platform === 'darwin' && arch === 'arm64') return `ripgrep-${RG_VERSION}-aarch64-apple-darwin`;
  if (platform === 'win32' && arch === 'x64') return `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc`;
  throw new Error(`Unsupported platform for ripgrep bundle: ${platform}/${arch}`);
}

function rgBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function log(msg) {
  console.info(`[bundle-rg] ${msg}`);
}

export async function verifyRgArchiveSha256(archive, asset) {
  const expected = EXPECTED_RG_SHA256[asset];
  if (!expected) {
    throw new Error(`[bundle-rg] No expected SHA256 for asset: ${asset}`);
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    throw new Error(`[bundle-rg] SHA256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function isCurrent() {
  try {
    return (
      existsSync(path.join(outDir, rgBinaryName())) &&
      readFileSync(path.join(outDir, VERSION_FILE), 'utf8').trim() === RG_VERSION
    );
  } catch {
    return false;
  }
}

async function main() {
  if (!force && isCurrent()) {
    log(`ripgrep ${RG_VERSION} already present`);
    return;
  }

  const stem = rgAssetStem();
  const asset = `${stem}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${asset}`;
  const cacheDir = path.join(root, 'runtime-bundle', '.cache');
  const archive = path.join(cacheDir, asset);

  if (force || !existsSync(archive)) {
    log(`Fetching ${url}`);
    await download(url, archive);
  } else {
    log('Using cached archive');
  }
  await verifyRgArchiveSha256(archive, asset);
  log('Archive SHA256 verified');

  const staging = path.join(cacheDir, `${stem}-extract`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  // Windows ships bsdtar (reads .zip); name it so a GNU tar earlier on PATH (Git Bash) cannot win.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const r = spawnSync(tar, ['-xf', archive, '-C', staging], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`[bundle-rg] tar extract failed for ${archive}`);
  }

  const binary = rgBinaryName();
  const extracted = path.join(staging, stem, binary);
  if (!existsSync(extracted)) {
    throw new Error(`[bundle-rg] Expected binary missing after extract: ${extracted}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(extracted, path.join(outDir, binary));
  for (const license of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
    const src = path.join(staging, stem, license);
    if (existsSync(src)) copyFileSync(src, path.join(outDir, license));
  }
  if (process.platform !== 'win32') {
    chmodSync(path.join(outDir, binary), 0o755);
  }
  writeFileSync(path.join(outDir, VERSION_FILE), `${RG_VERSION}\n`, 'utf8');
  rmSync(staging, { recursive: true, force: true });
  log(`Ready: ${path.join(outDir, binary)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
