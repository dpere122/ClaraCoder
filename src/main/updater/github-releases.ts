/**
 * Release feed for the Updates window: reads GitHub Releases of the pinned repo and keeps,
 * per release, the platform installer and its electron-builder update metadata (`latest.yml`).
 *
 * Only `api.github.com` is contacted here. Asset download URLs are rebuilt from the pinned
 * owner/repo + tag + asset name rather than taken from the API response.
 */
import {
  APP_UPDATE_RELEASES_PAGE,
  APP_UPDATE_REPO,
  isPrereleaseVersion,
  versionFromReleaseTag,
  type AppReleaseSummary,
} from '../../shared/app-updater';
import { readLimitedText, type FetchLike } from './pinned-fetch';

const RELEASES_API = `https://api.github.com/repos/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases?per_page=100`;
const RELEASES_API_MAX_BYTES = 8 * 1024 * 1024;

export interface ReleaseAssetRef {
  name: string;
  size: number;
  /** GitHub's server-side SHA-256 of the asset (hex), when the API reports one. */
  sha256: string | null;
}

/** A release plus the assets the updater needs (main process only). */
export interface FeedRelease {
  summary: AppReleaseSummary;
  installer: ReleaseAssetRef | null;
  updateInfo: ReleaseAssetRef | null;
}

export interface UpdatePlatform {
  platform: NodeJS.Platform;
  arch: string;
}

/** electron-builder names: `Clara-Coder-<version>-Windows-<arch>.exe` next to `latest.yml`. */
function platformAssetNames(p: UpdatePlatform, version: string): { installer: string; updateInfo: string } | null {
  if (p.platform === 'win32' && (p.arch === 'x64' || p.arch === 'arm64')) {
    return { installer: `Clara-Coder-${version}-Windows-${p.arch}.exe`, updateInfo: 'latest.yml' };
  }
  return null;
}

export function releaseAssetUrl(tag: string, assetName: string): string {
  return `${APP_UPDATE_RELEASES_PAGE}/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function assetRef(raw: unknown): ReleaseAssetRef | null {
  const a = asRecord(raw);
  if (!a || typeof a['name'] !== 'string' || typeof a['size'] !== 'number' || a['size'] <= 0) return null;
  if (a['state'] !== undefined && a['state'] !== 'uploaded') return null;
  const digest = typeof a['digest'] === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a['digest']) : null;
  return { name: a['name'], size: a['size'], sha256: digest ? digest[1]!.toLowerCase() : null };
}

/**
 * Maps the GitHub API response to feed releases. Drafts, tags that aren't semver (the old `dev`
 * tag) and malformed entries are dropped.
 */
export function parseGithubReleases(json: unknown, p: UpdatePlatform): FeedRelease[] {
  if (!Array.isArray(json)) {
    throw new Error('GitHub returned an unexpected releases payload');
  }
  const out: FeedRelease[] = [];
  for (const raw of json) {
    const r = asRecord(raw);
    if (!r || r['draft'] === true || typeof r['tag_name'] !== 'string') continue;
    const tag = r['tag_name'];
    const version = versionFromReleaseTag(tag);
    if (!version) continue;
    const assets = Array.isArray(r['assets']) ? r['assets'].map(assetRef).filter((a) => a !== null) : [];
    const names = platformAssetNames(p, version);
    const installer = names ? (assets.find((a) => a.name === names.installer) ?? null) : null;
    const updateInfo = names ? (assets.find((a) => a.name === names.updateInfo) ?? null) : null;
    const usable = installer && updateInfo;
    out.push({
      summary: {
        version,
        tag,
        name: typeof r['name'] === 'string' && r['name'].trim() ? r['name'].trim() : tag,
        notes: typeof r['body'] === 'string' ? r['body'] : '',
        prerelease: r['prerelease'] === true || isPrereleaseVersion(version),
        publishedAt: typeof r['published_at'] === 'string' ? r['published_at'] : null,
        htmlUrl: `${APP_UPDATE_RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`,
        installer: usable ? { fileName: installer.name, size: installer.size } : null,
      },
      installer: usable ? installer : null,
      updateInfo: usable ? updateInfo : null,
    });
  }
  return out;
}

export async function fetchGithubReleases(
  fetchImpl: FetchLike,
  p: UpdatePlatform,
  userAgent: string,
  signal?: AbortSignal,
): Promise<FeedRelease[]> {
  const res = await fetchImpl(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    },
    redirect: 'error',
    signal,
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub rate limit reached; try again in a few minutes');
  }
  if (!res.ok) {
    throw new Error(`GitHub releases request failed (HTTP ${res.status})`);
  }
  return parseGithubReleases(JSON.parse(await readLimitedText(res, RELEASES_API_MAX_BYTES)), p);
}
