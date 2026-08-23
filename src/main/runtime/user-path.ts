/**
 * Reconstruct the user's bin PATH for packaged GUI launches.
 *
 * Desktop launchers often give Electron a stripped session PATH. Agent
 * `run_command` is a non-interactive shell that inherits that PATH from the
 * Python sidecar. Resolve once at startup (login-shell probe + known user bins
 * + Settings extra dirs), cache, and write `process.env.PATH`.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

export const LOGIN_SHELL_PATH_TIMEOUT_MS = 2500;
const MAX_PROBED_PATH_CHARS = 32_768;

export type PathExists = (candidate: string) => boolean;

export type LoginPathProbeRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; exitCode: number | null }>;

let capturedBasePath: string | undefined;
let loginProbePromise: Promise<string | null> | undefined;

/** Reset in-process caches (unit tests). */
export function resetUserPathStateForTests(): void {
  capturedBasePath = undefined;
  loginProbePromise = undefined;
}

export function parseExtraUserPath(
  raw: string | undefined | null,
  delimiter: string = path.delimiter,
  home: string = homedir(),
): string[] {
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    for (const piece of line.split(delimiter)) {
      const expanded = expandUserDir(piece.trim(), home);
      if (!isPlausiblePathDir(expanded)) {
        continue;
      }
      const key = process.platform === 'win32' ? expanded.toLowerCase() : expanded;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(expanded);
    }
  }
  return out;
}

export function mergePathSegments(
  groups: Array<string | string[] | undefined | null>,
  delimiter: string = path.delimiter,
  win32: boolean = process.platform === 'win32',
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of groups) {
    const items = Array.isArray(group)
      ? group
      : typeof group === 'string'
        ? group.split(delimiter)
        : [];
    for (const item of items) {
      const cleaned = item.trim();
      if (!cleaned) {
        continue;
      }
      const key = win32 ? cleaned.replace(/\//g, '\\').toLowerCase() : cleaned;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ordered.push(cleaned);
    }
  }
  return ordered.join(delimiter);
}

export function knownUserBinCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs: string[] = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.pyenv', 'shims'),
    path.join(home, '.rbenv', 'shims'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
  ];
  if (platform === 'win32') {
    const localAppData =
      (process.env.LOCALAPPDATA || '').trim() || path.join(home, 'AppData', 'Local');
    dirs.push(
      path.join(home, '.pyenv', 'pyenv-win', 'shims'),
      path.join(home, 'scoop', 'shims'),
      path.join(localAppData, 'fnm'),
      path.join(localAppData, 'Programs', 'Git', 'cmd'),
    );
    return dirs;
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/home/linuxbrew/.linuxbrew/bin',
  );
  return dirs;
}

export function existingKnownUserBins(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  exists: PathExists = existsSync,
): string[] {
  return knownUserBinCandidates(home, platform).filter((dir) => {
    try {
      return exists(dir);
    } catch {
      return false;
    }
  });
}

export function isNologinShell(shell: string): boolean {
  const base = path.basename(shell).toLowerCase();
  return (
    base === 'nologin' ||
    base === 'false' ||
    base === 'true' ||
    /(?:^|[/\\])nologin$/i.test(shell)
  );
}

/** Take PATH stdout only — ignore motd / KEY=value dumps from an interactive shell. */
export function parseProbedPathOutput(
  stdout: string,
  delimiter: string = path.delimiter,
): string | null {
  if (!stdout) {
    return null;
  }
  const text = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length > MAX_PROBED_PATH_CHARS) {
      continue;
    }
    if (looksLikeEnvAssignmentDump(line, delimiter)) {
      continue;
    }
    if (looksLikePathValue(line, delimiter)) {
      return line;
    }
  }
  return null;
}

