/**
 * Install python/requirements.txt plus Kokoro TTS deps.
 * Python 3.10–3.12: kokoro/misaki from PyPI.
 * Python 3.13: PyPI wheels still cap at <3.13, so install misaki/kokoro from GitHub
 * with spacy>=3.8.14 preinstalled (cp313 wheels).
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const req = path.join(root, 'python', 'requirements.txt');
const reqKokoroPypi = path.join(root, 'python', 'requirements-kokoro-pypi.txt');

const MISAKI_GIT = 'git+https://github.com/hexgrad/misaki.git';
const KOKORO_GIT = 'git+https://github.com/hexgrad/kokoro.git';

function venvPython() {
  const unix = path.join(root, '.venv', 'bin', 'python');
  const win = path.join(root, '.venv', 'Scripts', 'python.exe');
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

function needsKokoroGitInstall(py) {
  const info = pythonVersionInfo(py);
  return info?.major === 3 && info.minor >= 13;
}

function findPython() {
  const fromEnv = process.env.PYTHON?.trim();
  if (fromEnv && versionOk(fromEnv)) return fromEnv;

  const vp = venvPython();
  if (vp && versionOk(vp)) return vp;

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

function pipWorks(py) {
  try {
    execFileSync(py, ['-m', 'pip', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runPip(py, args, label) {
  if (label) console.info(`[setup:python] ${label}`);
  const r = spawnSync(py, ['-m', 'pip', 'install', ...args], {
    stdio: 'inherit',
    cwd: root,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
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
      'Try: recreate the venv with pip — rm -rf .venv && python3 -m venv .venv',
      'On some distros you need python packages that ship ensurepip (e.g. Arch: extra/python).',
    ].join('\n'),
  );
  return false;
}

function installTorchCpu(py) {
  console.info('[setup:python] NEMO_PYTORCH_CPU: installing CPU-only PyTorch first…');
  runPip(
    py,
    ['torch', '--index-url', 'https://download.pytorch.org/whl/cpu'],
    null,
  );
}

/** Kokoro on Python 3.13+: PyPI misaki/kokoro still declare Requires-Python <3.13. */
function installKokoroFromGit(py) {
  console.info(
    '[setup:python] Python 3.13+: installing Kokoro stack from GitHub (PyPI wheels cap at <3.13)…',
  );
  runPip(py, ['spacy>=3.8.14'], 'spacy (cp313 wheels)');
  runPip(py, [MISAKI_GIT], 'misaki from GitHub');
  runPip(
    py,
    ['num2words', 'phonemizer-fork', 'espeakng-loader', 'attrs'],
    'misaki[en] runtime deps',
  );
  runPip(py, ['--no-deps', KOKORO_GIT], 'kokoro from GitHub');
  runPip(
    py,
    ['huggingface-hub', 'loguru', 'numpy', 'transformers'],
    'kokoro runtime deps',
  );
}

function installKokoroFromPypi(py) {
  runPip(py, ['-r', reqKokoroPypi], 'kokoro from PyPI');
}

function main() {
  const py = findPython();
  if (!py) {
    console.error(
      [
        'No Python 3.10–3.13 found.',
        'Install Python 3.10+ and create a venv, then reinstall:',
        '  python3 -m venv .venv && . .venv/bin/activate && npm run setup:python',
        'Or set PYTHON=/absolute/path/to/python3',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!ensurePip(py)) process.exit(1);

  const cpu =
    process.env.NEMO_PYTORCH_CPU === '1' ||
    process.env.NEMO_PYTORCH_CPU === 'true';

  if (cpu) installTorchCpu(py);

  runPip(py, ['-r', req], 'core requirements');

  if (needsKokoroGitInstall(py)) installKokoroFromGit(py);
  else installKokoroFromPypi(py);

  process.exit(0);
}

main();
