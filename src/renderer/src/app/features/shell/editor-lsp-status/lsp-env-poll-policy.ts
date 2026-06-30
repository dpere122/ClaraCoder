import type { LspDashboardStatus } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath } from '@shared/index';

/** Slow poll interval while waiting for a missing Python venv or Node ``node_modules``. */
export const LSP_ENV_SLOW_POLL_MS = 30_000;

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
