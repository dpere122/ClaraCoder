/**
 * Run Angular CLI with cwd=src/renderer so angular.json resolves correctly
 * while dependencies live in the repo-root node_modules.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const rendererRoot = path.join(projectRoot, 'src', 'renderer');
const ngCli = path.join(projectRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');

const args = process.argv.slice(2);
const child = spawn(process.execPath, [ngCli, ...args], {
  cwd: rendererRoot,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
