/**
 * Downloads an installer and proves it is the file the release published before anything runs it.
 *
 * Expected size and hashes come from two independent places:
 *   - `latest.yml` from the same release (SHA-512 + size computed by the CI build), and
 *   - GitHub's own asset record (size + server-side SHA-256 `digest`), when it reports one.
 * The download must match all of them; a mismatch deletes the file.
 */
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { finished } from 'stream/promises';
import { fetchPinned, readLimitedText, type FetchLike } from './pinned-fetch';

const UPDATE_INFO_MAX_BYTES = 64 * 1024;

export interface UpdateInfoFile {
  url: string;
  sha512: string;
  size: number;
}

export interface UpdateInfo {
  version: string;
  files: UpdateInfoFile[];
}

/** What a downloaded installer must hash to. */
export interface ExpectedInstaller {
  size: number;
  /** Base64 SHA-512, as electron-builder writes it in latest.yml. */
  sha512: string;
  /** Hex SHA-256 from GitHub's asset digest, when available. */
  sha256: string | null;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Reads electron-builder's `latest.yml`. Only the fixed shape electron-builder writes is
 * understood (`version`, and `files` entries with `url` / `sha512` / `size`); anything the
 * updater relies on that's missing fails closed later in {@link expectedInstallerFrom}.
 */
export function parseUpdateInfoYaml(text: string): UpdateInfo {
  let version = '';
  const files: Partial<UpdateInfoFile>[] = [];
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top) {
      inFiles = top[1] === 'files' && top[2]!.trim() === '';
      if (top[1] === 'version') version = unquote(top[2]!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s+-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    const field = item ?? /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    if (item) files.push({});
    const entry = files[files.length - 1];
    if (!entry) continue;
    const [, key, value] = field;
    if (key === 'url') entry.url = unquote(value!);
    else if (key === 'sha512') entry.sha512 = unquote(value!);
    else if (key === 'size') entry.size = Number(unquote(value!));
  }
  return {
    version,
    files: files.filter(
      (f): f is UpdateInfoFile => !!f.url && !!f.sha512 && Number.isSafeInteger(f.size) && f.size! > 0,
    ),
  };
}

const BASE64_SHA512 = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Cross-checks the release's `latest.yml` against GitHub's asset record and returns the size and
 * hashes the installer must match. Throws when they disagree or anything is missing.
 */
export function expectedInstallerFrom(
  info: UpdateInfo,
  release: { version: string; installer: { name: string; size: number; sha256: string | null } },
): ExpectedInstaller {
  if (info.version !== release.version) {
    throw new Error(`latest.yml is for ${info.version || 'an unknown version'}, not ${release.version}`);
  }
  const file = info.files.find((f) => f.url === release.installer.name);
  if (!file) throw new Error(`latest.yml does not list ${release.installer.name}`);
  if (!BASE64_SHA512.test(file.sha512)) throw new Error('latest.yml has a malformed sha512');
  if (file.size !== release.installer.size) {
    throw new Error(`Installer size mismatch: latest.yml says ${file.size}, GitHub says ${release.installer.size}`);
  }
  return { size: file.size, sha512: file.sha512, sha256: release.installer.sha256 };
}

export async function fetchUpdateInfo(
  url: string,
  opts: { fetchImpl: FetchLike; userAgent: string; signal?: AbortSignal },
): Promise<UpdateInfo> {
  const res = await fetchPinned(url, opts);
  return parseUpdateInfoYaml(await readLimitedText(res, UPDATE_INFO_MAX_BYTES));
}

export async function hashFile(file: string): Promise<{ size: number; sha512: string; sha256: string }> {
  const h512 = createHash('sha512');
  const h256 = createHash('sha256');
  let size = 0;
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    h512.update(buf);
    h256.update(buf);
  }
  return { size, sha512: h512.digest('base64'), sha256: h256.digest('hex') };
}

function mismatch(actual: { size: number; sha512: string; sha256: string }, expected: ExpectedInstaller): string | null {
  if (actual.size !== expected.size) return `size ${actual.size} ≠ expected ${expected.size}`;
  if (actual.sha512 !== expected.sha512) return 'SHA-512 does not match latest.yml';
  if (expected.sha256 && actual.sha256 !== expected.sha256) return 'SHA-256 does not match GitHub’s asset digest';
  return null;
}

/** Re-hashes a file on disk; throws when it no longer matches (checked again right before install). */
export async function assertInstallerIntact(file: string, expected: ExpectedInstaller): Promise<void> {
  const problem = mismatch(await hashFile(file), expected);
  if (problem) throw new Error(`Installer verification failed: ${problem}`);
}

/**
 * Streams `url` to `dest` (via `<dest>.partial`), hashing as it goes. The file only gets its final
 * name after size and every hash match; otherwise it's deleted and this throws.
 */
export async function downloadVerified(opts: {
  url: string;
  dest: string;
  expected: ExpectedInstaller;
  fetchImpl: FetchLike;
  userAgent: string;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const { expected } = opts;
  const partial = `${opts.dest}.partial`;
  const res = await fetchPinned(opts.url, opts);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== expected.size) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Server reports ${declared} bytes, expected ${expected.size}`);
  }
  if (!res.body) throw new Error('Download returned no body');

  const h512 = createHash('sha512');
  const h256 = createHash('sha256');
  let size = 0;
  const out = createWriteStream(partial);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size) throw new Error(`Download exceeded the expected ${expected.size} bytes`);
      h512.update(value);
      h256.update(value);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
      opts.onProgress?.(size, expected.size);
    }
    out.end();
    await finished(out);
    const problem = mismatch({ size, sha512: h512.digest('base64'), sha256: h256.digest('hex') }, expected);
    if (problem) throw new Error(`Installer verification failed: ${problem}`);
    await fs.rename(partial, opts.dest);
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    out.destroy();
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
}
