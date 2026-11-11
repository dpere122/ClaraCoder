/**
 * App self-update: shared types and version rules for the Updates window.
 *
 * Releases come only from GitHub Releases of {@link APP_UPDATE_REPO} (the same repo as the
 * `publish` block in electron-builder.yml). Stable releases are the default list; pre-releases
 * (`v0.2.0-beta.3`) appear when the user opts into beta versions.
 *
 * No Node / DOM imports — shared by Electron main, preload, and the renderer.
 */

/** The only release source the updater trusts. Keep in sync with electron-builder.yml `publish`. */
export const APP_UPDATE_REPO = { owner: 'dpere122', repo: 'ClaraCoder' } as const;

export const APP_UPDATE_RELEASES_PAGE = `https://github.com/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases`;

/** One release as the Updates window lists it. */
export interface AppReleaseSummary {
  /** Semver without the `v` tag prefix, e.g. `0.2.0-beta.3`. */
  version: string;
  tag: string;
  /** Release title (falls back to the tag). */
  name: string;
  /** Release message (GitHub markdown). */
  notes: string;
  prerelease: boolean;
  publishedAt: string | null;
  /** GitHub page for this release (always under {@link APP_UPDATE_RELEASES_PAGE}). */
  htmlUrl: string;
  /** Installer for this platform with update metadata, or null when the release has none. */
  installer: { fileName: string; size: number } | null;
}

export interface AppReleaseListResult {
  ok: boolean;
  currentVersion: string;
  releases: AppReleaseSummary[];
  error?: string;
}

/** What installing a release does relative to the running version. */
export type AppReleaseAction = 'update' | 'downgrade' | 'reinstall';

export type AppUpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'error';

/** Download / install progress, pushed to the Updates window on `updater:state`. */
export interface AppUpdateState {
  phase: AppUpdatePhase;
  /** Version being downloaded, verified, or ready to install. */
  version: string | null;
  action: AppReleaseAction | null;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
  /** True when this build can run a downloaded installer (packaged Windows app). */
  installSupported: boolean;
  /** Why installing is unavailable, when it is. */
  installUnsupportedReason: string | null;
  /** "Restart later" was chosen: the installer runs when the app quits. */
  installOnQuit: boolean;
}

export interface AppUpdateActionResult {
  ok: boolean;
  error?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(raw: string): ParsedVersion | null {
  const m = SEMVER.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Normalized semver for a release tag (`v0.2.0` → `0.2.0`), or null when the tag isn't a version. */
export function versionFromReleaseTag(tag: string): string | null {
  const raw = tag.trim().replace(/^v/, '');
  return parseVersion(raw) ? raw : null;
}

export function isPrereleaseVersion(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: negative when `a` is older than `b`, 0 when equal, positive when newer.
 * Versions that don't parse sort before every valid version.
 */
export function compareAppVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return Math.sign(pa[key] - pb[key]);
  }
  if (!pa.prerelease.length || !pb.prerelease.length) {
    // A release outranks its own pre-releases (0.2.0 > 0.2.0-beta.9).
    return pa.prerelease.length ? -1 : pb.prerelease.length ? 1 : 0;
  }
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdentifiers(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/** The one action that applies when moving from `current` to `target`. */
export function appReleaseAction(current: string, target: string): AppReleaseAction {
  const c = compareAppVersions(target, current);
  return c > 0 ? 'update' : c < 0 ? 'downgrade' : 'reinstall';
}

/** Newest first; hides pre-releases unless `includeBeta`. */
export function visibleAppReleases(
  releases: readonly AppReleaseSummary[],
  includeBeta: boolean,
): AppReleaseSummary[] {
  return releases
    .filter((r) => includeBeta || !r.prerelease)
    .sort((a, b) => compareAppVersions(b.version, a.version));
}
