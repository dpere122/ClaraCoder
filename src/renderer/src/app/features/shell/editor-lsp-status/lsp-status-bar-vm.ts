import type { LspDashboardStatus, LspLifecyclePhase } from '@shared/index';

export type LspStatusChipTone = 'ok' | 'warn' | 'error' | 'muted' | 'pending';

export interface LspStatusChip {
  id: string;
  text: string;
  title: string;
  tone: LspStatusChipTone;
}

export interface LspStatusBarVm {
  chips: LspStatusChip[];
  idleText: string;
  title: string;
  /** False when the chat has no workspace — hide the status chip instead of showing an error. */
  visible: boolean;
}

const NO_WORKSPACE_ERROR_MARKER = 'does not have a workspace attached';

export function isMissingWorkspaceLspError(fetchError: string): boolean {
  return fetchError.trim().toLowerCase().includes(NO_WORKSPACE_ERROR_MARKER);
}

function hiddenVm(): LspStatusBarVm {
  return { chips: [], idleText: '', title: '', visible: false };
}

export const LSP_DASHBOARD_SERVER_ORDER = ['python', 'typescript', 'gdscript', 'java'] as const;

const SERVER_DISPLAY: Record<string, string> = {
  python: 'Python',
  typescript: 'TS/JS',
  gdscript: 'GDScript',
  java: 'Java',
};

export function phaseDisplayLabel(phase: LspLifecyclePhase): string {
  if (phase === 'shuttingDown') {
    return 'shutting down';
  }
  return phase;
}

export function chipToneForPhase(phase: LspLifecyclePhase): LspStatusChipTone {
  if (phase === 'running') {
    return 'ok';
  }
  if (phase === 'crashed') {
    return 'error';
  }
  if (phase === 'starting' || phase === 'initializing' || phase === 'indexing' || phase === 'shuttingDown') {
    return 'pending';
  }
  return 'muted';
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function serverDisplayName(kind: string): string {
  return SERVER_DISPLAY[kind] ?? kind;
}

export function dependencyDocHints(status: LspDashboardStatus): string {
  const lines: string[] = [];
  const pyEnv = status.pythonEnvironmentPath;
  const pyExe = status.pythonInterpreterPath;

  if (pyEnv !== undefined && pyEnv !== null && pyEnv !== '') {
    lines.push(`Python env (hover/docs): ${pyEnv}`);
  } else if (pyEnv !== undefined) {
    lines.push('Python env: not set — library hovers work best after the workspace venv is detected.');
  }

  if (pyExe !== undefined && pyExe !== null && pyExe !== '') {
    lines.push(`Python interpreter: ${pyExe}`);
  }

  return lines.join('\n');
}

function effectivePhase(initialized: boolean, phase: LspLifecyclePhase | undefined): LspLifecyclePhase {
  if (phase) {
    return phase;
  }
  return initialized ? 'running' : 'idle';
}

/** Right-justified chips for non-idle servers; empty chips means show the idle label. */
export function buildLspStatusBarVm(
  dashboard: LspDashboardStatus | null,
  fetchError: string,
  loading: boolean,
  warmingServerId: string | null = null,
  workspaceAttached = true,
): LspStatusBarVm {
  if (!workspaceAttached || isMissingWorkspaceLspError(fetchError)) {
    return hiddenVm();
  }
  if (fetchError.trim()) {
    const err = fetchError.trim();
    return {
      chips: [
        {
          id: 'error',
          text: `LSP · ${truncate(err, 40)}`,
          title: err,
          tone: 'error',
        },
      ],
      idleText: 'LSP idle',
      title: err,
      visible: true,
    };
  }
  if (!dashboard && loading) {
    return {
      chips: [],
      idleText: 'LSP · …',
      title: 'Loading language server status…',
      visible: true,
    };
  }
  if (!dashboard) {
    return {
      chips: [],
      idleText: 'LSP idle',
      title: 'Language server status unavailable.',
      visible: true,
    };
  }

  const order: string[] = [...LSP_DASHBOARD_SERVER_ORDER];
  for (const id of Object.keys(dashboard.servers)) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }

  const chips: LspStatusChip[] = [];
  for (const id of order) {
    const ent = dashboard.servers[id];
    if (!ent) {
      continue;
    }
    const phase = effectivePhase(Boolean(ent.initialized), ent.phase);
    if (phase === 'idle') {
      continue;
    }
    const name = serverDisplayName(id);
    const phaseLabel = phaseDisplayLabel(phase);
    const titleParts = [`${name} · ${phaseLabel}`];
    const scope = ent.scope?.trim();
    if (scope) {
      titleParts.push(`scope ${scope}`);
    }
    const lang = ent.languageStatus?.trim();
    if (lang) {
      titleParts.push(lang);
    }
    const lastErr = ent.lastError?.trim();
    if (lastErr) {
      titleParts.push(lastErr);
    }
    const hints = dependencyDocHints(dashboard);
    chips.push({
      id,
      text: `${name} · ${phaseLabel}`,
      title: hints ? `${titleParts.join(' · ')}\n\n${hints}` : titleParts.join(' · '),
      tone: chipToneForPhase(phase),
    });
  }

  const warming = warmingServerId?.trim() || '';
  if (warming && !chips.some((chip) => chip.id === warming)) {
    const name = serverDisplayName(warming);
    chips.push({
      id: warming,
      text: `${name} · starting`,
      title: `${name} · starting`,
      tone: 'pending',
    });
    const warmIdx = order.indexOf(warming);
    if (warmIdx >= 0) {
      chips.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
    }
  }

  if (chips.length === 0) {
    const hints = dependencyDocHints(dashboard);
    const base = 'No language server subprocess is starting, running, or shutting down.';
    return {
      chips: [],
      idleText: 'LSP idle',
      title: hints ? `${base}\n\n${hints}` : base,
      visible: true,
    };
  }

  return {
    chips,
    idleText: 'LSP idle',
    title: chips.map((chip) => chip.title.split('\n')[0]).join(' · '),
    visible: true,
  };
}
