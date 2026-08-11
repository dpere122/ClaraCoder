/**
 * Assembles the bundled vtsls (TypeScript/JavaScript LSP) tree used by the
 * packaged app and (optionally) dev.
 *
 * Runs `npm install --prefix <vtsls-bundle> @vtsls/language-server` so the
 * resulting `node_modules/@vtsls/language-server/bin/vtsls.js` (plus the
 * bundled `typescript`/`tsserver`) can be run by the Electron binary in Node
 * mode (`ELECTRON_RUN_AS_NODE=1`) — no system Node.js install required at
 * runtime, mirroring how VS Code ships its TypeScript language server.
 *
 * Output: `<repo-root>/vtsls-bundle/` (gitignored), referenced by
 * `electron-builder.yml` `extraResources` (`to: vtsls`) and by
 * `getBundledVtslsEntry()` in `src/main/paths.ts`.
 *
 * Usage:
 *   node scripts/assemble-vtsls-bundle.mjs          # install / reuse cache (pinned default)
 *   node scripts/assemble-vtsls-bundle.mjs --force   # reinstall
 *   CLARA_VTSLS_VERSION=0.3.0 node scripts/assemble-vtsls-bundle.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bundleDir = path.join(repoRoot, 'vtsls-bundle');
const nodeModulesDir = path.join(bundleDir, 'node_modules');
const entryPath = path.join(
  nodeModulesDir,
  '@vtsls',
  'language-server',
  'bin',
  'vtsls.js',
);
const markerPath = path.join(bundleDir, '.clara-vtsls-version');
// Pinned for reproducible distributable builds. Override with CLARA_VTSLS_VERSION
// (exact semver only — dist-tags and ranges are rejected).
const DEFAULT_VTSLS_VERSION = '0.3.0';
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const version = (process.env.CLARA_VTSLS_VERSION || '').trim() || DEFAULT_VTSLS_VERSION;
if (!EXACT_SEMVER.test(version)) {
  console.error(
    `[vtsls-bundle] CLARA_VTSLS_VERSION=${version} is not allowed; pin an exact semver (e.g. ${DEFAULT_VTSLS_VERSION}), not a dist-tag or range.`,
  );
  process.exit(1);
}
const force = process.argv.includes('--force');

function log(msg) {
  console.log(`[vtsls-bundle] ${msg}`);
}

function readMarker() {
  try {
    return readFileSync(markerPath, 'utf8').trim();
  } catch {
    return '';
  }
}

if (!force && existsSync(entryPath) && readMarker() === version) {
  log(`Already assembled (version=${version}); entry=${entryPath}`);
  log('Run with --force to reinstall.');
  process.exit(0);
}

mkdirSync(bundleDir, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const spec = `@vtsls/language-server@${version}`;
log(`Installing ${spec} into ${bundleDir} …`);
try {
  execFileSync(npm, ['install', '--prefix', bundleDir, spec], {
    stdio: 'inherit',
  });
} catch (err) {
  console.error(`[vtsls-bundle] npm install failed: ${err}`);
  process.exit(1);
}

if (!existsSync(entryPath)) {
  console.error(`[vtsls-bundle] expected entry not found after install: ${entryPath}`);
  process.exit(1);
}

writeFileSync(markerPath, `${version}\n`, 'utf8');
log(`Ready: version=${version} entry=${entryPath}`);
