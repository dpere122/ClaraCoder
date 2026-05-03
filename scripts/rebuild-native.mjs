/**
 * Rebuild native addons for the Electron version pinned in devDependencies.
 * Runs each module separately so a failure in one (e.g. node-pty + Spectre on Windows)
 * does not skip the others.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

function rebuild(moduleName) {
  const r = spawnSync('npx', ['electron-rebuild', '-f', '-o', moduleName], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.warn(`[postinstall] electron-rebuild for ${moduleName} exited ${r.status} (continuing).`);
  }
}

rebuild('node-pty');
rebuild('better-sqlite3');
process.exit(0);
