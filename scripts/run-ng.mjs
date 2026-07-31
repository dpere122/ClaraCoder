/**
 * Run Angular CLI with cwd=src/renderer so angular.json resolves correctly
 * while dependencies live in the repo-root node_modules.
 *
 * For `serve`, patch Monaco with @vite-ignore and filter any remaining
 * known-harmless Vite dynamic-import warning blocks from stdout/stderr.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const rendererRoot = path.join(projectRoot, 'src', 'renderer');
const ngCli = path.join(projectRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');

const args = process.argv.slice(2);
const isServe = args[0] === 'serve';

if (isServe) {
  try {
    await import('./patch-monaco-vite-ignore.mjs');
  } catch (err) {
    console.warn('[run-ng] monaco vite-ignore patch failed:', err);
  }
}

/** Drop Vite import-analysis warning blocks for Monaco runtime dynamic imports. */
function createViteWarningFilter(write) {
  let pending = null; // string[] while collecting a vite warning block
  let carry = '';

  const flushPending = (emit) => {
    if (!pending) return;
    const text = pending.join('');
    pending = null;
    if (
      emit &&
      !(
        text.includes('dynamic import cannot be analyzed') &&
        text.includes('vite:import-analysis')
      )
    ) {
      write(text);
    }
  };

  return (chunk) => {
    carry += chunk.toString();
    while (true) {
      const nl = carry.indexOf('\n');
      if (nl < 0) break;
      const line = carry.slice(0, nl + 1);
      carry = carry.slice(nl + 1);

      if (pending) {
        pending.push(line);
        // Typical block ends after the "File: ..." line.
        if (/^\s*File:\s/.test(line) || line.includes('File: /') || line.includes('File: \\')) {
          flushPending(true);
        } else if (pending.length > 40) {
          // Safety: never swallow unbounded output.
          flushPending(true);
        }
        continue;
      }

      if (/\[vite\].*warning:/i.test(line)) {
        pending = [line];
        continue;
      }

      write(line);
    }
  };
}

const child = spawn(process.execPath, [ngCli, ...args], {
  cwd: rendererRoot,
  env: process.env,
  stdio: isServe ? ['inherit', 'pipe', 'pipe'] : 'inherit',
});

if (isServe) {
  const outFilter = createViteWarningFilter((s) => process.stdout.write(s));
  const errFilter = createViteWarningFilter((s) => process.stderr.write(s));
  child.stdout?.on('data', outFilter);
  child.stderr?.on('data', errFilter);
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
