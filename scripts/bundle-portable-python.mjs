/**
 * Fetch a pinned python-build-standalone CPython into runtime-bundle/python/
 * for electron-builder extraResources (and optional local testing), then install
 * python/requirements.txt into that interpreter and write a runtime manifest.
 *
 * Skip download when the interpreter already exists unless --force is passed.
 * Skip reinstall when the manifest hash matches unless --force is passed.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(root, 'runtime-bundle', 'python');
const force = process.argv.includes('--force');
const writeLock = process.argv.includes('--write-lock');

/** Pinned: CPython 3.12.11 from python-build-standalone 20250630 (Kokoro-friendly). */
const RELEASE = '20250630';
const PY_VER = '3.12.11';
const MANIFEST_NAME = '.clara-runtime-manifest.json';

const CORE_SMOKE_IMPORTS =
  'import fastapi, uvicorn, langchain, langgraph, onnxruntime, fastembed, basedpyright, black; print(\'ok\')';

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

function pyMajorMinor() {
  const [major, minor] = PY_VER.split('.');
  return `${major}.${minor}`;
}

/** Interpreter path for both PBS layouts (win: python.exe; posix: bin/python3). */
export function interpreterPath(bundleRoot = outDir) {
  if (process.platform === 'win32') {
    return path.join(bundleRoot, 'python.exe');
  }
  return path.join(bundleRoot, 'bin', 'python3');
}

function pythonMarkerPath() {
  return interpreterPath(outDir);
}

function pythonLibDir(bundleRoot = outDir) {
  if (process.platform === 'win32') {
    return path.join(bundleRoot, 'Lib');
  }
  return path.join(bundleRoot, 'lib', `python${pyMajorMinor()}`);
}

function manifestPath(bundleRoot = outDir) {
  return path.join(bundleRoot, MANIFEST_NAME);
}

function log(msg) {
  console.info(`[bundle-python] ${msg}`);
}

function warn(msg) {
  console.warn(`[bundle-python] ${msg}`);
}

