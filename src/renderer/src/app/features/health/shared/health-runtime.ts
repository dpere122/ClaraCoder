import type { DependencyInfo, DependencyState, RuntimeHealthSnapshot } from '@shared/index';
import { DEPENDENCY_LABELS } from '@shared/index';

export type HealthTone = 'ok' | 'warn' | 'error' | 'muted';

export interface RuntimeChip {
  key: string;
  label: string;
  detail: string;
  /** Untruncated detail for tooltips (dependency errors are clipped in `detail`). */
  hint: string;
  tone: HealthTone;
}

export interface RuntimeVerdict {
  tone: HealthTone;
  title: string;
  detail: string;
  /** Components in `warn` or `error` tone (or 1 when the sidecar is unreachable). */
  issues: number;
}

function depTone(state: DependencyState): HealthTone {
  if (state === 'installed') return 'ok';
  if (state === 'updating') return 'warn';
  if (state === 'error') return 'error';
  return 'muted';
}

function depDetail(dep: DependencyInfo): string {
  if (dep.state === 'installed') return dep.version ? `v${dep.version}` : 'installed';
  if (dep.state === 'updating') return 'updating…';
  if (dep.state === 'error') return dep.error?.slice(0, 48) || 'error';
  return 'missing';
}

function chip(key: string, label: string, detail: string, tone: HealthTone, hint = detail): RuntimeChip {
  return { key, label, detail, hint, tone };
}

/** Python sidecar, managed dependencies, llama runtime, and LSP as display chips. */
export function buildRuntimeChips(snap: RuntimeHealthSnapshot): RuntimeChip[] {
  const out: RuntimeChip[] = [
    chip('python', 'Python', snap.python.healthy ? 'sidecar up' : 'sidecar down', snap.python.healthy ? 'ok' : 'error'),
  ];
  for (const dep of snap.dependencies) {
    const detail = depDetail(dep);
    out.push(chip(dep.id, DEPENDENCY_LABELS[dep.id] ?? dep.label, detail, depTone(dep.state), dep.error || detail));
  }

  const llama = snap.llama;
  const llamaDetail = !llama.binaryInstalled
    ? 'binary missing'
    : llama.runningCount > 0
      ? `${llama.runningCount} running · ${llama.health}`
      : 'idle';
  let llamaTone: HealthTone;
  if (!llama.binaryInstalled) llamaTone = 'muted';
  else if (llama.health === 'error') llamaTone = 'error';
  else if (llama.runningCount > 0 && llama.health !== 'ok') llamaTone = 'warn';
  else llamaTone = 'ok';
  out.push(chip('llama-runtime', 'Llama runtime', llamaDetail, llamaTone));

  const readyNames: string[] = [];
  if (snap.lsp.vtslsInstalled) readyNames.push('TS/JS');
  if (snap.lsp.javaInstalled) readyNames.push('Java');
  const sessions = snap.lsp.activeSessions;
  const lspDetail =
    sessions > 0
      ? `${sessions} session${sessions === 1 ? '' : 's'}`
      : readyNames.length > 0
        ? `${readyNames.join(' + ')} ready`
        : 'LSP missing';
  out.push(chip('lsp', 'LSP', lspDetail, readyNames.length > 0 ? 'ok' : 'muted'));
  return out;
}

/** One-line summary for the header pill and Runtime banner. Missing optional pieces are not issues. */
export function runtimeVerdict(chips: readonly RuntimeChip[], stale: boolean, loaded: boolean): RuntimeVerdict {
  if (!loaded) {
    return { tone: 'muted', title: 'Checking…', detail: 'Waiting for the first runtime snapshot.', issues: 0 };
  }
  if (stale) {
    return {
      tone: 'error',
      title: 'Sidecar unreachable',
      detail: 'The Python backend did not answer the health check.',
      issues: 1,
    };
  }
  const problems = chips.filter((c) => c.tone === 'error' || c.tone === 'warn');
  if (problems.length === 0) {
    const healthy = chips.filter((c) => c.tone === 'ok').length;
    return {
      tone: 'ok',
      title: 'All systems OK',
      detail: `${healthy} component${healthy === 1 ? '' : 's'} healthy`,
      issues: 0,
    };
  }
  return {
    tone: problems.some((c) => c.tone === 'error') ? 'error' : 'warn',
    title: `${problems.length} issue${problems.length === 1 ? '' : 's'}`,
    detail: problems.map((c) => `${c.label}: ${c.detail}`).join(' · '),
    issues: problems.length,
  };
}
