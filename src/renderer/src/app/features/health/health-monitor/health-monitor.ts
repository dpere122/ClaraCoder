import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import type { AppConfig } from '@shared/index';
import { applyAppFontOverrides } from '../../../core/theme/app-font-overrides';
import { ElectronService } from '../../../core/electron.service';
import { HealthLogViewer } from '../health-log-viewer/health-log-viewer';
import { HealthRuntimeStatus } from '../health-runtime-status/health-runtime-status';
import { HealthSystem } from '../health-system/health-system';
import { fmtMb, fmtPercent } from '../shared/health-format';
import { HealthMetricsStore } from '../shared/health-metrics-store';
import { HealthRuntimeStore } from '../shared/health-runtime-store';

export type HealthTab = 'console' | 'runtime' | 'system';

interface StripStat {
  key: string;
  label: string;
  value: string;
}

@Component({
  selector: 'app-health-monitor',
  imports: [LucideAngularModule, HealthLogViewer, HealthRuntimeStatus, HealthSystem],
  providers: [HealthRuntimeStore, HealthMetricsStore],
  templateUrl: './health-monitor.html',
  styleUrls: ['../shared/health-tone.css', './health-monitor.css'],
})
export class HealthMonitor implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  protected readonly runtime = inject(HealthRuntimeStore);
  protected readonly metrics = inject(HealthMetricsStore);
  private configSub: { unsubscribe(): void } | null = null;

  protected readonly tabs: ReadonlyArray<{ id: HealthTab; label: string; icon: string }> = [
    { id: 'console', label: 'Console', icon: 'square-terminal' },
    { id: 'runtime', label: 'Runtime', icon: 'server' },
    { id: 'system', label: 'System', icon: 'activity' },
  ];

  protected readonly activeTab = signal<HealthTab>('console');

  /** Compact live numbers for the console strip (first GPU only; System tab lists all). */
  protected readonly stripStats = computed<StripStat[]>(() => {
    const s = this.metrics.latest();
    if (!s) return [];
    const out: StripStat[] = [
      { key: 'cpu', label: 'CPU', value: fmtPercent(s.cpuLoadPercent) },
      { key: 'mem', label: 'MEM', value: fmtPercent(s.memoryUsedPercent) },
    ];
    const gpu = s.gpus[0];
    if (gpu?.utilPercent != null) out.push({ key: 'gpu', label: 'GPU', value: fmtPercent(gpu.utilPercent) });
    if (gpu?.memoryUsedMb != null) out.push({ key: 'vram', label: 'VRAM', value: fmtMb(gpu.memoryUsedMb) });
    return out;
  });

  async ngOnInit(): Promise<void> {
    applyAppFontOverrides(await this.electron.loadConfig());
    this.configSub = this.electron.config$.subscribe((c: AppConfig) => applyAppFontOverrides(c));
  }

  ngOnDestroy(): void {
    this.configSub?.unsubscribe();
  }

  protected selectTab(tab: HealthTab): void {
    this.activeTab.set(tab);
  }

  /** Roving arrow-key navigation across the tab list (WAI-ARIA tabs pattern). */
  protected onTabKeydown(event: KeyboardEvent): void {
    const order = this.tabs.map((t) => t.id);
    const i = order.indexOf(this.activeTab());
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else return;
    event.preventDefault();
    this.activeTab.set(order[next]!);
    const list = event.currentTarget as HTMLElement;
    list.querySelector<HTMLElement>(`[data-tab="${order[next]}"]`)?.focus();
  }

  protected closeWindow(): void {
    this.electron.closeHealthWindow();
  }
}
