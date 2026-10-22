/**
 * Post-pack checks for the electron-builder unpacked tree: bundled CPython,
 * runtime manifest, backend sources, and vtsls entry.
 *
 * Usage:
 *   node scripts/verify-packed-runtime.mjs
 *   node scripts/verify-packed-runtime.mjs --out <electron-builder output dir>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_OUT = path.join(root, 'release');

function log(msg) {
  console.info(`[verify-packed] ${msg}`);
}

function parseOutDir(argv, fallback) {
  const i = argv.indexOf('--out');
  if (i !== -1 && argv[i + 1]) {
    return path.resolve(argv[i + 1]);
  }
  return fallback;
}

function findDarwinResources(outDir) {
  const found = [];
  if (!existsSync(outDir)) return found;
  for (const ent of readdirSync(outDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ent.name.startsWith('mac')) continue;
    const macDir = path.join(outDir, ent.name);
    let apps;
    try {
      apps = readdirSync(macDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const app of apps) {
      if (!app.isDirectory() || !app.name.endsWith('.app')) continue;
      const resources = path.join(macDir, app.name, 'Contents', 'Resources');
      if (existsSync(resources)) found.push(resources);
    }
  }
  return found;
}

function findUnpackedResources(outDir) {
  if (process.platform === 'win32') {
    const p = path.join(outDir, 'win-unpacked', 'resources');
    return existsSync(p) ? [p] : [];
  }
  if (process.platform === 'linux') {
    const p = path.join(outDir, 'linux-unpacked', 'resources');
    return existsSync(p) ? [p] : [];
  }
  if (process.platform === 'darwin') {
    return findDarwinResources(outDir);
  }
  return [];
}

function packedInterpreter(resourcesDir) {
  if (process.platform === 'win32') {
    return path.join(resourcesDir, 'runtime-python', 'python.exe');
  }
  return path.join(resourcesDir, 'runtime-python', 'bin', 'python3');
}

function stderrTail(text, max = 2000) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(-max);
}

function checkResourcesDir(resourcesDir, failures) {
  const pythonExe = packedInterpreter(resourcesDir);
  if (!existsSync(pythonExe)) {
    failures.push(`missing packed interpreter: ${pythonExe}`);
  }

  const manifestFile = path.join(resourcesDir, 'runtime-python', '.clara-runtime-manifest.json');
  let manifest = null;
  if (!existsSync(manifestFile)) {
    failures.push(`missing runtime manifest: ${manifestFile}`);
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      log(`manifest pythonVersion=${manifest.pythonVersion} requirementsSource=${manifest.requirementsSource}`);
    } catch (err) {
      failures.push(`manifest parse failed: ${manifestFile}: ${err.message || err}`);
    }
  }

  const serverPy = path.join(resourcesDir, 'python', 'server.py');
  if (!existsSync(serverPy)) {
    failures.push(`missing backend entry: ${serverPy}`);
  }
  const reqTxt = path.join(resourcesDir, 'python', 'requirements.txt');
  if (!existsSync(reqTxt)) {
    failures.push(`missing requirements.txt: ${reqTxt}`);
  }

  const vtsls = path.join(
    resourcesDir,
    'vtsls',
    'node_modules',
    '@vtsls',
    'language-server',
    'bin',
    'vtsls.js',
  );
  if (!existsSync(vtsls)) {
    failures.push(`missing vtsls entry: ${vtsls}`);
  }

  const rg = path.join(resourcesDir, 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg');
  if (!existsSync(rg)) {
    failures.push(`missing ripgrep binary: ${rg}`);
  }

  if (
    manifest &&
    manifest.arch === process.arch &&
    manifest.platform === process.platform
  ) {
    if (existsSync(pythonExe)) {
      const r = spawnSync(pythonExe, ['-I', '-c', "import fastapi, uvicorn; print('ok')"], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      if (r.status !== 0) {
        const tail = stderrTail(r.stderr || r.stdout || r.error?.message);
        failures.push(
          `packed interpreter import smoke failed (exit ${r.status ?? r.error?.code}): ${tail}`,
        );
      }
    }
  } else if (manifest) {
    log(
      `import smoke skipped (cross-arch: manifest ${manifest.platform}/${manifest.arch} vs host ${process.platform}/${process.arch})`,
    );
  }
}

export async function verifyPackedRuntime(outDir) {
  const resourcesDirs = findUnpackedResources(outDir);
  if (!resourcesDirs.length) {
    throw new Error(
      `[verify-packed] no unpacked dir found under ${outDir} ` +
        `(expected win-unpacked/resources, linux-unpacked/resources, or mac*/*.app/Contents/Resources)`,
    );
  }

  const failures = [];
  const okDirs = [];
  for (const resourcesDir of resourcesDirs) {
    const before = failures.length;
    checkResourcesDir(resourcesDir, failures);
    if (failures.length === before) {
      okDirs.push(resourcesDir);
    }
  }

  if (failures.length) {
    for (const f of failures) {
      console.error(`[verify-packed] FAIL ${f}`);
    }
    throw new Error(`[verify-packed] ${failures.length} check(s) failed`);
  }

  for (const resourcesDir of okDirs) {
    log(`OK ${resourcesDir}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = parseOutDir(process.argv.slice(2), DEFAULT_OUT);
  verifyPackedRuntime(outDir).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
