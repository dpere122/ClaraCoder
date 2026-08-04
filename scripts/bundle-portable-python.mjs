/**
 * Fetch a pinned python-build-standalone CPython into runtime-bundle/python/
 * for electron-builder extraResources (and optional local testing).
 *
 * Skip download when the interpreter already exists unless --force is passed.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(root, 'runtime-bundle', 'python');
const force = process.argv.includes('--force');

/** Pinned: CPython 3.12.11 from python-build-standalone 20250630 (Kokoro-friendly). */
const RELEASE = '20250630';
const PY_VER = '3.12.11';

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
