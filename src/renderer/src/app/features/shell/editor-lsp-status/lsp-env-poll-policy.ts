import type { LspDashboardStatus } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath } from '@shared/index';

/** Slow poll interval while waiting for a missing Python venv or Node ``node_modules``. */
export const LSP_ENV_SLOW_POLL_MS = 30_000;

/** Fast poll while a server is starting, initializing, indexing, or shutting down. */
export const LSP_LIFECYCLE_FAST_POLL_MS = 500;

const TRANSIENT_PHASES = new Set(['starting', 'initializing', 'indexing', 'shuttingDown']);

/** True when the active tab needs an env that ``GET /lsp/status`` still reports as missing. */
export function needsEnvPoll(
  status: LspDashboardStatus | null | undefined,
  activePath: string | null | undefined,
): boolean {
  if (!status) {
    return false;
  }
  const path = activePath?.trim().replace(/\\/g, '/');
  if (!path) {
    return false;
  }
  const kind = lspServerKindForWorkspaceRelativePath(path);
  if (kind === 'python') {
    const env = status.pythonEnvironmentPath;
    return env === null || env === undefined || env === '';
  }
  if (kind === 'typescript') {
    return status.nodeModulesPresent === false;
  }
  return false;
}

/** True when any server is in a short-lived lifecycle phase that polling should catch. */
export function needsLifecyclePoll(status: LspDashboardStatus | null | undefined): boolean {
  if (!status) {
    return false;
  }
  for (const ent of Object.values(status.servers)) {
    if (ent && TRANSIENT_PHASES.has(ent.phase)) {
      return true;
    }
  }
  return false;
}

const ENV_RELEVANT_SEGMENTS = ['node_modules', '.venv', 'venv', 'package.json', 'pyproject.toml', 'requirements.txt'];

/** Whether a workspace watcher batch may have changed Python or Node tooling paths. */
export function envRelevantWorkspaceChange(paths: readonly string[]): boolean {
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/').toLowerCase();
    if (!p) {
      continue;
    }
    for (const seg of ENV_RELEVANT_SEGMENTS) {
      if (p === seg || p.endsWith(`/${seg}`) || p.includes(`/${seg}/`)) {
        return true;
      }
    }
  }
  return false;
}
