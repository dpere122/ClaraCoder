/**
 * Resolve the version a CI release build is stamped with (.github/workflows/release.yml).
 *
 * package.json holds the NEXT stable version (bump it right after tagging a release).
 *   stable: version = package.json version; the pushed tag must be exactly v<version>.
 *   beta:   version = <package.json version>-beta.<n>. n counts up from 1 for each version:
 *           one more than the highest beta already tagged for it on the remote.
 * Betas of 0.2.0 sort below 0.2.0, so beta users move onto the stable release when it ships.
 *
 * The prerelease id must stay "beta": electron-updater's GitHub provider treats any other id
 * (e.g. "dev") as a custom channel and never offers those users a stable release.
 *
 *   node scripts/release-version.mjs --channel beta              (the next beta; asks the remote)
 *   node scripts/release-version.mjs --channel beta --build 42   (that number, no lookup)
 *   node scripts/release-version.mjs --channel stable --tag v0.2.0
 *
 * Prints the result; with GITHUB_OUTPUT set, also writes version / tag / prerelease outputs.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const CHANNELS = ['stable', 'beta'];
const PLAIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assertPlainVersion(pkgVersion) {
  if (!PLAIN_SEMVER.test(pkgVersion)) {
    throw new Error(`package.json version must be plain X.Y.Z (got "${pkgVersion}")`);
  }
}

/**
 * The number of the next beta of `pkgVersion`: one above the highest `v<pkgVersion>-beta.<n>`
 * in `tags`, or 1 when it has none. The highest, not a count, so a deleted tag never sends the
 * numbers backwards (the updater orders betas of one version by this number).
 *
 * @param {string} pkgVersion
 * @param {Iterable<string>} tags tag names, refs, or `git ls-remote --tags` lines
 * @returns {number}
 */
export function nextBetaBuild(pkgVersion, tags) {
  assertPlainVersion(pkgVersion);
  // A peeled annotated tag is listed a second time with a ^{} suffix.
  const betaTag = new RegExp(`(?:^|[/\\s])v${pkgVersion.replaceAll('.', '\\.')}-beta\\.([1-9]\\d*)(?:\\^\\{\\})?$`);
  let highest = 0;
  for (const tag of tags) {
    const match = betaTag.exec(tag.trim());
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest + 1;
}

/**
 * The beta tags of `pkgVersion` on the remote. Not the local tags: a CI checkout is shallow and
 * has none, and a clone that has not fetched would hand out a number that is already taken.
 */
function remoteBetaTags(pkgVersion) {
  assertPlainVersion(pkgVersion);
  const listing = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${pkgVersion}-beta.*`], {
    cwd: root,
    encoding: 'utf8',
  });
  return listing.split('\n').filter((line) => line.trim() !== '');
}

/**
 * @param {{ channel: string, pkgVersion: string, build?: string | number, tag?: string }} opts
 * @returns {{ version: string, tag: string, prerelease: boolean }}
 */
export function resolveReleaseVersion({ channel, pkgVersion, build, tag }) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown channel "${channel}" (expected ${CHANNELS.join(' | ')})`);
  }
  assertPlainVersion(pkgVersion);
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
  const channel = argValue(args, '--channel') ?? '';
  let build = argValue(args, '--build');
  if (channel === 'beta' && build === undefined) {
    build = nextBetaBuild(pkg.version, remoteBetaTags(pkg.version));
  }
  const result = resolveReleaseVersion({
    channel,
    pkgVersion: pkg.version,
    build,
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
