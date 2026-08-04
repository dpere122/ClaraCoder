/**
 * Orchestrates managed runtime dependencies via the Python FastAPI sidecar
 * (or CLI bootstrap when the sidecar is not yet healthy).
 */
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path = require('path');
import type {
  DependencyActionResult,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
} from '../../shared';
import { DEPENDENCY_IDS, defaultDependencyCatalog } from '../../shared';
import { pythonControlFetch, pythonLongFetch, pythonSseGet } from '../python/http-client';
import { isPythonHealthy } from '../python/server';
import {
  getJavaLspCacheDir,
  getPythonExecutable,
  getPythonServerScriptPath,
  getRuntimeBinDir,
  getRuntimeDir,
  getRuntimePythonDir,
} from '../paths';
import { restartPythonServer } from '../python/server';
import { mainState } from '../state';

function pythonPackageRoot(): string {
  return path.dirname(getPythonServerScriptPath());
}

function ensureRuntimeDirs(): void {
  mkdirSync(getRuntimeDir(), { recursive: true });
  mkdirSync(getRuntimeBinDir(), { recursive: true });
  // python-venv is created by the python-runtime provider on install (not an empty stub dir).
}

function runtimeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    CLARA_RUNTIME_DIR: getRuntimeDir(),
    CLARA_RUNTIME_PYTHON_DIR: getRuntimePythonDir(),
    CLARA_RUNTIME_BIN_DIR: getRuntimeBinDir(),
    // Same resolver as the sidecar (includes legacy → runtime migrate).
    CLARA_JAVA_LSP_CACHE_DIR: getJavaLspCacheDir(),
  };
}

/** Deps that change the interpreter / site-packages the FastAPI sidecar must reload. */
const SIDECAR_RESTART_DEPS = new Set<DependencyId>(['python-runtime', 'kokoro']);

async function maybeRestartSidecar(depId: DependencyId, ok: boolean): Promise<void> {
  if (!ok || !SIDECAR_RESTART_DEPS.has(depId)) return;
  try {
    await restartPythonServer();
  } catch (err) {
    console.warn(
      '[deps] Sidecar restart after',
      depId,
      'failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

function broadcastProgress(payload: DependencyProgressEvent): void {
  for (const win of [mainState.dependenciesWindow, mainState.mainWindow, mainState.settingsWindow]) {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('deps:progress', payload);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Prefer the same interpreter as the sidecar (runtime venv / .venv / bundled / system). */
function bootstrapPythonCmd(): string {
  return getPythonExecutable();
}

async function runDepsCli(
  action: 'list' | 'install' | 'reinstall' | 'delete' | 'status',
  depId?: DependencyId,
): Promise<{ ok: boolean; dependencies?: DependencyInfo[]; dependency?: DependencyInfo; error?: string }> {
  ensureRuntimeDirs();
  const py = bootstrapPythonCmd();
  const args = ['-m', 'clara_coder_backend.runtime.deps', action];
  if (depId) args.push(depId);
  const cwd = pythonPackageRoot();
  console.log(`[deps] CLI ${action}${depId ? ` ${depId}` : ''} via ${py} (cwd=${cwd})`);

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
        console.warn('[deps] CLI failed:', err);
        resolve({ ok: false, error: err });
        return;
      }
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ ok: false, error: stderr.trim() || `Invalid CLI JSON: ${last.slice(0, 200)}` });
      }
    });
    proc.on('error', (err) => {
      console.warn('[deps] CLI spawn error:', err.message);
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
      console.warn(`[deps] HTTP ${pathSuffix} → ${res.status}`);
      return null;
    }
    const body = (await res.json()) as T;
    if (body && typeof body === 'object' && 'ok' in body && body.ok === false) {
      return body;
    }
    return body;
  } catch (err) {
    console.warn(`[deps] HTTP ${pathSuffix} failed:`, err instanceof Error ? err.message : err);
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

export async function listDependencies(): Promise<{
  dependencies: DependencyInfo[];
  error?: string;
}> {
  ensureRuntimeDirs();
  const http = await viaHttp<{ ok: boolean; dependencies: DependencyInfo[]; error?: string }>(
    '/runtime/deps/list',
  );
  if (http?.ok && Array.isArray(http.dependencies) && http.dependencies.length > 0) {
    return { dependencies: http.dependencies };
  }
  const cli = await runDepsCli('list');
  if (cli.ok && Array.isArray(cli.dependencies) && cli.dependencies.length > 0) {
    return { dependencies: cli.dependencies };
  }
  const err =
    cli.error ||
    (http && !http.ok ? http.error : undefined) ||
    'Could not query dependency status; showing catalog defaults.';
  console.warn('[deps] list falling back to catalog:', err);
  return { dependencies: defaultDependencyCatalog(), error: err };
}

export async function installDependency(depId: DependencyId): Promise<DependencyActionResult> {
  ensureRuntimeDirs();
  broadcastProgress({ depId, phase: 'queued', message: 'Starting…' });
  const ac = new AbortController();
  startHttpProgressPump(ac.signal);
  let result: DependencyActionResult;
  try {
    if (await isPythonHealthy()) {
      try {
        const res = await pythonLongFetch('/runtime/deps/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depId }),
        });
        const http = (await res.json()) as DependencyActionResult;
        if (http.ok) broadcastProgress({ depId, phase: 'done' });
        else broadcastProgress({ depId, phase: 'error', message: http.error });
        result = http;
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      const cli = await runDepsCli('install', depId);
      result = {
        ok: !!cli.ok,
        error: cli.error,
        dependency: cli.dependency,
      };
    }
  } finally {
    ac.abort();
  }
  await maybeRestartSidecar(depId, result.ok);
  return result;
}

export async function reinstallDependency(depId: DependencyId): Promise<DependencyActionResult> {
  ensureRuntimeDirs();
  broadcastProgress({ depId, phase: 'queued', message: 'Reinstalling…' });
  const ac = new AbortController();
  startHttpProgressPump(ac.signal);
  let result: DependencyActionResult;
  try {
    if (await isPythonHealthy()) {
      try {
        const res = await pythonLongFetch('/runtime/deps/reinstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depId }),
        });
        const http = (await res.json()) as DependencyActionResult;
        if (http.ok) broadcastProgress({ depId, phase: 'done' });
        else broadcastProgress({ depId, phase: 'error', message: http.error });
        result = http;
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      const cli = await runDepsCli('reinstall', depId);
      result = {
        ok: !!cli.ok,
        error: cli.error,
        dependency: cli.dependency,
      };
    }
  } finally {
    ac.abort();
  }
  await maybeRestartSidecar(depId, result.ok);
  return result;
}

export async function deleteDependency(depId: DependencyId): Promise<DependencyActionResult> {
  ensureRuntimeDirs();
  const http = await viaHttp<DependencyActionResult>('/runtime/deps/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depId }),
  });
  if (http) return http;
  const cli = await runDepsCli('delete', depId);
  return {
    ok: !!cli.ok,
    error: cli.error,
    dependency: cli.dependency,
  };
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