function elapsedSeconds(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

function logDone(stage, started) {
  log(`${stage} (${elapsedSeconds(started)}s)`);
}

function pipEnv() {
  return {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

function runPython(pythonExe, args, options = {}) {
  return spawnSync(pythonExe, args, {
    stdio: 'inherit',
    env: pipEnv(),
    ...options,
  });
}

/** python/requirements.lock if present, otherwise python/requirements.txt. */
export function requirementsSourceFile() {
  const lock = path.join(root, 'python', 'requirements.lock');
  if (existsSync(lock)) return lock;
  return path.join(root, 'python', 'requirements.txt');
}

export function requirementsSourceName() {
  return path.basename(requirementsSourceFile());
}

/** SHA256 of the bytes of python/<requirementsSource>. */
export function requirementsSha256() {
  const file = requirementsSourceFile();
  if (!existsSync(file)) {
    throw new Error(`[bundle-python] Requirements file missing: ${file}`);
  }
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Minimal PEP-style checker: comma-separated >=, <=, >, <, ==, != against X.Y(.Z). */
export function satisfiesRequiresPython(version, spec) {
  const parts = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return true;
  for (const part of parts) {
    const m = part.match(/^(>=|<=|!=|==|>|<)\s*(\d+(?:\.\d+)*)$/);
    if (!m) {
      throw new Error(`[bundle-python] Unsupported requires-python specifier: ${part}`);
    }
    const [, op, rhs] = m;
    const c = compareVersions(version, rhs);
    const ok =
      (op === '>=' && c >= 0) ||
      (op === '<=' && c <= 0) ||
      (op === '>' && c > 0) ||
      (op === '<' && c < 0) ||
      (op === '==' && c === 0) ||
      (op === '!=' && c !== 0);
    if (!ok) return false;
  }
  return true;
}

/**
 * Parse `requires-python = "..."` from python/pyproject.toml [project].
 * Throws if PY_VER does not satisfy the specifier. Warns if the field is absent.
 */
export function readRequiresPython() {
  const tomlPath = path.join(root, 'python', 'pyproject.toml');
  if (!existsSync(tomlPath)) {
    warn(`python/pyproject.toml missing; skipping requires-python check`);
    return null;
  }
  const text = readFileSync(tomlPath, 'utf8');
  const m = text.match(/requires-python\s*=\s*"([^"]+)"/);
  if (!m) {
    warn('requires-python not found in python/pyproject.toml; continuing');
    return null;
  }
  const spec = m[1].trim();
  if (!satisfiesRequiresPython(PY_VER, spec)) {
    throw new Error(
      `[bundle-python] CPython ${PY_VER} does not satisfy requires-python "${spec}"`,
    );
  }
  log(`requires-python "${spec}" satisfied by CPython ${PY_VER}`);
  return spec;
}

export function installCorePackages(pythonExe) {
  const started = Date.now();
  log('Upgrading pip …');
  const upgrade = runPython(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  if (upgrade.status !== 0) {
    throw new Error(`[bundle-python] pip upgrade failed (exit ${upgrade.status})`);
  }

  const reqTxt = path.join(root, 'python', 'requirements.txt');
  const lock = path.join(root, 'python', 'requirements.lock');
  const args = ['-m', 'pip', 'install', '--no-cache-dir', '-r', reqTxt];
  if (existsSync(lock)) {
    args.push('-c', lock);
  }
  log(`Installing ${path.relative(root, reqTxt)}${existsSync(lock) ? ' (constrained by requirements.lock)' : ''} …`);
  const install = runPython(pythonExe, args);
  if (install.status !== 0) {
    throw new Error(`[bundle-python] pip install -r requirements.txt failed (exit ${install.status})`);
  }
  logDone('Installed core packages', started);
}

function writeRequirementsLock(pythonExe) {
  const started = Date.now();
  log('Freezing python/requirements.lock …');
  const r = spawnSync(pythonExe, ['-m', 'pip', 'freeze', '--exclude-editable'], {
    encoding: 'utf8',
    env: pipEnv(),
  });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.stdout || '').trim();
    throw new Error(`[bundle-python] pip freeze failed (exit ${r.status})${tail ? `: ${tail}` : ''}`);
  }
  const header =
    `# Generated by scripts/bundle-portable-python.mjs --write-lock (CPython ${PY_VER}, ${process.platform}-${process.arch}); do not edit by hand.\n`;
  const body = String(r.stdout ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/u, '');
  const text = body ? `${header}${body}\n` : header;
  writeFileSync(path.join(root, 'python', 'requirements.lock'), text, 'utf8');
  logDone('Wrote python/requirements.lock', started);
}

export function compileBytecode(pythonExe) {
  const started = Date.now();
  const libdir = pythonLibDir();
  log(`Compiling bytecode in ${libdir} …`);
  const r = runPython(pythonExe, ['-m', 'compileall', '-q', '-j', '0', libdir]);
  if (r.status !== 0) {
    warn(`compileall exited ${r.status} (some vendored files fail to compile; continuing)`);
  }
  logDone('Bytecode compile finished', started);
}

export function smokeImport(pythonExe) {
  const started = Date.now();
  log('Smoke-importing core packages …');
  const r = runPython(pythonExe, ['-I', '-c', CORE_SMOKE_IMPORTS]);
  if (r.status !== 0) {
    throw new Error(`[bundle-python] smoke import failed (exit ${r.status})`);
  }
  logDone('Smoke import ok', started);
}

export function writeManifest() {
  const started = Date.now();
  const manifest = {
    schemaVersion: 1,
    pythonVersion: PY_VER,
    pbsRelease: RELEASE,
    requirementsSource: requirementsSourceName(),
    requirementsSha256: requirementsSha256(),
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
  };
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  logDone(`Wrote ${MANIFEST_NAME}`, started);
  return manifest;
}

function readManifest() {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function manifestIsCurrent(manifest) {
  return (
    manifest &&
    manifest.requirementsSha256 === requirementsSha256() &&
    manifest.pythonVersion === PY_VER
  );
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

function finishExistingInterpreter(pythonExe) {
  installCorePackages(pythonExe);
  if (writeLock) {
    writeRequirementsLock(pythonExe);
  }
  compileBytecode(pythonExe);
  smokeImport(pythonExe);
  writeManifest();
}

async function extractFreshInterpreter() {
  const triple = targetTriple();
  const asset = `cpython-${PY_VER}+${RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${asset}`;
  const cacheDir = path.join(root, 'runtime-bundle', '.cache');
  const archive = path.join(cacheDir, asset);

  log(`Fetching ${url}`);
  const dlStarted = Date.now();
  if (force || !existsSync(archive)) {
    await download(url, archive);
    logDone('Download finished', dlStarted);
  } else {
    log(`Using cached archive (${elapsedSeconds(dlStarted)}s)`);
  }

  const verifyStarted = Date.now();
  await verifyArchiveSha256(archive, asset);
  logDone('Archive SHA256 verified', verifyStarted);

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  const extractStarted = Date.now();
  log(`Extracting into ${outDir}`);
  extractTarGz(archive, outDir);
  logDone('Extract finished', extractStarted);

  const marker = pythonMarkerPath();
  if (!existsSync(marker)) {
    throw new Error(`[bundle-python] Expected interpreter missing after extract: ${marker}`);
  }
  return marker;
}

async function main() {
  const t0 = Date.now();
  const marker = pythonMarkerPath();
  readRequiresPython();

  if (!force && existsSync(marker)) {
    const manifest = readManifest();
    if (manifestIsCurrent(manifest)) {
      log('Already present and up to date');
      if (writeLock) {
        writeRequirementsLock(marker);
        // Lock bytes changed → keep the manifest hash in sync so the next run skips.
        writeManifest();
      }
      logDone('Done', t0);
      return;
    }
    if (!manifest) {
      log('Interpreter present but manifest missing; installing packages into existing bundle');
    } else {
      log('Interpreter present but requirements hash/version mismatch; reinstalling packages');
    }
    finishExistingInterpreter(marker);
    log(`Ready: ${marker}`);
    logDone('Done', t0);
    return;
  }

  const pythonExe = await extractFreshInterpreter();
  finishExistingInterpreter(pythonExe);
  log(`Ready: ${pythonExe}`);
  logDone('Done', t0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
