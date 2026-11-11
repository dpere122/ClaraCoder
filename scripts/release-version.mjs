/**
 * Resolve the version a CI release build is stamped with (.github/workflows/release.yml).
 *
 * package.json holds the NEXT stable version (bump it right after tagging a release).
 *   stable: version = package.json version; the pushed tag must be exactly v<version>.
 *   beta:   version = <package.json version>-beta.<build>, build = the workflow run number.
 * Betas of 0.2.0 sort below 0.2.0, so beta users move onto the stable release when it ships.
 *
 * The prerelease id must stay "beta": electron-updater's GitHub provider treats any other id
 * (e.g. "dev") as a custom channel and never offers those users a stable release.
 *
 *   node scripts/release-version.mjs --channel beta --build 42
 *   node scripts/release-version.mjs --channel stable --tag v0.2.0
 *
 * Prints the result; with GITHUB_OUTPUT set, also writes version / tag / prerelease outputs.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const CHANNELS = ['stable', 'beta'];
const PLAIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @param {{ channel: string, pkgVersion: string, build?: string | number, tag?: string }} opts
 * @returns {{ version: string, tag: string, prerelease: boolean }}
 */
export function resolveReleaseVersion({ channel, pkgVersion, build, tag }) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown channel "${channel}" (expected ${CHANNELS.join(' | ')})`);
  }
  if (!PLAIN_SEMVER.test(pkgVersion)) {
    throw new Error(`package.json version must be plain X.Y.Z (got "${pkgVersion}")`);
  }
  if (channel === 'stable') {
    const expected = `v${pkgVersion}`;
    if (tag !== expected) {
      throw new Error(`Tag "${tag}" does not match package.json version (expected ${expected})`);
    }
    return { version: pkgVersion, tag: expected, prerelease: false };
  }
  const n = String(build ?? '');
  if (!/^[1-9]\d*$/.test(n)) {
    throw new Error(`Beta builds need a positive integer --build (got "${n}")`);
  }
  const version = `${pkgVersion}-beta.${n}`;
  return { version, tag: `v${version}`, prerelease: true };
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const result = resolveReleaseVersion({
    channel: argValue(args, '--channel') ?? '',
    pkgVersion: pkg.version,
    build: argValue(args, '--build'),
    tag: argValue(args, '--tag'),
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nprerelease=${result.prerelease}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`[release-version] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
