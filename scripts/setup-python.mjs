/**
 * Create repo-root `.venv` if missing, then install python/requirements.txt,
 * PyTorch, and Kokoro TTS.
 *
 * Kokoro: try PyPI first; if that interpreter cannot install it (today: Python
 * 3.13+, where PyPI still declares Requires-Python <3.13), fall back to GitHub
 * (misaki/kokoro) with spacy>=3.8.14.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const venvDir = path.join(root, '.venv');
const req = path.join(root, 'python', 'requirements.txt');
const reqKokoroPypi = path.join(root, 'python', 'requirements-kokoro-pypi.txt');

// Pin to commit SHAs (no tags published) — never float on git+https HEAD.
const MISAKI_GIT =
  'git+https://github.com/hexgrad/misaki.git@fba1236595f2d2bf21d414ba6e57d25256afada3';
const KOKORO_GIT =
  'git+https://github.com/hexgrad/kokoro.git@dfb907a02bba8152ca444717ca5d78747ccb4bec';

function venvPython() {
  const unix = path.join(venvDir, 'bin', 'python');
  const win = path.join(venvDir, 'Scripts', 'python.exe');
  if (existsSync(unix)) return unix;
  if (existsSync(win)) return win;
  return null;
}

function pythonVersionInfo(py) {
  try {
    const out = execFileSync(
      py,
      ['-c', 'import sys; print(sys.version_info[:2])'],
      { encoding: 'utf8' },
    ).trim();
    const [major, minor] = out.replace(/[()]/g, '').split(',').map((s) => Number(s.trim()));
    return { major, minor };
  } catch {
    return null;
  }
}

function versionOk(py) {
  const info = pythonVersionInfo(py);
  if (!info) return false;
  const { major, minor } = info;
  return major === 3 && minor >= 10 && minor <= 13;
}

function envFlag(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v === '1' || v === 'true') return true;
  }
  return false;
}

function findBasePython() {
  const fromEnv = process.env.PYTHON?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      console.error(`[setup:python] PYTHON path does not exist: ${fromEnv}`);
    } else if (versionOk(fromEnv)) {
      return fromEnv;
    }
  }

  const candidates = [
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
    'python',
  ];
  for (const cmd of candidates) {
    if (versionOk(cmd)) return cmd;
  }
  return null;
}

function createVenv(basePy) {
  console.info(`[setup:python] Creating ${venvDir} with ${basePy}…`);
  const r = spawnSync(basePy, ['-m', 'venv', venvDir], {
    stdio: 'inherit',
    cwd: root,
  });
  if (r.status !== 0) {
    console.error(
      [
        'Failed to create .venv.',
        'On Debian/Ubuntu install python3-venv (or python3.XX-venv), then re-run:',
        '  npm run setup:python',
      ].join('\n'),
    );
    process.exit(r.status ?? 1);
  }
  const py = venvPython();
  if (!py || !versionOk(py)) {
    console.error('Created .venv but could not find a usable python inside it.');
    process.exit(1);
  }
  return py;
}

/** Prefer existing root `.venv`; otherwise create it from PYTHON / system Python. */
function ensureVenvPython() {
  const existing = venvPython();
  if (existing && versionOk(existing)) {
    console.info(`[setup:python] Using ${existing}`);
    return existing;
  }

  const base = findBasePython();
  if (!base) {
    console.error(
      [
        'No Python 3.10–3.13 found.',
        'Install Python 3.10+ (with venv/ensurepip), then re-run:',
        '  npm run setup:python',
        'Or set PYTHON=/absolute/path/to/python3',
      ].join('\n'),
    );
    process.exit(1);
  }

  return createVenv(base);
}

function pipWorks(py) {
  try {
    execFileSync(py, ['-m', 'pip', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runPip(py, args, label, { inherit = true } = {}) {
  if (label) console.info(`[setup:python] ${label}`);
  const r = spawnSync(py, ['-m', 'pip', 'install', ...args], {
    stdio: inherit ? 'inherit' : 'pipe',
    cwd: root,
    encoding: 'utf8',
  });
  return r.status ?? 1;
}

function runPipOrExit(py, args, label) {
  const status = runPip(py, args, label);
  if (status !== 0) process.exit(status);
}

/** Venvs built with --without-pip or minimal Pythons may lack pip until ensurepip runs. */
function ensurePip(py) {
  if (pipWorks(py)) return true;

  console.info('[setup:python] Bootstrapping pip (ensurepip)…');
  let r = spawnSync(py, ['-m', 'ensurepip', '--upgrade'], {
    stdio: 'inherit',
    cwd: root,
  });
  if (r.status === 0 && pipWorks(py)) return true;

  r = spawnSync(py, ['-m', 'ensurepip', '--upgrade', '--default-pip'], {
    stdio: 'inherit',
    cwd: root,
  });
  if (r.status === 0 && pipWorks(py)) return true;

  console.error(
    [
      'Could not install pip into this Python (ensurepip failed or pip still missing).',
      'Try: rm -rf .venv && npm run setup:python',
      'On some distros you need python packages that ship ensurepip (e.g. Arch: extra/python).',
    ].join('\n'),
  );
  return false;
}

function installTorchCpu(py) {
  console.info('[setup:python] CPU-only PyTorch (CLARA_PYTORCH_CPU / setup:python:cpu)…');
  runPipOrExit(
    py,
    ['torch', '--index-url', 'https://download.pytorch.org/whl/cpu'],
    null,
  );
}

function installTorchCuda(py) {
  console.info('[setup:python] Installing CUDA PyTorch (cu129) for GPU Kokoro TTS…');
  runPipOrExit(
    py,
    ['torch', '--index-url', 'https://download.pytorch.org/whl/cu129'],
    null,
  );
}

/** GitHub path when PyPI cannot install kokoro for this interpreter. */
function installKokoroFromGit(py) {
  console.info(
    '[setup:python] Installing Kokoro from GitHub (PyPI not usable for this Python)…',
  );
  runPipOrExit(py, ['spacy>=3.8.14'], 'spacy (cp313 wheels)');
  runPipOrExit(py, [MISAKI_GIT], 'misaki from GitHub');
  runPipOrExit(
    py,
    ['num2words', 'phonemizer-fork', 'espeakng-loader', 'attrs'],
    'misaki[en] runtime deps',
  );
  runPipOrExit(py, ['--no-deps', KOKORO_GIT], 'kokoro from GitHub');
  runPipOrExit(
    py,
    ['huggingface-hub', 'loguru', 'numpy', 'transformers'],
    'kokoro runtime deps',
  );
}

/**
 * One Kokoro install path: PyPI when possible, GitHub fallback otherwise.
 * Skips a doomed PyPI attempt on Python 3.13+ (Requires-Python <3.13 today).
 */
function installKokoro(py) {
  const info = pythonVersionInfo(py);
  const skipPypi = info?.major === 3 && info.minor >= 13;

  if (!skipPypi) {
    const status = runPip(py, ['-r', reqKokoroPypi], 'kokoro from PyPI');
    if (status === 0) return;
    console.info('[setup:python] PyPI Kokoro install failed; trying GitHub fallback…');
  }

  installKokoroFromGit(py);
}

function main() {
  const py = ensureVenvPython();
  if (!ensurePip(py)) process.exit(1);

  const cpu = envFlag('CLARA_PYTORCH_CPU', 'NEMO_PYTORCH_CPU');

  if (cpu) installTorchCpu(py);
  else installTorchCuda(py);

  runPipOrExit(py, ['-r', req], 'core requirements');
  installKokoro(py);

  console.info(`[setup:python] Done. Interpreter: ${py}`);
  process.exit(0);
}

main();
