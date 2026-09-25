/**
 * Orchestrates managed runtime dependencies via the Python FastAPI sidecar
 * (or CLI bootstrap when the sidecar is not yet healthy).
 */
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path = require('path');
import { app } from 'electron';
import type {
  DependencyActionResult,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
} from '../../shared';
import { DEPENDENCY_IDS, defaultDependencyCatalog } from '../../shared';
import { listDownloadedWhisperModels, mergeWhisperDownloadedModels } from './whisper-downloaded';
import { ingestElectronLog } from '../log-ingest';
import { pythonControlFetch, pythonLongFetch, pythonSseGet } from '../python/http-client';
import { isPythonHealthy, restartPythonServer } from '../python/server';
import {
  getJavaLspCacheDir,
  getLogsDir,
  getPythonExecutable,
  getPythonServerScriptPath,
  getRuntimeBinDir,
  getRuntimeDir,
  getRuntimePythonDir,
  pythonIsolationEnv,
} from '../paths';
import { mainState } from '../state';
import { getDefaultCustomModelsDir } from '../config/defaults';
import { loadConfigSync } from '../config/load-save';
import { unwrapSecret } from '../../shared';
import { envForChildProcess } from '../utils/filter-sensitive-env';

const DEPS_LOGGER = 'clara.electron.deps';

