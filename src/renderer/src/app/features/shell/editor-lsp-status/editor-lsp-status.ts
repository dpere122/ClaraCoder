import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { LspDashboardStatus } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath } from '@shared/index';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import {
  envRelevantWorkspaceChange,
  LSP_ENV_SLOW_POLL_MS,
  needsEnvPoll,
} from './lsp-env-poll-policy';

@Component({
  selector: 'app-editor-lsp-status',
  standalone: true,
  imports: [],
  templateUrl: './editor-lsp-status.html',
  styleUrl: './editor-lsp-status.css',
})
export class EditorLspStatusComponent {
  protected readonly electron = inject(ElectronService);

  /** Active conversation (maps to Python ``session_id`` for LSP). */
  readonly conversationId = input<string | null>(null);
  /** When set, status reflects the integrated LSP for this path (``.py`` / TS/JS / ``.gd``). */
  readonly activeFileRelativePath = input<string | null>(null);

  protected readonly dashboard = signal<LspDashboardStatus | null>(null);
  protected readonly fetchError = signal('');
  protected readonly loading = signal(false);

  /**
   * Serialized dashboard fetches: callers chain so a refresh after ``warmLspForActiveFile``
   * still runs (it is not dropped after awaiting an older in-flight fetch).
   */
  private dashboardRefreshChain: Promise<void> = Promise.resolve();

  /** Dedupe ``warmLspForActiveFile`` when the same conversation + path effect re-runs. */
  private lastWarmConversationPath = '';

  private workspaceFilesChangedSubscription: Subscription | null = null;

  /** LSP server implied by the active editor tab's path, when any. */
  protected readonly fileInferredServerId = computed(() => {
    const path = this.activeFileRelativePath()?.trim();
    if (!path) {
      return null as string | null;
    }
    return lspServerKindForWorkspaceRelativePath(path.replace(/\\/g, '/'));
  });

  constructor() {
    effect((onCleanup) => {
      const conv = this.conversationId();
      if (!this.electron.isElectron || !conv?.trim()) {
        this.dashboard.set(null);
        this.fetchError.set('');
        this.lastWarmConversationPath = '';
        return;
      }
      void this.refreshDashboard();
    });

    effect((onCleanup) => {
      const conv = this.conversationId()?.trim();
      const path = this.activeFileRelativePath()?.trim().replace(/\\/g, '/') ?? null;
      const dash = this.dashboard();
      if (!this.electron.isElectron || !conv) {
        return;
      }
      if (!needsEnvPoll(dash, path)) {
        return;
      }
      const pollTimer = window.setInterval(() => {
        const activePath = this.activeFileRelativePath()?.trim().replace(/\\/g, '/') ?? null;
        if (!needsEnvPoll(this.dashboard(), activePath)) {
          return;
        }
        void this.refreshDashboard();
      }, LSP_ENV_SLOW_POLL_MS);
      onCleanup(() => clearInterval(pollTimer));
    });

    this.workspaceFilesChangedSubscription = this.electron.workspaceFilesChanged$.subscribe((event) => {
      if (!envRelevantWorkspaceChange(event.paths)) {
        return;
      }
      void this.refreshDashboard();
    });

    /** Start LSP / didOpen current file from disk so dashboard shows ``running`` (otherwise servers stay cold). */
    effect(() => {
      const conv = this.conversationId()?.trim();
      const path = this.activeFileRelativePath()?.trim();
      if (!this.electron.isElectron || !conv || !path) {
        return;
      }
      const posix = path.replace(/\\/g, '/');
      if (!lspServerKindForWorkspaceRelativePath(posix)) {
        return;
      }
      const warmKey = `${conv}|${posix}`;
      if (this.lastWarmConversationPath === warmKey) {
        return;
      }
      this.lastWarmConversationPath = warmKey;
      untracked(async () => {
        const w = await this.electron.warmLspForActiveFile(conv, posix);
        if (w.ok) {
          await this.refreshDashboard();
        }
      });
    });
  }

