import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { LspDashboardStatus } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath } from '@shared/index';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import {
  envRelevantWorkspaceChange,
  LSP_ENV_SLOW_POLL_MS,
  LSP_LIFECYCLE_FAST_POLL_MS,
  needsEnvPoll,
  needsLifecyclePoll,
} from './lsp-env-poll-policy';
import { buildLspStatusBarVm } from './lsp-status-bar-vm';

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
  /** Workspace root for the active chat; empty means LSP is not applicable. */
  readonly workspacePath = input<string | null>(null);
  /** When set, warms the integrated LSP for this path (``.py`` / TS/JS / ``.gd`` / ``.java``). */
  readonly activeFileRelativePath = input<string | null>(null);
  /** Skip disk warm when the Monaco buffer has unsaved edits (do not overwrite the live buffer). */
  readonly activeFileDirty = input(false);

  protected readonly dashboard = signal<LspDashboardStatus | null>(null);
  protected readonly fetchError = signal('');
  protected readonly loading = signal(false);
  /** Server id currently being warmed so the bar can show ``starting`` before the first poll. */
  protected readonly warmingServerId = signal<string | null>(null);

  /**
   * Serialized dashboard fetches: callers chain so a refresh after ``warmLspForActiveFile``
   * still runs (it is not dropped after awaiting an older in-flight fetch).
   */
  private dashboardRefreshChain: Promise<void> = Promise.resolve();

  /** Dedupe ``warmLspForActiveFile`` when the same conversation + path effect re-runs. */
  private lastWarmConversationPath = '';

  private workspaceFilesChangedSubscription: Subscription | null = null;
  private workspaceChangedSubscription: Subscription | null = null;

  constructor() {
    effect(() => {
      const conv = this.conversationId();
      if (!this.electron.isElectron || !conv?.trim() || !this.hasWorkspace()) {
        this.dashboard.set(null);
        this.fetchError.set('');
        this.lastWarmConversationPath = '';
        this.warmingServerId.set(null);
        return;
      }
      void this.refreshDashboard();
    });

    effect((onCleanup) => {
      const conv = this.conversationId()?.trim();
      const path = this.activeFileRelativePath()?.trim().replace(/\\/g, '/') ?? null;
      const dash = this.dashboard();
      const warming = Boolean(this.warmingServerId());
      if (!this.electron.isElectron || !conv || !this.hasWorkspace()) {
        return;
      }
      const envPoll = needsEnvPoll(dash, path);
      const lifecyclePoll = needsLifecyclePoll(dash) || warming;
      if (!envPoll && !lifecyclePoll) {
        return;
      }
      const intervalMs = lifecyclePoll ? LSP_LIFECYCLE_FAST_POLL_MS : LSP_ENV_SLOW_POLL_MS;
      if (warming || needsLifecyclePoll(dash)) {
        void this.refreshDashboard();
      }
      const pollTimer = window.setInterval(() => {
        const activePath = this.activeFileRelativePath()?.trim().replace(/\\/g, '/') ?? null;
        if (
          !needsEnvPoll(this.dashboard(), activePath) &&
          !needsLifecyclePoll(this.dashboard()) &&
          !this.warmingServerId()
        ) {
          return;
        }
        void this.refreshDashboard();
      }, intervalMs);
      onCleanup(() => clearInterval(pollTimer));
    });

    this.workspaceFilesChangedSubscription = this.electron.workspaceFilesChanged$.subscribe((event) => {
      if (!this.hasWorkspace() || !envRelevantWorkspaceChange(event.paths)) {
        return;
      }
      void this.refreshDashboard();
    });

    this.workspaceChangedSubscription = this.electron.workspaceChanged$.subscribe(() => {
      this.lastWarmConversationPath = '';
      this.warmingServerId.set(null);
      if (!this.hasWorkspace()) {
        this.dashboard.set(null);
        this.fetchError.set('');
        return;
      }
      void this.refreshDashboard();
    });

    /** Start LSP / didOpen current file from disk so dashboard shows a live subprocess. */
    effect(() => {
      const conv = this.conversationId()?.trim();
      const path = this.activeFileRelativePath()?.trim();
      if (!this.electron.isElectron || !conv || !path || !this.hasWorkspace()) {
        this.warmingServerId.set(null);
        return;
      }
      const posix = path.replace(/\\/g, '/');
      const kind = lspServerKindForWorkspaceRelativePath(posix);
      if (!kind) {
        this.warmingServerId.set(null);
        return;
      }
      if (this.activeFileDirty()) {
        this.warmingServerId.set(null);
        return;
      }
      const warmKey = `${conv}|${posix}`;
      if (this.lastWarmConversationPath === warmKey) {
        return;
      }
      this.lastWarmConversationPath = warmKey;
      this.warmingServerId.set(kind);
      untracked(async () => {
        try {
          await this.electron.warmLspForActiveFile(conv, posix);
        } finally {
          if (this.lastWarmConversationPath === warmKey) {
            this.warmingServerId.set(null);
          }
          await this.refreshDashboard();
        }
      });
    });
  }

  private hasWorkspace(): boolean {
    return Boolean(this.workspacePath()?.trim());
  }

  private refreshDashboard(): Promise<void> {
    const next = this.dashboardRefreshChain.then(async () => {
      const conv = this.conversationId()?.trim();
      if (!conv || !this.hasWorkspace()) {
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

  protected readonly vm = computed(() =>
    buildLspStatusBarVm(
      this.dashboard(),
      this.fetchError(),
      this.loading(),
      this.warmingServerId(),
      this.hasWorkspace(),
    ),
  );
}
