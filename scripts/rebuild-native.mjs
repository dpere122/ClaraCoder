/**
 * Rebuild native addons for the Electron version pinned in this repo.
 * Runs each module separately so a failure in one (e.g. node-pty + Spectre on Windows)
 * does not skip the others.
 *
 * Default: skip a module if Electron can already load it (fast path when switching
 * machines or re-running `npm run dev`). `--force` always rebuilds (used by postinstall,
 * because `npm install` typically compiles addons for system Node, not Electron).
 *
 * Windows + node-pty (including bundled winpty): upstream .gyp enables Spectre mitigation, so MSBuild needs
 * "MSVC ... Spectre-mitigated libs" (VS Installer → Individual components). If you cannot
 * install those, set CLARA_ALLOW_WIN_PTY_NON_SPECTRE=1 (or NEMO_ALLOW_WIN_PTY_NON_SPECTRE=1)
 * for a local-only non-Spectre build.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const logPrefix = '[rebuild-native]';

const MODULES = [
  { name: 'node-pty', required: false },
  { name: 'better-sqlite3', required: true },
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;

function stripSpectreMitigationBlocks(text) {
  const patterns = [
    // node-pty binding.gyp
    /\r?\n        'msvs_configuration_attributes': \{\r?\n          'SpectreMitigation': 'Spectre'\r?\n        \},\r?\n/g,
    // deps/winpty/src/winpty.gyp (winpty-agent + winpty targets)
    /\r?\n            'msvs_configuration_attributes': \{\r?\n                'SpectreMitigation': 'Spectre'\r?\n            \},\r?\n/g,
  ];
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, '\n');
  }
  return out;
}

function winPtyNonSpectreAllowed() {
  return (
    process.env.CLARA_ALLOW_WIN_PTY_NON_SPECTRE === '1' ||
    process.env.NEMO_ALLOW_WIN_PTY_NON_SPECTRE === '1'
  );
}

function maybeRelaxNodePtySpectreMitigation() {
  if (process.platform !== 'win32' || !winPtyNonSpectreAllowed()) {
    return;
  }
  const relativePaths = [
    path.join('node_modules', 'node-pty', 'binding.gyp'),
    path.join('node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
  ];
  for (const rel of relativePaths) {
    const bindingPath = path.join(root, rel);
    try {
      const text = fs.readFileSync(bindingPath, 'utf8');
      const next = stripSpectreMitigationBlocks(text);
      if (next !== text) {
        fs.writeFileSync(bindingPath, next);
        console.warn(
          `${logPrefix} Stripped SpectreMitigation from ${rel} (CLARA_ALLOW_WIN_PTY_NON_SPECTRE=1). Prefer installing MSVC Spectre-mitigated libraries instead.`,
        );
      }
    } catch {
      // Package missing; rebuild will report errors.
    }
  }
}

function getElectronPath() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

function getElectronVersion() {
  try {
    return require('electron/package.json').version;
  } catch {
    return null;
  }
}

function electronCanLoad(electronPath, moduleName) {
  const r = spawnSync(electronPath, ['-e', `require(${JSON.stringify(moduleName)});`], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  return { ok: r.status === 0, stderr: (r.stderr || r.stdout || '').trim() };
}

function rebuild(moduleName, electronVersion) {
  const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  const rebuildArgs = ['-f', '-o', moduleName];
  if (electronVersion) {
    rebuildArgs.push('-v', electronVersion);
  }
  const r = spawnSync(process.execPath, [cli, ...rebuildArgs], {
    cwd: root,
    stdio: 'inherit',
  });
  return r.status === 0;
}

function ensureModule(mod, electronPath, electronVersion) {
  if (!force) {
    const check = electronCanLoad(electronPath, mod.name);
    if (check.ok) {
      console.log(`${logPrefix} ${mod.name} already matches Electron ${electronVersion}.`);
      return true;
    }
    console.warn(`${logPrefix} ${mod.name} is not loadable by Electron ${electronVersion}; rebuilding.`);
    if (check.stderr) {
      console.warn(check.stderr.split('\n').slice(0, 6).join('\n'));
    }
  }

  const rebuilt = rebuild(mod.name, electronVersion);
  if (!rebuilt) {
    console.warn(`${logPrefix} electron-rebuild for ${mod.name} failed.`);
    return false;
  }

  const verify = electronCanLoad(electronPath, mod.name);
  if (!verify.ok) {
    console.warn(`${logPrefix} ${mod.name} still does not load in Electron ${electronVersion} after rebuild.`);
    if (verify.stderr) {
      console.warn(verify.stderr.split('\n').slice(0, 8).join('\n'));
    }
    return false;
  }
  console.log(`${logPrefix} ${mod.name} rebuilt for Electron ${electronVersion}.`);
  return true;
}

const electronPath = getElectronPath();
const electronVersion = getElectronVersion();
if (!electronPath || !electronVersion) {
  console.warn(`${logPrefix} Electron not installed; skipping native rebuild.`);
  process.exit(0);
}

maybeRelaxNodePtySpectreMitigation();

const selected = MODULES.filter((mod) => !only || mod.name === only);
if (only && selected.length === 0) {
  console.error(`${logPrefix} Unknown module --only=${only}`);
  process.exit(1);
}

let failedRequired = false;
for (const mod of selected) {
  const ok = ensureModule(mod, electronPath, electronVersion);
  if (!ok && mod.required) {
    failedRequired = true;
  } else if (!ok) {
    console.warn(`${logPrefix} Continuing without a working ${mod.name} build.`);
  }
}

if (failedRequired) {
  console.error(
    `${logPrefix} Required native module is not built for Electron ${electronVersion}. ` +
      `Install a C++ toolchain (Windows: Visual Studio Build Tools) and re-run npm install or npm run rebuild:sqlite.`,
  );
  process.exit(1);
}