  private refreshDashboard(): Promise<void> {
    const next = this.dashboardRefreshChain.then(async () => {
      const conv = this.conversationId()?.trim();
      if (!conv) {
        return;
      }
      this.loading.set(true);
      try {
        const res = await this.electron.getLspDashboardStatus(conv);
        if (res.ok) {
          this.dashboard.set(res.status);
          this.fetchError.set('');
        } else {
          this.dashboard.set(null);
          this.fetchError.set(res.error);
        }
      } finally {
        this.loading.set(false);
      }
    });
    this.dashboardRefreshChain = next.catch(() => undefined);
    return next;
  }

  /** Single-line indicator + tooltip for the workspace footer. */
  protected readonly vm = computed(() => {
    const path = this.activeFileRelativePath();
    const fileKind = this.fileInferredServerId();
    const d = this.dashboard();
    const err = this.fetchError();
    const busy = this.loading();

    if (err) {
      return {
        text: `LSP · ${truncate(err, 40)}`,
        tone: 'error' as const,
        title: err,
      };
    }
    if (!d && busy) {
      return { text: 'LSP · …', tone: 'pending' as const, title: 'Loading language server status…' };
    }
    if (!d) {
      return { text: 'LSP · —', tone: 'muted' as const, title: 'Language server status unavailable.' };
    }

    if (!path?.trim()) {
      const n = d.cachedDiagnostics ?? 0;
      const hints = dependencyDocHints(d);
      const { text: srvText, titleLines } = runningServersSummary(d);
      const baseTitle = `Integrated language servers · ${titleLines.join(' · ')} · ${n} diagnostic(s) cached\n\nOpen a .py, TS/JS, or .gd file tab to warm and bind IntelliSense to that server.`;
      return {
        text: srvText,
        tone: 'muted' as const,
        title: hints ? `${baseTitle}\n\n${hints}` : baseTitle,
      };
    }

    const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    if (!fileKind) {
      const hints = dependencyDocHints(d);
      const { text: srvText, titleLines } = runningServersSummary(d);
      const baseTitle = `No integrated LSP for \`${base}\`.\n\nOther servers: ${titleLines.join(' · ')}`;
      return {
        text: `No LSP · ${base}`,
        tone: 'muted' as const,
        title: hints ? `${baseTitle}\n\n${hints}` : baseTitle,
      };
    }

    const running = Boolean(d.servers[fileKind]?.initialized);
    const name = serverDisplayName(fileKind);
    const hints = dependencyDocHints(d);
    const baseTitle = `${name} · ${running ? 'running' : 'stopped'} · active for \`${base}\``;
    return {
      text: `${name} · ${running ? 'running' : 'stopped'}`,
      tone: running ? ('ok' as const) : ('warn' as const),
      title: hints ? `${baseTitle}\n\n${hints}` : baseTitle,
    };
  });
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

const DASHBOARD_SERVER_ORDER = ['python', 'typescript', 'gdscript', 'java'] as const;

const SERVER_SHORT: Record<string, string> = {
  python: 'Py',
  typescript: 'TS',
  gdscript: 'GD',
  java: 'Jv',
};

function serverDisplayName(kind: string): string {
  if (kind === 'python') {
    return 'Python';
  }
  if (kind === 'gdscript') {
    return 'GDScript';
  }
  if (kind === 'typescript') {
    return 'TS/JS';
  }
  if (kind === 'java') {
    return 'Java';
  }
  return kind;
}

function runningServersSummary(d: LspDashboardStatus): { text: string; titleLines: string[] } {
  const parts: string[] = [];
  const titleLines: string[] = [];
  for (const id of DASHBOARD_SERVER_ORDER) {
    const ent = d.servers[id];
    if (!ent) {
      continue;
    }
    const short = SERVER_SHORT[id] ?? id.slice(0, 3);
    parts.push(`${short} ${ent.initialized ? '●' : '○'}`);
    titleLines.push(`${serverDisplayName(id)} ${ent.initialized ? 'running' : 'stopped'}`);
  }
  return { text: parts.length ? parts.join(' · ') : '—', titleLines };
}

function dependencyDocHints(status: LspDashboardStatus): string {
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
