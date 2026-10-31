/**
 * Windows installer hand-off: Authenticode comparison and launching the NSIS installer that
 * electron-builder produced (`--updated /S [--force-run]`, the same flags electron-updater uses).
 */
import { spawn, execFile } from 'child_process';
import { accessSync, constants as fsConstants } from 'fs';
import path = require('path');

export interface AuthenticodeInfo {
  status: string;
  subject: string | null;
}

/** Reads a file's Authenticode signature via PowerShell (path passed in env, never interpolated). */
export function readAuthenticode(file: string): Promise<AuthenticodeInfo> {
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:CLARA_SIG_PATH; ' +
    '[pscustomobject]@{ status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }) } | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, CLARA_SIG_PATH: file }, windowsHide: true, timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout.trim()) as { status?: unknown; subject?: unknown };
          resolve({
            status: typeof parsed.status === 'string' ? parsed.status : 'Unknown',
            subject: typeof parsed.subject === 'string' ? parsed.subject : null,
          });
        } catch {
          reject(new Error('Could not read the installer signature'));
        }
      },
    );
  });
}

/**
 * When the running app is code-signed, the installer must carry a valid signature from the same
 * signer. Unsigned builds (today's CI output) skip this; the hash checks still apply.
 */
export function compareSignatures(app: AuthenticodeInfo, installer: AuthenticodeInfo): string | null {
  if (app.status !== 'Valid' || !app.subject) return null;
  if (installer.status !== 'Valid') return `Installer signature is ${installer.status}`;
  if (installer.subject !== app.subject) return 'Installer is signed by a different publisher than this app';
  return null;
}

export async function assertInstallerSignature(installer: string, appExe: string): Promise<void> {
  const problem = compareSignatures(await readAuthenticode(appExe), await readAuthenticode(installer));
  if (problem) throw new Error(problem);
}

export function installerArgs(relaunch: boolean): string[] {
  return ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])];
}

/** Per-machine installs (Program Files) need elevation for a silent update. */
export function installDirNeedsElevation(appExe: string): boolean {
  try {
    accessSync(path.dirname(appExe), fsConstants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/** Starts the installer detached so it outlives the quitting app. */
export function launchInstaller(installer: string, relaunch: boolean, elevate: boolean): void {
  const args = installerArgs(relaunch);
  if (elevate) {
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Start-Process -FilePath $env:CLARA_INSTALLER -ArgumentList $env:CLARA_INSTALLER_ARGS.Split(' ') -Verb RunAs",
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CLARA_INSTALLER: installer, CLARA_INSTALLER_ARGS: args.join(' ') },
      },
    ).unref();
    return;
  }
  spawn(installer, args, { detached: true, stdio: 'ignore' }).unref();
}
