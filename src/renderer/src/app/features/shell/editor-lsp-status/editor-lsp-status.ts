import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { LspDashboardStatus } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-editor-lsp-status',
  standalone: true,
  templateUrl: './editor-lsp-status.html',
  styleUrl: './editor-lsp-status.css',
})
export class EditorLspStatusComponent {
  protected readonly electron = inject(ElectronService);

  /** Active conversation (maps to Python ``session_id`` for LSP). */
  readonly conversationId = input<string | null>(null);
  /** When set, status reflects the integrated LSP for this path (``.py`` / TS/JS). */
  readonly activeFileRelativePath = input<string | null>(null);

  protected readonly dashboard = signal<LspDashboardStatus | null>(null);
  protected readonly fetchError = signal('');
  protected readonly loading = signal(false);

  constructor() {
    effect((onCleanup) => {
      const conv = this.conversationId();
      if (!this.electron.isElectron || !conv?.trim()) {
        this.dashboard.set(null);
        this.fetchError.set('');
        return;
      }
      void this.refreshDashboard();
      const timer = window.setInterval(() => void this.refreshDashboard(), 5000);
      onCleanup(() => clearInterval(timer));
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
      untracked(async () => {
        const w = await this.electron.warmLspForActiveFile(conv, posix);
        if (w.ok) {
          await this.refreshDashboard();
        }
      });
    });
  }

  private async refreshDashboard(): Promise<void> {
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
  }

  /** Single-line indicator + tooltip for tab strip. */
  protected readonly vm = computed(() => {
    const path = this.activeFileRelativePath();
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
      const py = d.servers.python.initialized;
      const ts = d.servers.typescript.initialized;
      const n = d.cachedDiagnostics ?? 0;
      const hints = dependencyDocHints(d);
      const baseTitle = `Workspace · Python ${py ? 'running' : 'stopped'} · TypeScript/JS ${ts ? 'running' : 'stopped'} · ${n} diagnostic(s) cached`;
      return {
        text: `LSP · Py ${py ? '●' : '○'} · TS ${ts ? '●' : '○'}`,
        tone: 'muted' as const,
        title: hints ? `${baseTitle}\n\n${hints}` : baseTitle,
      };
    }

    const kind = lspServerKindForWorkspaceRelativePath(path);
    const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    if (!kind) {
      return {
        text: `No LSP · ${base}`,
        tone: 'muted' as const,
        title: 'Integrated LSP is only available for Python and TypeScript/JavaScript files.',
      };
    }

    const running = kind === 'python' ? d.servers.python.initialized : d.servers.typescript.initialized;
    const name = kind === 'python' ? 'Python' : 'TS/JS';
    const hints = dependencyDocHints(d);
    const baseTitle = `${name} language server · ${running ? 'subprocess connected' : 'not running'}`;
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

function dependencyDocHints(status: LspDashboardStatus): string {
  const lines: string[] = [];
  const pyEnv = status.pythonEnvironmentPath;
  const pyExe = status.pythonInterpreterPath;
  const nm = status.nodeModulesPresent;

  if (pyEnv !== undefined && pyEnv !== null && pyEnv !== '') {
    lines.push(`Python env (hover/docs): ${pyEnv}`);
  } else if (pyEnv !== undefined) {
    lines.push('Python env: not set — library hovers work best after the workspace venv is detected.');
  }

  if (pyExe !== undefined && pyExe !== null && pyExe !== '') {
    lines.push(`Python interpreter: ${pyExe}`);
  }

  if (nm === false) {
    lines.push('node_modules: missing — install deps for TypeScript/JavaScript API hovers.');
  } else if (nm === true) {
    lines.push('node_modules: present');
  }

  return lines.join('\n');
}
