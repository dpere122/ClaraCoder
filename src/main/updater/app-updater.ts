/**
 * Updates window backend: lists releases, downloads + verifies the chosen installer, and runs it
 * when the app quits ("Restart and install" quits now and relaunches; "Restart later" installs on
 * the next normal quit without relaunching).
 *
 * The renderer only ever names a version. Every URL, size and hash comes from this process's own
 * view of the pinned GitHub repo, and the installer is re-verified right before it is launched.
 */
import { app } from 'electron';
import { promises as fs, readFileSync } from 'fs';
import path = require('path');
import {
  appReleaseAction,
  type AppReleaseListResult,
  type AppUpdateActionResult,
  type AppUpdateState,
} from '../../shared/app-updater';
import { mainState } from '../state';
import { fetchGithubReleases, releaseAssetUrl, type FeedRelease } from './github-releases';
import type { FetchLike } from './pinned-fetch';
import {
  assertInstallerSignature,
  installDirNeedsElevation,
  launchInstaller,
} from './run-installer';
import {
  assertInstallerIntact,
  downloadVerified,
  expectedInstallerFrom,
  fetchUpdateInfo,
  type ExpectedInstaller,
} from './verified-download';

const FEED_TTL_MS = 5 * 60_000;
const PROGRESS_PUSH_MS = 200;

interface ReadyInstaller {
  version: string;
  file: string;
  expected: ExpectedInstaller;
}

let devVersion: string | null = null;

/**
 * The running app's version. Dev runs `electron dist/main/index.js`, where `app.getVersion()` is
 * Electron's own version, so it reads the repo's package.json instead.
 */
export function currentAppVersion(): string {
  if (app.isPackaged) return app.getVersion();
  if (devVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      devVersion = typeof pkg.version === 'string' ? pkg.version : app.getVersion();
    } catch {
      devVersion = app.getVersion();
    }
  }
  return devVersion;
}

let feedCache: { at: number; releases: FeedRelease[] } | null = null;
let feedInFlight: Promise<FeedRelease[]> | null = null;
let downloadAbort: AbortController | null = null;
let ready: ReadyInstaller | null = null;
/** Set once the installer passed its final checks for this quit; the `quit` handler launches it. */
let launchOnQuit: { file: string; relaunch: boolean } | null = null;
let installMode: 'none' | 'now' | 'on-quit' = 'none';
let quitCheckDone = false;

function installSupport(): { supported: boolean; reason: string | null } {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'Installing updates from here is only available on Windows for now.' };
  }
  if (!app.isPackaged) {
    return { supported: false, reason: 'Installing needs the packaged app; this is a development build.' };
  }
  return { supported: true, reason: null };
}

let state: AppUpdateState = {
  phase: 'idle',
  version: null,
  action: null,
  receivedBytes: 0,
  totalBytes: 0,
  error: null,
  installSupported: false,
  installUnsupportedReason: null,
  installOnQuit: false,
};

function setState(patch: Partial<AppUpdateState>): void {
  const support = installSupport();
  state = {
    ...state,
    ...patch,
    installSupported: support.supported,
    installUnsupportedReason: support.reason,
    installOnQuit: installMode === 'on-quit',
  };
  const w = mainState.updaterWindow;
  if (w && !w.isDestroyed()) {
    w.webContents.send('updater:state', state);
  }
}

function userAgent(): string {
  return `Clara-Coder/${currentAppVersion()} (${process.platform}; ${process.arch})`;
}

function fetchImpl(): FetchLike {
  return (url, init) => fetch(url, init);
}

function updatesDir(): string {
  return path.join(app.getPath('userData'), 'updates');
}

async function feed(force: boolean): Promise<FeedRelease[]> {
  if (!force && feedCache && Date.now() - feedCache.at < FEED_TTL_MS) {
    return feedCache.releases;
  }
  feedInFlight ??= fetchGithubReleases(fetchImpl(), { platform: process.platform, arch: process.arch }, userAgent())
    .then((releases) => {
      feedCache = { at: Date.now(), releases };
      return releases;
    })
    .finally(() => {
      feedInFlight = null;
    });
  return feedInFlight;
}

export function getUpdateState(): AppUpdateState {
  setState({});
  return state;
}