export function resolveUserPath(options: {
  extraUserPath?: string;
  knownBins?: string[];
  loginPath?: string | null;
  currentPath?: string;
  delimiter?: string;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): string {
  const delimiter = options.delimiter ?? path.delimiter;
  const platform = options.platform ?? process.platform;
  const extra = parseExtraUserPath(options.extraUserPath, delimiter, options.home ?? homedir());
  return mergePathSegments(
    [extra, options.knownBins ?? [], options.loginPath ?? '', options.currentPath ?? ''],
    delimiter,
    platform === 'win32',
  );
}

export async function probeLoginShellPath(options: {
  shell?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: LoginPathProbeRunner;
  delimiter?: string;
} = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS;
  const delimiter = options.delimiter ?? path.delimiter;
  const runner = options.runner ?? defaultLoginPathProbeRunner;
  const command = loginPathProbeCommand(platform, options.shell);
  if (!command) {
    return null;
  }
  try {
    const result = await runner(command.file, command.args, {
      timeoutMs,
      env: loginPathProbeEnv(platform, command.file),
    });
    return parseProbedPathOutput(result.stdout, delimiter);
  } catch {
    return null;
  }
}

/**
 * Merge extra dirs + existing user bins + login PATH onto the original GUI PATH,
 * then assign `process.env.PATH`. Login probe is cached for the process lifetime.
 */
export async function applyResolvedUserPath(options: {
  extraUserPath?: string;
  probe?: () => Promise<string | null>;
  knownBins?: string[];
} = {}): Promise<string> {
  if (capturedBasePath === undefined) {
    capturedBasePath = process.env.PATH ?? '';
  }
  if (!loginProbePromise) {
    loginProbePromise = options.probe
      ? options.probe().catch(() => null)
      : probeLoginShellPath().catch(() => null);
  }
  const loginPath = await loginProbePromise;
  const knownBins = options.knownBins ?? existingKnownUserBins();
  const resolved = resolveUserPath({
    extraUserPath: options.extraUserPath,
    knownBins,
    loginPath,
    currentPath: capturedBasePath,
  });
  process.env.PATH = resolved;
  return resolved;
}

function expandUserDir(dir: string, home: string): string {
  if (!dir) {
    return dir;
  }
  if (dir === '~') {
    return home;
  }
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return path.join(home, dir.slice(2));
  }
  const userProfile = (process.env.USERPROFILE || '').trim();
  if (userProfile && /^%USERPROFILE%/i.test(dir)) {
    const rest = dir.replace(/^%USERPROFILE%/i, '').replace(/^[\\/]/, '');
    return rest ? path.join(userProfile, rest) : userProfile;
  }
  return dir;
}

function isPlausiblePathDir(dir: string): boolean {
  if (!dir || dir.includes('\0') || dir.includes('=')) {
    return false;
  }
  return path.isAbsolute(dir);
}

function looksLikeEnvAssignmentDump(line: string, delimiter: string): boolean {
  if (!line.includes('=')) {
    return false;
  }
  if (line.includes(delimiter) || line.startsWith('/') || /^[A-Za-z]:[\\/]/.test(line)) {
    return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(line);
}

function looksLikePathValue(line: string, delimiter: string): boolean {
  if (line.includes(delimiter)) {
    return true;
  }
  return line.startsWith('/') || line.startsWith('~') || /^[A-Za-z]:[\\/]/.test(line);
}

function loginPathProbeCommand(
  platform: NodeJS.Platform,
  shellOverride?: string,
): { file: string; args: string[] } | null {
  if (platform === 'win32') {
    const windir = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').trim();
    const file = path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      file,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')",
      ],
    };
  }
  const shell = (shellOverride || process.env.SHELL || '').trim() || defaultUnixShell(platform);
  if (!shell || isNologinShell(shell)) {
    return null;
  }
  const base = path.basename(shell).toLowerCase();
  if (base === 'fish') {
    return { file: shell, args: ['-lc', 'printf %s (string join : $PATH)'] };
  }
  return { file: shell, args: ['-ilc', 'printf %s "$PATH"'] };
}

function defaultUnixShell(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function loginPathProbeEnv(platform: NodeJS.Platform, shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TERM: 'dumb',
  };
  const pass = [
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'USERDOMAIN',
    'SystemRoot',
    'windir',
    'SystemDrive',
    'PATHEXT',
    'TMP',
    'TEMP',
  ];
  for (const key of pass) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  if (platform !== 'win32') {
    env.SHELL = shell;
  }
  return env;
}

function defaultLoginPathProbeRunner(
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      windowsHide: true,
    });
    let stdout = '';
    const finish = (exitCode: number | null, err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, exitCode });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      finish(null);
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_PROBED_PATH_CHARS * 2) {
        stdout += chunk;
      }
    });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}
