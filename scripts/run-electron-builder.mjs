/**
 * Runs electron-builder after clearing `release/`. If that folder is still locked
 * (Windows EBUSY), uses `release-pack-<timestamp>/` so NSIS can still produce an .exe.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');

function tryKillPackagedWindowsApp() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/F', '/IM', 'Clara Coder.exe', '/T'], { stdio: 'ignore' });
  } catch {
    /* not running or cannot kill */
  }
}

function isBusyError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || err);
  return code === 'EBUSY' || /resource busy|locked|EBUSY/i.test(msg);
}

async function tryRemoveReleaseDir() {
  if (!fs.existsSync(releaseDir)) return true;

  const attempts = 25;
  const gapMs = 400;
  let triedKill = false;

  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(releaseDir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (process.platform === 'win32' && isBusyError(err) && !triedKill) {
        triedKill = true;
        console.warn('release/ is locked (often the packaged app). Stopping "Clara Coder.exe" and retrying…');
        tryKillPackagedWindowsApp();
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      const code = err && err.code;
      const retryable =
        isBusyError(err) || ['EPERM', 'ENOTEMPTY', 'EMFILE', 'EACCES'].includes(code);
      if (!retryable || i === attempts - 1) {
        return false;
      }
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return false;
}

function findArtifacts(outDir) {
  if (!fs.existsSync(outDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (ent.isFile() && /\.(exe|msi|dmg|AppImage)$/i.test(ent.name)) {
      out.push(path.join(outDir, ent.name));
    }
  }
  return out.sort();
}

async function main() {
  const ebArgs = process.argv.slice(2);

  let outputDir = path.join(projectRoot, 'release');
  const cleared = await tryRemoveReleaseDir();
  if (!cleared) {
    outputDir = path.join(projectRoot, `release-pack-${Date.now()}`);
    ebArgs.unshift(`--config.directories.output=${outputDir}`);
    console.warn(
      `\nCould not clear ${path.relative(projectRoot, releaseDir)} (files still in use). ` +
        `Building into ${path.relative(projectRoot, outputDir)} instead.\n`,
    );
  }

  const ebCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  const r = spawnSync(process.execPath, [ebCli, ...ebArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const code = r.status ?? 1;
  if (code !== 0) process.exit(code);

  const artifacts = findArtifacts(outputDir);
  if (artifacts.length) {
    console.log('\nArtifacts (installer / bundles):');
    for (const p of artifacts) {
      console.log(' ', path.relative(projectRoot, p));
    }
  } else if (!ebArgs.includes('--dir')) {
    console.log('\nPack finished but no installer-like files were found under the output directory.');
  }
}

await main();
