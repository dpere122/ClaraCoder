import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import Chart from 'chart.js/auto';
import type { AppConfig, HealthMetricsSnapshot } from '@shared/index';
import { THEMES } from '../../layout/theme-selector/theme-selector';
import { ElectronService } from '../../../core/electron.service';
import { HealthLogViewer } from '../health-log-viewer/health-log-viewer';
import { HealthMetricsToggle } from '../health-metrics-toggle/health-metrics-toggle';

const MAX_POINTS = 36;

type ChartKey = 'mem' | 'cpu' | 'netRx' | 'netTx' | 'diskR' | 'diskW';

/** Parse theme `--t-primary` (hex or rgb) for Chart.js dataset colors. */
function cssColorToRgba(color: string, alpha: number): string {
  const c = color.trim();
  if (!c) return `rgba(0, 255, 65, ${alpha})`;
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const full =
      hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex.length === 6 ? hex : '';
    if (full.length !== 6) return `rgba(0, 255, 65, ${alpha})`;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(c);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return `rgba(0, 255, 65, ${alpha})`;
}

@Component({
  selector: 'app-health-monitor',
  imports: [HealthLogViewer, HealthMetricsToggle],
  templateUrl: './health-monitor.html',
  styleUrl: './health-monitor.css',
})
export class HealthMonitor implements OnInit, AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly electron = inject(ElectronService);

  private charts = new Map<ChartKey, InstanceType<typeof Chart>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private configSub: { unsubscribe(): void } | null = null;
  private viewInitialized = false;

  protected readonly gpuSummary = signal<string>('GPU: collecting…');
  protected readonly metricsEnabled = signal(false);

  protected readonly chartDefs: Array<{ key: ChartKey; label: string; suffix: string; yMax?: number }> = [
    { key: 'mem', label: 'Memory', suffix: '%', yMax: 100 },
    { key: 'cpu', label: 'CPU', suffix: '%', yMax: 100 },
    { key: 'netRx', label: 'Network in', suffix: 'B/s' },
    { key: 'netTx', label: 'Network out', suffix: 'B/s' },
    { key: 'diskR', label: 'Disk read', suffix: 'B/s' },
    { key: 'diskW', label: 'Disk write', suffix: 'B/s' },
  ];

  protected readonly lastValues = signal<Record<string, string>>({});

  /** When true, charts are hidden so the log uses the full window height. */
  protected readonly logExpanded = signal(false);

  protected toggleLogExpanded(): void {
    this.logExpanded.update((v) => !v);
  }

  async ngOnInit(): Promise<void> {
    const cfg = await this.electron.loadConfig();
    this.syncFromConfig(cfg);
    this.configSub = this.electron.config$.subscribe((c: AppConfig) => this.syncFromConfig(c));
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    if (this.metricsEnabled()) {
      this.enableMetrics();
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.configSub?.unsubscribe();
    this.destroyCharts();
  }

  protected closeWindow(): void {
    this.electron.closeHealthWindow();
  }

  protected async onMetricsToggle(enabled: boolean): Promise<void> {
    this.syncMetricsEnabled(enabled);
    await this.electron.patchHealthMonitor({ metricsEnabled: enabled });
  }

  /** Match main app: workspace theme, else no-workspace theme, else dark. */
  private resolveThemeId(config: AppConfig): string {
    const workspace = config.currentWorkspaceId
      ? (config.workspaces.find((w) => w.id === config.currentWorkspaceId) ?? null)
      : null;
    return workspace?.themeId || config.noWorkspaceThemeId || 'dark';
  }

  private applyTheme(config: AppConfig): void {
    const theme = THEMES.find((t) => t.id === this.resolveThemeId(config));
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }

  private readThemePrimary(): string {
    return getComputedStyle(document.documentElement).getPropertyValue('--t-primary').trim();
  }

  private refreshChartColors(): void {
    if (this.charts.size === 0) return;
    const primary = this.readThemePrimary();
    const border = cssColorToRgba(primary, 0.88);
    const fill = cssColorToRgba(primary, 0.14);
    for (const chart of this.charts.values()) {
      const ds = chart.data.datasets[0];
      ds.borderColor = border;
      ds.backgroundColor = fill;
      chart.update('none');
    }
  }

  private syncFromConfig(config: AppConfig): void {
    this.applyTheme(config);
    this.syncMetricsEnabled(config.healthMonitor.metricsEnabled);
    this.refreshChartColors();
  }

  private syncMetricsEnabled(enabled: boolean): void {
    if (this.metricsEnabled() === enabled) return;
    this.metricsEnabled.set(enabled);
    if (!this.viewInitialized) return;
    if (enabled) {
      setTimeout(() => {
        if (this.metricsEnabled()) this.enableMetrics();
      }, 0);
      return;
    }
    this.disableMetrics();
  }

  private enableMetrics(): void {
    if (this.pollTimer) return;
    this.initCharts();
    this.pollTimer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  private disableMetrics(): void {
    this.stopPolling();
    this.destroyCharts();
    this.lastValues.set({});
    this.gpuSummary.set('GPU: monitoring paused');
  }

  private initCharts(): void {
    if (this.charts.size > 0) return;
    const primary = this.readThemePrimary();
    const border = cssColorToRgba(primary, 0.88);
    const fill = cssColorToRgba(primary, 0.14);
    const root = this.host.nativeElement;
    for (const def of this.chartDefs) {
      const canvas = root.querySelector(`canvas[data-key="${def.key}"]`) as HTMLCanvasElement | null;
      if (!canvas) continue;
      const chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              data: [] as number[],
              borderColor: border,
              backgroundColor: fill,
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.5,
            },
          ],
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { display: false },
            y: {
              beginAtZero: true,
              suggestedMax: def.yMax,
              ticks: { maxTicksLimit: 4, color: 'var(--t-text-muted)' },
              grid: { color: 'color-mix(in srgb, var(--t-border) 50%, transparent)' },
            },
          },
        },
      });
      this.charts.set(def.key, chart);
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private destroyCharts(): void {
    for (const c of this.charts.values()) {
      c.destroy();
    }
    this.charts.clear();
  }

  private pushPoint(chart: InstanceType<typeof Chart>, y: number): void {
    const ds = chart.data.datasets[0].data as number[];
    ds.push(y);
    if (ds.length > MAX_POINTS) ds.shift();
    chart.data.labels = ds.map(() => '');
    chart.update('none');
  }

  private fmtBytesPerSec(v: number): string {
    if (!Number.isFinite(v) || v < 0) return '0 B/s';
    if (v < 1024) return `${v.toFixed(0)} B/s`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
    return `${(v / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  private async tick(): Promise<void> {
    if (!this.metricsEnabled()) return;
    const snap = await this.electron.healthMetrics();
    if (!snap) return;
    this.updateGpu(snap);
    this.pushSnapshot(snap);
  }

  private updateGpu(s: HealthMetricsSnapshot): void {
    const parts: string[] = [];
    if (s.gpuModel) parts.push(s.gpuModel);
    if (s.gpuUtilPercent != null && Number.isFinite(s.gpuUtilPercent)) {
      parts.push(`util ${s.gpuUtilPercent.toFixed(0)}%`);
    }
    if (s.gpuMemoryUsedMb != null && s.gpuMemoryTotalMb != null) {
      parts.push(`VRAM ${s.gpuMemoryUsedMb} / ${s.gpuMemoryTotalMb} MB`);
    } else if (s.gpuMemoryTotalMb != null) {
      parts.push(`VRAM ${s.gpuMemoryTotalMb} MB (reported)`);
    }
    this.gpuSummary.set(parts.length ? parts.join(' · ') : 'GPU: no detailed metrics (OS/driver)');
  }

  private pushSnapshot(s: HealthMetricsSnapshot): void {
    const lv: Record<string, string> = {
      mem: `${s.memoryUsedPercent.toFixed(1)}%`,
      cpu: `${s.cpuLoadPercent.toFixed(1)}%`,
      netRx: this.fmtBytesPerSec(s.networkRxBps),
      netTx: this.fmtBytesPerSec(s.networkTxBps),
      diskR: this.fmtBytesPerSec(s.diskReadBps),
      diskW: this.fmtBytesPerSec(s.diskWriteBps),
    };
    this.lastValues.set(lv);

    const m = this.charts.get('mem');
    const c = this.charts.get('cpu');
    const nr = this.charts.get('netRx');
    const nt = this.charts.get('netTx');
    const dr = this.charts.get('diskR');
    const dw = this.charts.get('diskW');
    if (m) this.pushPoint(m, s.memoryUsedPercent);
    if (c) this.pushPoint(c, s.cpuLoadPercent);
    if (nr) this.pushPoint(nr, s.networkRxBps);
    if (nt) this.pushPoint(nt, s.networkTxBps);
    if (dr) this.pushPoint(dr, s.diskReadBps);
    if (dw) this.pushPoint(dw, s.diskWriteBps);
  }
}
