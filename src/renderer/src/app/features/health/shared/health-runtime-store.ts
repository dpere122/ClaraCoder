import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ElectronService } from '../../../core/electron.service';
import { buildRuntimeChips, runtimeVerdict, type RuntimeChip } from './health-runtime';

const POLL_MS = 4000;

/**
 * Polls the aggregated runtime snapshot for the Health window. Provided by `HealthMonitor` so
 * the header verdict, the console status strip, and the Runtime tab share one poll loop.
 */
@Injectable()
export class HealthRuntimeStore {
  private readonly electron = inject(ElectronService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private depsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  readonly chips = signal<RuntimeChip[]>([]);
  readonly stale = signal(false);
  readonly loaded = signal(false);
  readonly verdict = computed(() => runtimeVerdict(this.chips(), this.stale(), this.loaded()));

  private readonly visibilityHandler = (): void => {
    if (document.hidden) {
      this.stopPolling();
    } else {
      this.startPolling();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.startPolling();
    const offProgress = this.electron.onDepsProgress(() => this.scheduleDepsRefresh());
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.stopPolling();
      if (this.depsRefreshTimer) clearTimeout(this.depsRefreshTimer);
      offProgress();
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Debounce deps-progress bursts (downloads emit many events); skip while hidden, the visibility handler refreshes on show. */
  private scheduleDepsRefresh(): void {
    if (this.depsRefreshTimer) return;
    this.depsRefreshTimer = setTimeout(() => {
      this.depsRefreshTimer = null;
      if (!document.hidden) void this.refresh();
    }, 400);
  }

  private async refresh(): Promise<void> {
    const snap = await this.electron.healthRuntimeSnapshot();
    this.loaded.set(true);
    if (!snap) {
      this.stale.set(true);
      this.chips.set([
        { key: 'python', label: 'Python', detail: 'unavailable', hint: 'unavailable', tone: 'muted' },
      ]);
      return;
    }
    this.stale.set(false);
    this.chips.set(buildRuntimeChips(snap));
  }
}
