/**
 * Install python/requirements.txt using Python 3.10–3.12.
 * Kokoro/misaki wheels declare Requires-Python <3.13, so 3.13+ cannot resolve deps.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const req = path.join(root, 'python', 'requirements.txt');

function venvPython() {
  const unix = path.join(root, '.venv', 'bin', 'python');
  const win = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (existsSync(unix)) return unix;
  if (existsSync(win)) return win;
  return null;
}

function versionOk(py) {
  try {
    execFileSync(
      py,
      [
        '-c',
        'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 13) else 1)',
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  const fromEnv = process.env.PYTHON?.trim();
  if (fromEnv && versionOk(fromEnv)) return fromEnv;

  const vp = venvPython();
  if (vp && versionOk(vp)) return vp;

  const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
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
      'Try: recreate the venv with pip — rm -rf .venv && python3.12 -m venv .venv',
      'On some distros you need python packages that ship ensurepip (e.g. Arch: extra/python).',
    ].join('\n'),
  );
  return false;
}

function main() {
  const py = findPython();
  if (!py) {
    console.error(
      [
        'No Python 3.10–3.12 found. Kokoro TTS depends on misaki/kokoro, which require Python <3.13.',
        'Install Python 3.12, add python3.12 to PATH, then create a venv and reinstall:',
        '  python3.12 -m venv .venv && . .venv/bin/activate && npm run setup:python',
        'Or set PYTHON=/absolute/path/to/python3.12',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!ensurePip(py)) process.exit(1);

  const cpu =
    process.env.NEMO_PYTORCH_CPU === '1' ||
    process.env.NEMO_PYTORCH_CPU === 'true';

  if (cpu) {
    console.info(
      '[setup:python] NEMO_PYTORCH_CPU: installing CPU-only PyTorch first…',
    );
    const r1 = spawnSync(
      py,
      [
        '-m',
        'pip',
        'install',
        'torch',
        '--index-url',
        'https://download.pytorch.org/whl/cpu',
      ],
      { stdio: 'inherit', cwd: root },
    );
    if (r1.status !== 0) process.exit(r1.status ?? 1);
  }

  const r2 = spawnSync(py, ['-m', 'pip', 'install', '-r', req], {
    stdio: 'inherit',
    cwd: root,
  });
  process.exit(r2.status ?? 1);
}

main();
