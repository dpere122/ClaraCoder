/**
 * Inject Vite ignore comments into Monaco dynamic imports that Vite cannot analyze.
 * Idempotent — safe to run on every install / before ng serve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const targets = [
  path.join(root, 'node_modules', 'monaco-editor', 'esm', 'vs', 'base', 'common', 'worker', 'simpleWorker.js'),
  path.join(
    root,
    'node_modules',
    'monaco-editor',
    'esm',
    'vs',
    'editor',
    'common',
    'services',
    'editorSimpleWorker.js',
  ),
];

const BEFORE = 'import(`${url}`)';
const AFTER = 'import(/* @vite-ignore */ `${url}`)';

let patched = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.warn(`[patch-monaco] skip missing ${path.relative(root, file)}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(AFTER)) {
    continue;
  }
  if (!src.includes(BEFORE)) {
    console.warn(`[patch-monaco] pattern not found in ${path.relative(root, file)}`);
    continue;
  }
  fs.writeFileSync(file, src.split(BEFORE).join(AFTER));
  patched += 1;
  console.info(`[patch-monaco] patched ${path.relative(root, file)}`);
}

if (patched === 0) {
  console.info('[patch-monaco] already up to date');
}