/** Exact env keys kept for the deps CLI child (plus CLARA_ and NEMO_ prefixes). */
const RUNTIME_ENV_PASSTHROUGH = new Set([
  'PATH',
  'PYTHONHOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

export function isRuntimeEnvPassthrough(key: string, packaged = app.isPackaged): boolean {
  const upper = key.toUpperCase();
  if (upper.startsWith('CLARA_') || upper.startsWith('NEMO_')) return true;
  if (packaged && upper === 'PYTHONHOME') return false;
  return RUNTIME_ENV_PASSTHROUGH.has(upper);
}

function pythonPackageRoot(): string {
  return path.dirname(getPythonServerScriptPath());
}

function ensureRuntimeDirs(): void {
  mkdirSync(getRuntimeDir(), { recursive: true });
  mkdirSync(getRuntimeBinDir(), { recursive: true });
  // python-venv is created by the python-runtime provider on install (not an empty stub dir).
}

function modelManagerHfToken(): string {
  try {
    return unwrapSecret(loadConfigSync().modelManager.huggingFaceToken).trim();
  } catch {
    return '';
  }
}

function customModelsRoot(): string {
  try {
    const dir = loadConfigSync().modelManager?.customModelsDir?.trim();
    if (dir) return dir;
  } catch {
    /* fall through */
  }
  return process.env.CLARA_CUSTOM_MODELS_DIR || getDefaultCustomModelsDir();
}

function runtimeEnv(): NodeJS.ProcessEnv {
  const packaged = app.isPackaged;
  const scrubbed = envForChildProcess();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(scrubbed)) {
    if (value !== undefined && isRuntimeEnvPassthrough(key, packaged)) {
      env[key] = value;
    }
  }
  const hfToken = modelManagerHfToken();
  return {
    ...env,
    PYTHONUNBUFFERED: '1',
    CLARA_RUNTIME_DIR: getRuntimeDir(),
    CLARA_RUNTIME_PYTHON_DIR: getRuntimePythonDir(),
    CLARA_RUNTIME_BIN_DIR: getRuntimeBinDir(),
    // Same resolver as the sidecar (includes legacy → runtime migrate).
    CLARA_JAVA_LSP_CACHE_DIR: getJavaLspCacheDir(),
    CLARA_LOG_DIR: getLogsDir(),
    CLARA_CUSTOM_MODELS_DIR: customModelsRoot(),
    ...(hfToken ? { HF_TOKEN: hfToken, HUGGING_FACE_HUB_TOKEN: hfToken } : {}),
    ...pythonIsolationEnv(),
  };
}

function withWhisperDownloads(dependencies: DependencyInfo[]): DependencyInfo[] {
  const fromDisk = listDownloadedWhisperModels(customModelsRoot());
  return dependencies.map((dep) => {
    if (dep.id !== 'whisper') return dep;
    return {
      ...dep,
      downloadedModels: mergeWhisperDownloadedModels(dep.downloadedModels, fromDisk),
    };
  });
}

function logDeps(level: string, message: string): void {
  const line = `[deps] ${message}`;
  if (level === 'WARNING' || level === 'ERROR') {
    console.warn(line);
  } else {
    console.log(line);
  }
  void ingestElectronLog(level, DEPS_LOGGER, message, 'electron');
}

/** Deps that change the interpreter / site-packages the FastAPI sidecar must reload. */
const SIDECAR_RESTART_DEPS = new Set<DependencyId>(['python-runtime', 'kokoro', 'whisper']);

async function maybeRestartSidecar(depId: DependencyId, ok: boolean): Promise<void> {
  if (!ok || !SIDECAR_RESTART_DEPS.has(depId)) return;
  logDeps('INFO', `Restarting Python sidecar after ${depId}…`);
  try {
    await restartPythonServer();
    logDeps('INFO', `Python sidecar restarted after ${depId}`);
  } catch (err) {
    logDeps(
      'WARNING',
      `Sidecar restart after ${depId} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function broadcastProgress(payload: DependencyProgressEvent): void {
  for (const win of [
    mainState.dependenciesWindow,
    mainState.mainWindow,
    mainState.settingsWindow,
    mainState.healthWindow,
  ]) {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('deps:progress', payload);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Prefer the same interpreter as the sidecar (runtime venv / bundled; packaged has no PATH fallback). */
function bootstrapPythonCmd(): string | null {
  return getPythonExecutable();
}

async function runDepsCli(
  action: 'list' | 'install' | 'reinstall' | 'delete' | 'status',
  depId?: DependencyId,
  variant?: string | null,
): Promise<{ ok: boolean; dependencies?: DependencyInfo[]; dependency?: DependencyInfo; error?: string }> {
  ensureRuntimeDirs();
  const py = bootstrapPythonCmd();
  if (!py) {
    const err = 'Bundled Python runtime missing; reinstall Clara Coder.';
    logDeps('ERROR', err);
    return { ok: false, error: err };
  }
  const args = ['-m', 'clara_coder_backend.runtime.deps', action];
  if (depId) {
    if (!isKnownDependencyId(depId)) {
      return { ok: false, error: `Unknown dependency: ${depId}` };
    }
    args.push(depId);
  }
  if (variant && action !== 'list' && action !== 'status') {
    // Defense-in-depth: only pass --variant for allowlisted dependency ids.
    if (!depId || !isKnownDependencyId(depId)) {
      return { ok: false, error: `Unknown dependency for variant: ${depId ?? '(none)'}` };
    }
    args.push('--variant', variant);
  }
  const cwd = pythonPackageRoot();
  logDeps('INFO', `CLI ${action}${depId ? ` ${depId}` : ''}${variant ? ` variant=${variant}` : ''} via ${py} (cwd=${cwd})`);

  return new Promise((resolve) => {
    const proc = spawn(py, args, {
      cwd,
      env: runtimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('PROGRESS ')) {
          try {
            const payload = JSON.parse(line.slice('PROGRESS '.length)) as DependencyProgressEvent;
            broadcastProgress(payload);
          } catch {
            /* ignore */
          }
        } else if (line.length) {
          stdout += line + '\n';
        }
      }
    });
    proc.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString();
    });
    proc.on('close', (code) => {
      const lines = stdout
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('{'));
      const last = lines[lines.length - 1];
      if (!last) {
        const err = stderr.trim() || `Dependency CLI exited ${code ?? '?'} with no output`;
        logDeps('WARNING', `CLI failed: ${err}`);
        resolve({ ok: false, error: err });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(last);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('ok' in parsed) ||
          typeof (parsed as { ok: unknown }).ok !== 'boolean'
        ) {
          resolve({
            ok: false,
            error: stderr.trim() || `Invalid CLI JSON shape: ${last.slice(0, 200)}`,
          });
          return;
        }
        resolve(
          parsed as {
            ok: boolean;
            dependencies?: DependencyInfo[];
            dependency?: DependencyInfo;
            error?: string;
          },
        );
      } catch {
        resolve({ ok: false, error: stderr.trim() || `Invalid CLI JSON: ${last.slice(0, 200)}` });
      }
    });
    proc.on('error', (err) => {
      logDeps('WARNING', `CLI spawn error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
  });
}

async function viaHttp<T extends { ok?: boolean }>(
  pathSuffix: string,
  init?: RequestInit,
): Promise<T | null> {
  if (!(await isPythonHealthy())) return null;
  try {
    const res = await pythonControlFetch(pathSuffix, init);
    if (!res.ok) {
      logDeps('WARNING', `HTTP ${pathSuffix} → ${res.status}`);
      return null;
    }
    const body = (await res.json()) as T;
    if (body && typeof body === 'object' && 'ok' in body && body.ok === false) {
      return body;
    }
    return body;
  } catch (err) {
    logDeps('WARNING', `HTTP ${pathSuffix} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Best-effort SSE reader so HTTP installs still fan out ``deps:progress``. */
function startHttpProgressPump(signal: AbortSignal): void {
  void (async () => {
    try {
      if (!(await isPythonHealthy())) return;
      const res = await pythonSseGet('/runtime/deps/progress', {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as DependencyProgressEvent;
            if (payload?.depId && payload?.phase) broadcastProgress(payload);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* aborted or network */
    }
  })();
}

async function runInstallOrReinstall(
  action: 'install' | 'reinstall',
  depId: DependencyId,
  variant?: string | null,
): Promise<DependencyActionResult> {
  ensureRuntimeDirs();
  const queuedMsg = action === 'reinstall' ? 'Reinstalling…' : 'Starting…';
  broadcastProgress({ depId, phase: 'queued', message: queuedMsg });
  logDeps('INFO', `${action} ${depId}${variant ? ` variant=${variant}` : ''} starting`);
  const ac = new AbortController();
  startHttpProgressPump(ac.signal);
  let result: DependencyActionResult;
  try {
    if (await isPythonHealthy()) {
      try {
        const res = await pythonLongFetch(`/runtime/deps/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depId, variant: variant ?? null }),
        });
        const http = (await res.json()) as DependencyActionResult;
        if (http.ok) {
          broadcastProgress({ depId, phase: 'done' });
          result = http;
        } else {
          broadcastProgress({ depId, phase: 'error', message: http.error });
          // Action failed in-process; still try CLI as a second path when HTTP returned ok:false
          // only if the response looks like a transport/proxy failure — keep explicit provider errors.
          result = http;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logDeps('WARNING', `HTTP ${action} ${depId} failed, falling back to CLI: ${msg}`);
        const cli = await runDepsCli(action, depId, variant);
        result = {
          ok: !!cli.ok,
          error: cli.error || msg,
          dependency: cli.dependency,
        };
        if (result.ok) broadcastProgress({ depId, phase: 'done' });
        else broadcastProgress({ depId, phase: 'error', message: result.error });
      }
    } else {
      const cli = await runDepsCli(action, depId, variant);
      result = {
        ok: !!cli.ok,
        error: cli.error,
        dependency: cli.dependency,
      };
      if (result.ok) broadcastProgress({ depId, phase: 'done' });
      else broadcastProgress({ depId, phase: 'error', message: result.error });
    }
  } finally {
    ac.abort();
  }
  if (result.ok) {
    logDeps('INFO', `${action} ${depId} succeeded`);
  } else {
    logDeps('ERROR', `${action} ${depId} failed: ${result.error ?? 'unknown error'}`);
  }
  await maybeRestartSidecar(depId, result.ok);
  return result;
}

