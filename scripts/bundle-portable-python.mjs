/**
 * Fetch a pinned python-build-standalone CPython into runtime-bundle/python/
 * for electron-builder extraResources (and optional local testing).
 *
 * Skip download when the interpreter already exists unless --force is passed.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(root, 'runtime-bundle', 'python');
const force = process.argv.includes('--force');

/** Pinned: CPython 3.12.11 from python-build-standalone 20250630 (Kokoro-friendly). */
const RELEASE = '20250630';
const PY_VER = '3.12.11';

/** SHA256 from release SHA256SUMS — fail closed if download/cache mismatches. */
export const EXPECTED_SHA256 = {
  'cpython-3.12.11+20250630-aarch64-apple-darwin-install_only_stripped.tar.gz':
    '52f103b1bae4105c8c3ba415fbfb992fc80672795c58262b96719efde97c49d9',
  'cpython-3.12.11+20250630-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz':
    '117b1d2daa96486005827dd50029fecd61e99141396583ea8e57733f7cf0abad',
  'cpython-3.12.11+20250630-x86_64-apple-darwin-install_only_stripped.tar.gz':
    '5e7229d72ec588b77f753ee043fcefe62f89190e84b8b43d20b1be4b4e6e8540',
  'cpython-3.12.11+20250630-x86_64-pc-windows-msvc-install_only_stripped.tar.gz':
    '91f7196d5d103eb3d1214f74606144adb326f0770d80c636cb11b96670477736',
  'cpython-3.12.11+20250630-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz':
    '358ad7bf46260a2e1b31726adc62dc04258c7ea7469352e155ffdea0f168499e',
};

function targetTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported platform for portable Python bundle: ${platform}/${arch}`);
}

function pythonMarkerPath() {
  if (process.platform === 'win32') {
    return path.join(outDir, 'python.exe');
  }
  return path.join(outDir, 'bin', 'python3');
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function verifyArchiveSha256(archive, asset) {
  const expected = EXPECTED_SHA256[asset];
  if (!expected) {
    throw new Error(`[bundle-python] No expected SHA256 for asset: ${asset}`);
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    throw new Error(
      `[bundle-python] SHA256 mismatch for ${asset}: expected ${expected}, got ${actual}`,
    );
  }
}

function extractTarGz(archive, dest) {
  mkdirSync(dest, { recursive: true });
  // Prefer system tar (handles strip consistently).
  const r = spawnSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`tar extract failed for ${archive}`);
  }
}

async function main() {
  const marker = pythonMarkerPath();
  if (!force && existsSync(marker)) {
    console.info(`[bundle-python] Already present: ${marker}`);
    return;
  }

  const triple = targetTriple();
  const asset = `cpython-${PY_VER}+${RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${asset}`;
  const cacheDir = path.join(root, 'runtime-bundle', '.cache');
  const archive = path.join(cacheDir, asset);

  console.info(`[bundle-python] Fetching ${url}`);
  if (force || !existsSync(archive)) {
    await download(url, archive);
  }

  await verifyArchiveSha256(archive, asset);

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  console.info(`[bundle-python] Extracting into ${outDir}`);
  extractTarGz(archive, outDir);

  if (!existsSync(marker)) {
    throw new Error(`[bundle-python] Expected interpreter missing after extract: ${marker}`);
  }
  console.info(`[bundle-python] Ready: ${marker}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