export async function listAppReleases(force: boolean): Promise<AppReleaseListResult> {
  const currentVersion = currentAppVersion();
  try {
    const releases = await feed(force);
    return { ok: true, currentVersion, releases: releases.map((r) => r.summary) };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      releases: feedCache?.releases.map((r) => r.summary) ?? [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function downloadAppRelease(version: string): Promise<AppUpdateActionResult> {
  if (state.phase === 'downloading' || state.phase === 'verifying') {
    return { ok: false, error: 'A download is already in progress' };
  }
  let release: FeedRelease | undefined;
  try {
    release = (await feed(false)).find((r) => r.summary.version === version);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!release?.installer || !release.updateInfo) {
    return { ok: false, error: `No installer for ${version} on this platform` };
  }
  const { installer, updateInfo } = release;
  const tag = release.summary.tag;

  ready = null;
  installMode = 'none';
  const abort = new AbortController();
  downloadAbort = abort;
  setState({
    phase: 'downloading',
    version,
    action: appReleaseAction(currentAppVersion(), version),
    receivedBytes: 0,
    totalBytes: installer.size,
    error: null,
  });

  try {
    const opts = { fetchImpl: fetchImpl(), userAgent: userAgent(), signal: abort.signal };
    const info = await fetchUpdateInfo(releaseAssetUrl(tag, updateInfo.name), opts);
    const expected = expectedInstallerFrom(info, { version, installer });

    const dir = updatesDir();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(installer.name));

    let lastPush = 0;
    await downloadVerified({
      ...opts,
      url: releaseAssetUrl(tag, installer.name),
      dest: file,
      expected,
      onProgress: (receivedBytes, totalBytes) => {
        const now = Date.now();
        if (now - lastPush >= PROGRESS_PUSH_MS || receivedBytes === totalBytes) {
          lastPush = now;
          setState({ receivedBytes, totalBytes });
        }
      },
    });

    setState({ phase: 'verifying' });
    // Dev runs electron.exe (signed by Electron), which no Clara installer will match.
    if (installSupport().supported) {
      await assertInstallerSignature(file, process.execPath);
    }
    ready = { version, file, expected };
    setState({ phase: 'ready', error: null });
    return { ok: true };
  } catch (err) {
    const message = abort.signal.aborted ? 'Download cancelled' : err instanceof Error ? err.message : String(err);
    setState({ phase: abort.signal.aborted ? 'idle' : 'error', error: abort.signal.aborted ? null : message });
    return { ok: false, error: message };
  } finally {
    if (downloadAbort === abort) downloadAbort = null;
  }
}

export function cancelAppDownload(): AppUpdateActionResult {
  downloadAbort?.abort();
  return { ok: true };
}

/** Final checks before handing over to the installer: same bytes, same signer. */
async function verifyReadyInstaller(r: ReadyInstaller): Promise<void> {
  await assertInstallerIntact(r.file, r.expected);
  await assertInstallerSignature(r.file, process.execPath);
}

export async function installAppUpdateNow(): Promise<AppUpdateActionResult> {
  const support = installSupport();
  if (!support.supported) return { ok: false, error: support.reason ?? 'Installing is not supported' };
  const r = ready;
  if (!r) return { ok: false, error: 'No verified installer is ready' };
  try {
    await verifyReadyInstaller(r);
  } catch (err) {
    ready = null;
    const message = err instanceof Error ? err.message : String(err);
    setState({ phase: 'error', error: message });
    return { ok: false, error: message };
  }
  installMode = 'now';
  launchOnQuit = { file: r.file, relaunch: true };
  quitCheckDone = true;
  setImmediate(() => app.quit());
  return { ok: true };
}

export function installAppUpdateOnQuit(): AppUpdateActionResult {
  const support = installSupport();
  if (!support.supported) return { ok: false, error: support.reason ?? 'Installing is not supported' };
  if (!ready) return { ok: false, error: 'No verified installer is ready' };
  installMode = 'on-quit';
  setState({});
  return { ok: true };
}

/**
 * "Restart later": the first quit is held while the installer is re-verified, then the app quits
 * for real and the `quit` handler launches it. A failed check quits without installing.
 */
export function registerAppUpdaterQuitHooks(): void {
  app.on('before-quit', (event) => {
    if (installMode !== 'on-quit' || !ready || quitCheckDone) return;
    event.preventDefault();
    const r = ready;
    void verifyReadyInstaller(r)
      .then(() => {
        launchOnQuit = { file: r.file, relaunch: false };
      })
      .catch((err) => {
        console.error('[Updater] Skipping install on quit; verification failed:', err);
      })
      .finally(() => {
        quitCheckDone = true;
        app.quit();
      });
  });

  app.on('quit', () => {
    const pending = launchOnQuit;
    if (!pending) return;
    launchOnQuit = null;
    try {
      launchInstaller(pending.file, pending.relaunch, installDirNeedsElevation(process.execPath));
    } catch (err) {
      console.error('[Updater] Could not start the installer:', err);
    }
  });
}
