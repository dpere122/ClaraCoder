import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { AppConfig, HealthMetricsSnapshot } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

/** Samples kept per metric (1 s poll → ~1 minute of history). */
export const HEALTH_METRIC_POINTS = 60;

export type HealthMetricKey = 'cpu' | 'mem' | 'netRx' | 'netTx' | 'diskR' | 'diskW';

export type HealthMetricHistory = Record<HealthMetricKey, number[]>;

function emptyHistory(): HealthMetricHistory {
  return { cpu: [], mem: [], netRx: [], netTx: [], diskR: [], diskW: [] };
}

function append(series: number[], v: number): number[] {
  const next = series.length >= HEALTH_METRIC_POINTS ? series.slice(1) : series.slice();
  next.push(v);
  return next;
}

/**
 * Live system metrics for the Health window. Polls once a second while `healthMonitor.metricsEnabled`
 * is on and the window is visible; keeps a short history so the System tab can be opened at any
 * time without losing the trend.
 */
@Injectable()
export class HealthMetricsStore {
  private readonly electron = inject(ElectronService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly enabled = signal(false);
  readonly latest = signal<HealthMetricsSnapshot | null>(null);
  readonly history = signal<HealthMetricHistory>(emptyHistory());
  readonly gpus = computed(() => this.latest()?.gpus ?? []);

  private readonly visibilityHandler = (): void => {
    if (document.hidden) this.stopPolling();
    else if (this.enabled()) this.startPolling();
  };

  constructor() {
    document.addEventListener('visibilitychange', this.visibilityHandler);
    void this.electron.loadConfig().then((cfg) => this.sync(cfg.healthMonitor.metricsEnabled));
    const sub = this.electron.config$.subscribe((c: AppConfig) => this.sync(c.healthMonitor.metricsEnabled));
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.stopPolling();
      sub.unsubscribe();
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.sync(enabled);
    await this.electron.patchHealthMonitor({ metricsEnabled: enabled });
  }

  private sync(enabled: boolean): void {
    if (this.enabled() === enabled) return;
    this.enabled.set(enabled);
    if (enabled) {
      if (!document.hidden) this.startPolling();
      return;
    }
    this.stopPolling();
    this.latest.set(null);
    this.history.set(emptyHistory());
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled()) return;
    const s = await this.electron.healthMetrics();
    if (!s || !this.enabled()) return;
    this.latest.set(s);
    this.history.update((h) => ({
      cpu: append(h.cpu, s.cpuLoadPercent),
      mem: append(h.mem, s.memoryUsedPercent),
      netRx: append(h.netRx, s.networkRxBps),
      netTx: append(h.netTx, s.networkTxBps),
      diskR: append(h.diskR, s.diskReadBps),
      diskW: append(h.diskW, s.diskWriteBps),
    }));
  }
}
