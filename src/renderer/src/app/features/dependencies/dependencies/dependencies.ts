import {
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
  effect,
  untracked,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type {
  AppConfig,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
} from '@shared/index';
import { THEMES } from '../../layout/theme-selector/theme-selector';
import { resolveAppThemeId, applyAppFontOverrides } from '../../shell/app-theme';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-dependencies',
  imports: [NgxSpinnerComponent],
  templateUrl: './dependencies.html',
  styleUrl: './dependencies.css',
})
export class Dependencies implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);

  protected readonly listSpinnerName = 'deps-list-spinner';
  protected readonly listSpinnerType = 'ball-scale-multiple';

  protected readonly dependencies = signal<DependencyInfo[]>([]);
  protected readonly listLoading = signal(true);
  protected readonly statusMessage = signal('');
  protected readonly busyIds = signal<Set<DependencyId>>(new Set());
  protected readonly progressById = signal<Partial<Record<DependencyId, DependencyProgressEvent>>>({});

  private configSub: { unsubscribe(): void } | null = null;
  private offProgress: (() => void) | null = null;

  constructor() {
    effect(() => {
      const loading = this.listLoading();
      untracked(() => this.scheduleNamedSpinnerSync(this.listSpinnerName, loading));
    });
  }

  async ngOnInit(): Promise<void> {
    const cfg = await this.electron.loadConfig();
    this.applyTheme(cfg);
    this.configSub = this.electron.config$.subscribe((c: AppConfig) => this.applyTheme(c));
    this.offProgress = this.electron.onDepsProgress((ev) => this.onProgress(ev));
    await this.refreshList();
  }

  ngOnDestroy(): void {
    this.configSub?.unsubscribe();
    this.offProgress?.();
    void this.ngxSpinner.hide(this.listSpinnerName);
  }

  protected closeWindow(): void {
    this.electron.closeDependenciesWindow();
  }

  protected stateLabel(state: DependencyInfo['state']): string {
    switch (state) {
      case 'installed':
        return 'Installed';
      case 'missing':
        return 'Missing';
      case 'updating':
        return 'Updating';
      case 'error':
        return 'Error';
      default:
        return state;
    }
  }

  protected isBusy(id: DependencyId): boolean {
    return this.busyIds().has(id) || this.dependencies().find((d) => d.id === id)?.state === 'updating';
  }

  protected progressFor(id: DependencyId): DependencyProgressEvent | undefined {
    return this.progressById()[id];
  }

  protected progressPercent(ev: DependencyProgressEvent | undefined): number | null {
    if (!ev?.bytesDone || !ev.bytesTotal || ev.bytesTotal <= 0) return null;
    return Math.min(100, Math.round((ev.bytesDone / ev.bytesTotal) * 100));
  }

  protected formatBytes(n: number | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected async refreshList(): Promise<void> {
    this.listLoading.set(true);
    try {
      const res = await this.electron.depsList();
      if (!res.ok) {
        this.statusMessage.set(res.error || 'Failed to list dependencies.');
        this.dependencies.set([]);
        return;
      }
      this.dependencies.set(res.dependencies ?? []);
      if (res.warning) {
        this.statusMessage.set(res.warning);
      } else if (!res.dependencies?.length) {
        this.statusMessage.set('No dependencies reported.');
      }
    } catch (err) {
      this.statusMessage.set(err instanceof Error ? err.message : String(err));
      this.dependencies.set([]);
    } finally {
      this.listLoading.set(false);
    }
  }

  protected async download(dep: DependencyInfo): Promise<void> {
    await this.runAction(dep.id, () => this.electron.depsInstall(dep.id), 'Downloaded');
  }

  protected async reinstall(dep: DependencyInfo): Promise<void> {
    await this.runAction(dep.id, () => this.electron.depsReinstall(dep.id), 'Reinstalled');
  }

  protected async remove(dep: DependencyInfo): Promise<void> {
    if (!dep.canDelete) return;
    await this.runAction(dep.id, () => this.electron.depsDelete(dep.id), 'Removed');
  }

  private async runAction(
    id: DependencyId,
    action: () => Promise<{ ok: boolean; error?: string }>,
    successVerb: string,
  ): Promise<void> {
    this.busyIds.update((s) => new Set(s).add(id));
    this.statusMessage.set('');
    try {
      const res = await action();
      if (!res.ok) {
        this.statusMessage.set(res.error || `${id} failed.`);
      } else {
        this.statusMessage.set(`${successVerb} ${id}.`);
        this.progressById.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
      await this.refreshList();
    } finally {
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  private onProgress(ev: DependencyProgressEvent): void {
    this.progressById.update((m) => ({ ...m, [ev.depId]: ev }));
    if (
      ev.phase === 'queued' ||
      ev.phase === 'downloading' ||
      ev.phase === 'extracting' ||
      ev.phase === 'installing' ||
      ev.phase === 'finishing'
    ) {
      this.busyIds.update((s) => new Set(s).add(ev.depId));
    }
    if (ev.phase === 'done' || ev.phase === 'error') {
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(ev.depId);
        return next;
      });
      if (ev.phase === 'error' && ev.message) {
        this.statusMessage.set(ev.message);
      }
      void this.refreshList();
    }
  }

  private applyTheme(config: AppConfig): void {
    const theme = THEMES.find((t) => t.id === resolveAppThemeId(config)) ?? THEMES[0];
    document.documentElement.className = theme.cssClass;
    document.documentElement.setAttribute('data-bs-theme', theme.bsTheme);
    applyAppFontOverrides(config);
  }

  private scheduleNamedSpinnerSync(name: string, show: boolean): void {
    queueMicrotask(() => {
      if (show) void this.ngxSpinner.show(name);
      else void this.ngxSpinner.hide(name);
    });
  }
}