export async function listDependencies(): Promise<{
  dependencies: DependencyInfo[];
  error?: string;
}> {
  ensureRuntimeDirs();
  const http = await viaHttp<{ ok: boolean; dependencies: DependencyInfo[]; error?: string }>(
    '/runtime/deps/list',
  );
  if (http?.ok && Array.isArray(http.dependencies) && http.dependencies.length > 0) {
    return { dependencies: withWhisperDownloads(http.dependencies) };
  }
  const cli = await runDepsCli('list');
  if (cli.ok && Array.isArray(cli.dependencies) && cli.dependencies.length > 0) {
    return { dependencies: withWhisperDownloads(cli.dependencies) };
  }
  const err =
    cli.error ||
    (http && !http.ok ? http.error : undefined) ||
    'Could not query dependency status; showing catalog defaults.';
  logDeps('WARNING', `list falling back to catalog: ${err}`);
  return { dependencies: withWhisperDownloads(defaultDependencyCatalog()), error: err };
}

export async function installDependency(
  depId: DependencyId,
  variant?: string | null,
): Promise<DependencyActionResult> {
  if (!isKnownDependencyId(depId)) {
    return { ok: false, error: `Unknown dependency: ${depId}` };
  }
  return runInstallOrReinstall('install', depId, variant);
}

export async function reinstallDependency(
  depId: DependencyId,
  variant?: string | null,
): Promise<DependencyActionResult> {
  if (!isKnownDependencyId(depId)) {
    return { ok: false, error: `Unknown dependency: ${depId}` };
  }
  return runInstallOrReinstall('reinstall', depId, variant);
}

export async function deleteDependency(depId: DependencyId): Promise<DependencyActionResult> {
  if (!isKnownDependencyId(depId)) {
    return { ok: false, error: `Unknown dependency: ${depId}` };
  }
  ensureRuntimeDirs();
  logDeps('INFO', `delete ${depId} starting`);
  const http = await viaHttp<DependencyActionResult>('/runtime/deps/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depId }),
  });
  let result: DependencyActionResult;
  if (http) {
    result = http;
  } else {
    const cli = await runDepsCli('delete', depId);
    result = {
      ok: !!cli.ok,
      error: cli.error,
      dependency: cli.dependency,
    };
  }
  if (result.ok) {
    logDeps('INFO', `delete ${depId} succeeded`);
  } else {
    logDeps('ERROR', `delete ${depId} failed: ${result.error ?? 'unknown error'}`);
  }
  await maybeRestartSidecar(depId, result.ok);
  return result;
}

export function isKnownDependencyId(id: string): id is DependencyId {
  return (DEPENDENCY_IDS as readonly string[]).includes(id);
}

/**
 * Prefer managed runtime/bin/llama-server when the command starts with a bare ``llama-server``.
 */
export function rewriteManagedLlamaCommand(command: string, managedBinary: string | null): string {
  if (!managedBinary) return command;
  const trimmed = command.trim();
  if (!trimmed) return command;
  const m = /^(["']?)llama-server(?:\.exe)?\1(\s|$)/i.exec(trimmed);
  if (!m) return command;
  const rest = trimmed.slice(m[0].length);
  const quoted =
    process.platform === 'win32'
      ? `"${managedBinary.replace(/"/g, '\\"')}"`
      : `'${managedBinary.replace(/'/g, `'\\''`)}'`;
  return `${quoted}${rest ? (rest.startsWith(' ') ? rest : ` ${rest}`) : ''}`;
}
