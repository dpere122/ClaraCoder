/**
 * Spawn electron or electronmon with ELECTRON_RUN_AS_NODE removed.
 * cross-env `ELECTRON_RUN_AS_NODE=` sets "" on Windows, which still triggers node mode.
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

delete process.env.ELECTRON_RUN_AS_NODE;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/run-electron.mjs <electron|electronmon> [...args]');
  process.exit(1);
}

const spawnOptions = {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
};

let child;
if (command === 'electron') {
  child = spawn(require('electron'), args, spawnOptions);
} else if (command === 'electronmon') {
  child = spawn(
    process.execPath,
    [path.join(projectRoot, 'node_modules', 'electronmon', 'bin', 'cli.js'), ...args],
    spawnOptions,
  );
} else {
  console.error(`Unsupported command: ${command}`);
  process.exit(1);
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
