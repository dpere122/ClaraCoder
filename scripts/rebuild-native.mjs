/**
 * Rebuild native addons for the Electron version pinned in devDependencies.
 * Runs each module separately so a failure in one (e.g. node-pty + Spectre on Windows)
 * does not skip the others.
 *
 * Windows + node-pty (including bundled winpty): upstream .gyp enables Spectre mitigation, so MSBuild needs
 * "MSVC ... Spectre-mitigated libs" (VS Installer → Individual components). If you cannot
 * install those, set NEMO_ALLOW_WIN_PTY_NON_SPECTRE=1 for a local-only non-Spectre build.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

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

function maybeRelaxNodePtySpectreMitigation() {
  if (process.platform !== 'win32' || process.env.NEMO_ALLOW_WIN_PTY_NON_SPECTRE !== '1') {
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
          `[postinstall] Stripped SpectreMitigation from ${rel} (NEMO_ALLOW_WIN_PTY_NON_SPECTRE=1). Prefer installing MSVC Spectre-mitigated libraries instead.`,
        );
      }
    } catch {
      // Package missing; rebuild will report errors.
    }
  }
}

function rebuild(moduleName) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(npx, ['electron-rebuild', '-f', '-o', moduleName], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.warn(`[postinstall] electron-rebuild for ${moduleName} exited ${r.status} (continuing).`);
  }
}

maybeRelaxNodePtySpectreMitigation();
rebuild('node-pty');
rebuild('better-sqlite3');
process.exit(0);
